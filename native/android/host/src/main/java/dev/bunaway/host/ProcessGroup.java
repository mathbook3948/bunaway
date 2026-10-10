package dev.bunaway.host;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Owns an isolated Linux process group and its pipes, including descendants after the leader exits.
 * The launcher reports its identity and waits for acceptance before it can execute app code.
 */
final class ProcessGroup implements AutoCloseable {
    // Android's toybox includes setsid from API 29. Positional arguments preserve command paths.
    private static final String LAUNCH_SCRIPT =
            "printf '%s\\n' \"$$\"; "
                    + "IFS= read -r start && [ \"$start\" = start ] || exit 1; "
                    + "exec \"$@\"";
    private static final int MAX_PID_DIGITS = 10;
    private static final long EXIT_POLL_MS = 10;

    /** Signals the already-validated group, tolerating a group that has finished exiting. */
    interface Terminator {
        void kill(int group) throws IOException;
    }

    final Process process;
    private final int ownerPid;
    private final Terminator terminator;
    private final long cleanupTimeoutMs;
    private Integer group;
    private boolean closed;

    /**
     * Starts a gated group; call prepare and begin before writing IPC or reading backend frames.
     */
    ProcessGroup(
            List<String> launcher,
            String shell,
            List<String> command,
            File directory,
            Map<String, String> environment,
            int ownerPid,
            Terminator terminator,
            long cleanupTimeoutMs)
            throws IOException {
        this.ownerPid = ownerPid;
        this.terminator = terminator;
        this.cleanupTimeoutMs = cleanupTimeoutMs;
        List<String> arguments = new ArrayList<>(launcher);
        arguments.add(shell);
        arguments.add("-c");
        arguments.add(LAUNCH_SCRIPT);
        arguments.add("bunaway-backend");
        arguments.addAll(command);
        ProcessBuilder builder = new ProcessBuilder(arguments).directory(directory);
        builder.environment().putAll(environment);
        process = builder.start();
    }

    /**
     * Verifies the child is a new group directly owned by this host without releasing the startup
     * gate. Reads only the short identity line so no backend pipe bytes are consumed or buffered.
     */
    void prepare() throws IOException {
        InputStream input = process.getInputStream();
        StringBuilder identity = new StringBuilder();
        int value;
        while ((value = input.read()) != '\n') {
            if (value < '0' || value > '9' || identity.length() >= MAX_PID_DIGITS) {
                throw new IOException("Invalid backend process group identity");
            }
            identity.append((char) value);
        }
        int pid;
        try {
            pid = Integer.parseInt(identity.toString());
        } catch (NumberFormatException error) {
            throw new IOException("Invalid backend process group identity", error);
        }
        String[] state = processState(new File("/proc/" + pid));
        if (pid <= 0
                || pid == ownerPid
                || Integer.parseInt(state[1]) != ownerPid
                || Integer.parseInt(state[2]) != pid
                || Integer.parseInt(state[3]) != pid) {
            throw new IOException("Backend must own an isolated child process group");
        }
        synchronized (this) {
            if (closed) throw new IOException("Backend process group is closed");
            group = pid;
        }
    }

    /**
     * Releases the validated startup gate; callers can order this short write against cancellation.
     */
    synchronized void begin() throws IOException {
        if (closed || group == null) throw new IOException("Backend process group is not prepared");
        process.getOutputStream().write("start\n".getBytes(StandardCharsets.UTF_8));
        process.getOutputStream().flush();
    }

    /**
     * Kills inherited descendants even after a graceful leader exit, waits for live group members
     * to release their resources and closes every pipe. Must run off the Android main thread.
     */
    @Override
    public synchronized void close() throws IOException {
        if (closed) return;
        closed = true;
        try {
            if (group != null) terminator.kill(group);
        } finally {
            // Before begin there can be no app descendants; the gate prevents app execution.
            process.destroyForcibly();
            try {
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(cleanupTimeoutMs);
                if (!process.waitFor(cleanupTimeoutMs, TimeUnit.MILLISECONDS)) {
                    throw new IOException("Backend process did not finish exiting");
                }
                while (group != null && hasLiveMembers(group)) {
                    if (System.nanoTime() >= deadline) {
                        throw new IOException("Backend descendant cleanup timed out");
                    }
                    terminator.kill(group);
                    Thread.sleep(EXIT_POLL_MS);
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException("Backend cleanup interrupted", error);
            } finally {
                try (InputStream stdout = process.getInputStream();
                        InputStream stderr = process.getErrorStream();
                        OutputStream stdin = process.getOutputStream()) {
                    // Closing the streams also releases readers after an inherited pipe reaches
                    // EOF.
                }
            }
        }
    }

    /** Reads the kernel's state, parent, group and session fields after the executable name. */
    private static String[] processState(File directory) throws IOException {
        try (BufferedReader input =
                new BufferedReader(new FileReader(new File(directory, "stat")))) {
            String stat = input.readLine();
            if (stat == null || stat.lastIndexOf(')') < 0) {
                throw new IOException("Cannot inspect backend process group");
            }
            String[] fields = stat.substring(stat.lastIndexOf(')') + 2).split(" ");
            if (fields.length < 4) throw new IOException("Invalid process group state");
            return fields;
        }
    }

    /** Zombies have released their pipes and memory; their adopter owns reaping. */
    private static boolean hasLiveMembers(int group) throws IOException {
        File[] processes = new File("/proc").listFiles();
        if (processes == null) throw new IOException("Cannot enumerate backend process group");
        for (File directory : processes) {
            if (!directory.getName().matches("[0-9]+")) continue;
            String[] state;
            try {
                state = processState(directory);
            } catch (IOException error) {
                // /proc hides other Android UIDs; exiting processes may also disappear mid-scan.
                continue;
            }
            if (Integer.parseInt(state[2]) == group
                    && !state[0].equals("Z")
                    && !state[0].equals("X")) return true;
        }
        return false;
    }
}
