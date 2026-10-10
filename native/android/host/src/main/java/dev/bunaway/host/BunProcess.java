package dev.bunaway.host;

import static dev.bunaway.host.Protocol.*;
import static dev.bunaway.host.ProtocolLimits.*;

import android.os.Handler;
import android.os.Looper;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * Owns one Bun generation, bounded pipe writes, negotiation and actual process shutdown.
 *
 * <p>Bun runs as a child process from the installer-extracted {@code libbun.so} and talks
 * newline-delimited JSON frames over stdin and stdout. Lifecycle state and callbacks are confined
 * to the main thread; the pipes are served by the {@code io} and {@code writer} executors. Once
 * {@link #close} or a failure starts shutdown, this instance cannot be restarted.
 */
final class BunProcess {
    /** One thread each for the frame reader, the stderr drain and the exit observer. */
    private static final int IO_THREADS = 3;

    final AppAssets assets;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(IO_THREADS);
    // Cleanup must not queue behind blocked pipe readers, or block the Activity's main thread.
    private final ScheduledExecutorService cleanup = Executors.newSingleThreadScheduledExecutor();
    // A single writer keeps frames ordered; its bounded queue applies backpressure.
    private final ThreadPoolExecutor writer =
            new ThreadPoolExecutor(
                    1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(MAX_PENDING));
    // Every frame carries this identity so frames from another generation are rejected.
    private final JsonObject runtime =
            object("id", UUID.randomUUID().toString(), "generation", UUID.randomUUID().toString());
    private final JsonObject version = object("major", 1, "minor", 0);
    private final JsonObject hello =
            object(
                    "kind",
                    "hello",
                    "protocol",
                    version,
                    "features",
                    new JsonArray(),
                    "buildId",
                    "bunaway-android");
    // Orders process creation against close so a closing owner never starts a child.
    private final Object lock = new Object();
    private volatile Process process;
    private volatile ProcessGroup processGroup;
    private volatile boolean closing;
    private boolean ready;
    private boolean helloSeen;
    private Long runtimePid;
    private String failure;
    private Runnable onReady;
    private BiConsumer<String, JsonObject> onMessage;
    private Consumer<String> onFailure;

    BunProcess(AppAssets assets) {
        this.assets = assets;
    }

    /**
     * Starts Bun in the background and sends the boot frame.
     *
     * <p>The handshake must reach the ready frame within {@code HANDSHAKE_TIMEOUT_MS}. Startup,
     * pipe and protocol errors are reported once through the attached failure callback.
     */
    void start() {
        main.postDelayed(
                () -> {
                    if (!ready && !closing) fail("Backend startup timed out");
                },
                HANDSHAKE_TIMEOUT_MS);
        io.execute(
                () -> {
                    try {
                        File directory = assets.prepareBackend();
                        File runtimeFile =
                                new File(
                                        assets.context.getApplicationInfo().nativeLibraryDir,
                                        "libbun.so");
                        ProcessGroup owner;
                        synchronized (lock) {
                            if (closing) return;
                            Map<String, String> environment = new HashMap<>();
                            // Android has no /tmp. Give Bun's OS APIs app-owned writable
                            // directories.
                            environment.put(
                                    "TMPDIR", assets.context.getCacheDir().getAbsolutePath());
                            environment.put("HOME", assets.context.getFilesDir().getAbsolutePath());
                            owner =
                                    new ProcessGroup(
                                            Arrays.asList("/system/bin/toybox", "setsid"),
                                            "/system/bin/sh",
                                            Arrays.asList(
                                                    runtimeFile.getPath(),
                                                    "--no-env-file",
                                                    "--no-install",
                                                    "--config="
                                                            + new File(directory, "bunfig.toml"),
                                                    "--tsconfig-override="
                                                            + new File(directory, "tsconfig.json"),
                                                    new File(directory, "backend.js").getPath()),
                                            directory,
                                            environment,
                                            android.os.Process.myPid(),
                                            BunProcess::killProcessGroup,
                                            SHUTDOWN_TIMEOUT_MS);
                            processGroup = owner;
                            process = owner.process;
                        }
                        owner.prepare();
                        synchronized (lock) {
                            if (closing) return;
                            owner.begin();
                        }
                        Process child = owner.process;
                        Log.i("BunawayHost", "Bun started");
                        io.execute(() -> drainDiagnostics(child));
                        io.execute(() -> observeExit(child));
                        send(
                                "boot",
                                "payload",
                                object(
                                        "entrypoint",
                                        new File(directory, "backend.js").getPath(),
                                        "buildId",
                                        "bunaway-android",
                                        "policy",
                                        assets.policy,
                                        "backendContext",
                                        "backend-" + UUID.randomUUID()));
                        // This thread stays on stdout until EOF or the first invalid frame.
                        readFrames(child);
                    } catch (Exception error) {
                        Log.e("BunawayHost", "Backend failure", error);
                        main.post(
                                () -> {
                                    if (!closing) fail("Backend connection failed");
                                });
                    }
                });
    }

    /** Forwards Bun stderr to logcat so a full pipe cannot block the backend. */
    private void drainDiagnostics(Process child) {
        // Drain separately, keeping chunks bounded even without newlines.
        try (InputStream input = child.getErrorStream()) {
            byte[] bytes = new byte[4096];
            int length;
            while ((length = input.read(bytes)) != -1) {
                Log.e("BunawayBackend", new String(bytes, 0, length, StandardCharsets.UTF_8));
            }
        } catch (Exception error) {
            Log.e("BunawayHost", "Backend diagnostic stream failed", error);
            main.post(
                    () -> {
                        if (!closing) fail("Backend connection failed");
                    });
        }
    }

    /**
     * Waits for the child to exit, reports an exit that was not requested and releases the
     * executors.
     */
    private void observeExit(Process child) {
        try {
            int exit = child.waitFor();
            Log.i("BunawayHost", "Bun exited pid=" + runtimePid + " code=" + exit);
            main.post(
                    () -> {
                        if (!closing) fail("Backend exited unexpectedly");
                    });
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            main.post(
                    () -> {
                        if (!closing) fail("Backend exit observation interrupted");
                    });
        } finally {
            finishProcess();
        }
    }

    /**
     * Splits stdout into newline-delimited frames, validates each one and dispatches it on the main
     * thread.
     *
     * @throws Exception when a frame is oversized, not valid UTF-8 or JSON, fails the schema,
     *     belongs to another runtime, cannot be dispatched in time, or stdout ends before shutdown
     */
    private void readFrames(Process child) throws Exception {
        try (InputStream input = child.getInputStream()) {
            FrameReader reader = new FrameReader(input);
            String text;
            while ((text = reader.read()) != null) {
                JsonObject frame = assets.processProtocol.parse(text);
                require(frame.get("runtime").equals(runtime), "Stale runtime frame");
                // Await dispatch so a producer cannot accumulate an unbounded UI queue.
                CountDownLatch dispatched = new CountDownLatch(1);
                main.post(
                        () -> {
                            try {
                                receive(frame);
                            } catch (Exception error) {
                                Log.e("BunawayHost", "Invalid backend frame", error);
                                fail("Invalid backend message");
                            } finally {
                                dispatched.countDown();
                            }
                        });
                require(
                        dispatched.await(HANDSHAKE_TIMEOUT_MS, TimeUnit.MILLISECONDS),
                        "UI dispatch timed out");
            }
            require(closing, "Unexpected backend EOF");
        }
    }

    /**
     * Applies one validated backend frame on the main thread.
     *
     * <p>The handshake must be backend hello, host hello, then ready. Web frames are delivered only
     * after ready. Host operation requests are answered with {@code UNSUPPORTED} because Android
     * native plugins are not implemented.
     *
     * @throws IllegalArgumentException when the frame is out of order or uses a host-only direction
     */
    private void receive(JsonObject frame) {
        if (closing) return;
        switch (text(frame, "kind")) {
            case "hello":
                require(
                        !helloSeen
                                && frame.getAsJsonObject("payload")
                                                .getAsJsonObject("protocol")
                                                .get("major")
                                                .getAsDouble()
                                        == 1,
                        "Invalid backend hello");
                helloSeen = true;
                send("hello", "payload", hello);
                break;
            case "ready":
                require(
                        helloSeen && !ready && text(frame, "bunVersion").equals(assets.bunVersion),
                        "Invalid backend ready");
                runtimePid = frame.get("pid").getAsLong();
                // A backend reporting the app's own PID was not started as the child process.
                require(
                        runtimePid != android.os.Process.myPid(),
                        "Backend must be a child process");
                Log.i("BunawayHost", "Bun ready pid=" + runtimePid);
                ready = true;
                if (onReady != null) onReady.run();
                break;
            case "web":
                require(ready, "Backend not ready");
                if (onMessage != null) {
                    onMessage.accept(text(frame, "context"), frame.getAsJsonObject("payload"));
                }
                break;
            case "host-request":
                send(
                        "host-response",
                        "context",
                        frame.get("context"),
                        "requestId",
                        frame.get("requestId"),
                        "payload",
                        object(
                                "kind",
                                "error",
                                "error",
                                object(
                                        "code",
                                        "UNSUPPORTED",
                                        "message",
                                        "Android native plugins are not implemented.")));
                break;
            case "host-cancel":
                break; // No native operation can be pending in this implementation.
            case "fatal":
                fail("Backend reported a fatal error");
                break;
            default:
                throw new IllegalArgumentException("Unexpected backend direction");
        }
    }

    /**
     * Validates and queues one frame for Bun stdin.
     *
     * <p>{@code fields} are alternating names and values as accepted by {@link Protocol#object};
     * the IPC version, runtime identity and kind are added here. A full queue or write error fails
     * this generation unless it is already closing.
     *
     * @throws IllegalArgumentException when the frame violates the process schema or size limit
     */
    void send(String kind, Object... fields) {
        JsonObject frame = object(fields);
        frame.add("ipc", version);
        frame.add("runtime", runtime);
        frame.addProperty("kind", kind);
        String text = assets.processProtocol.encode(frame) + "\n";
        try {
            writer.execute(
                    () -> {
                        try {
                            Process child = process;
                            if (child == null) {
                                throw new IllegalStateException("Backend not started");
                            }
                            OutputStream output = child.getOutputStream();
                            output.write(text.getBytes(StandardCharsets.UTF_8));
                            output.flush();
                        } catch (Exception error) {
                            main.post(
                                    () -> {
                                        if (!closing) fail("Backend write failed");
                                    });
                        }
                    });
        } catch (RejectedExecutionException error) {
            if (!closing) fail("Backend queue full");
        }
    }

    /**
     * Connects the current Activity's callbacks on the main thread.
     *
     * <p>{@code ready} runs immediately when the backend is already ready, otherwise after the
     * handshake. A closed backend reports {@code failed} immediately and keeps no callbacks.
     */
    void attach(Runnable ready, BiConsumer<String, JsonObject> message, Consumer<String> failed) {
        // A renderer failure can close a ready generation before Activity recreation.
        if (closing) {
            failed.accept(failure == null ? "Backend is closed. Reopen the app." : failure);
            return;
        }
        onReady = ready;
        onMessage = message;
        onFailure = failed;
        if (this.ready) ready.run();
    }

    /** Drops Activity callbacks so a destroyed Activity is not retained or called. */
    void detach() {
        onReady = null;
        onMessage = null;
        onFailure = null;
    }

    /**
     * Starts shutdown once: requests a graceful exit, then forcibly terminates the child and stops
     * the executors after {@code SHUTDOWN_TIMEOUT_MS}. Safe to call repeatedly.
     */
    void close() {
        synchronized (lock) {
            if (closing) return;
            closing = true;
            // A saturated writer may reject shutdown; the deadline still owns forced termination.
            if (process != null) send("shutdown");
        }
        detach();
        scheduleCleanup(SHUTDOWN_TIMEOUT_MS);
    }

    /**
     * Sweeps the owned group and closes pipes on a background thread, including after leader exit.
     */
    private void finishProcess() {
        try {
            ProcessGroup owner = processGroup;
            if (owner != null) owner.close();
        } catch (IOException error) {
            Log.e("BunawayHost", "Backend process group cleanup failed", error);
        } finally {
            writer.shutdownNow();
            io.shutdown();
            cleanup.shutdownNow();
        }
    }

    /**
     * Requests cleanup independently of pipe I/O; an exited owner may already have completed it.
     */
    private void scheduleCleanup(long delayMs) {
        try {
            cleanup.schedule(this::finishProcess, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException error) {
            // Only finishProcess shuts this executor down, after releasing the process group.
        }
    }

    /** Signals an isolated backend group, never the Android host or another app. */
    private static void killProcessGroup(int group) throws IOException {
        try {
            Os.kill(-group, OsConstants.SIGKILL);
        } catch (ErrnoException error) {
            if (error.errno != OsConstants.ESRCH) {
                throw new IOException("Cannot terminate backend process group", error);
            }
        }
    }

    /**
     * Records the first failure, terminates the child immediately and reports the message to the
     * attached Activity. Later failures are ignored. Callable from any thread.
     */
    private void fail(String message) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(() -> fail(message));
            return;
        }
        if (closing) return;
        failure = message;
        Consumer<String> reportFailure = onFailure;
        // Mark closed before callbacks can revoke a document or attempt another write.
        close();
        scheduleCleanup(0);
        if (reportFailure != null) reportFailure.accept(message);
    }
}
