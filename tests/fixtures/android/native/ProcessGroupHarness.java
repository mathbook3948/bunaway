package dev.bunaway.host;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.TimeUnit;

/** Exercises real Linux descendants and inherited pipes without Android or mocked processes. */
public final class ProcessGroupHarness {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static boolean live(int pid) throws IOException {
        Path stat = Path.of("/proc", String.valueOf(pid), "stat");
        try {
            String text = Files.readString(stat);
            char state = text.charAt(text.lastIndexOf(')') + 2);
            return state != 'Z' && state != 'X';
        } catch (NoSuchFileException exited) {
            return false;
        }
    }

    private static void kill(int group) throws IOException {
        Process kill =
                new ProcessBuilder("/bin/kill", "-KILL", "--", "-" + group)
                        .redirectErrorStream(true)
                        .start();
        try {
            String message = new String(kill.getInputStream().readAllBytes());
            int code = kill.waitFor();
            require(
                    code == 0 || message.contains("No such process"),
                    "Group signal failed: " + message);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException(error);
        }
    }

    private static ProcessGroup group(String launcher, String script, Path marker)
            throws IOException {
        return new ProcessGroup(
                Collections.singletonList(launcher),
                "/bin/sh",
                Arrays.asList("/bin/sh", "-c", script, "backend", marker.toString()),
                marker.getParent().toFile(),
                Collections.singletonMap("LC_ALL", "C"),
                Math.toIntExact(ProcessHandle.current().pid()),
                ProcessGroupHarness::kill,
                5000);
    }

    private static void descendants(String launcher, Path root, String mode) throws Exception {
        Path marker = root.resolve(mode + ".pids");
        // Both generations inherit the backend's stdout/stderr, including after a leader exit.
        String script =
                "/bin/sh -c 'sleep 120 & printf \"%s %s\\n"
                    + "\" \"$$\" \"$!\" > \"$1\"; wait' worker \"$1\" & while [ ! -s \"$1\" ]; do"
                    + " sleep 0.01; done; "
                        + (mode.equals("forced")
                                ? "wait"
                                : "exit " + (mode.equals("failed") ? "7" : "0"));
        try (ProcessGroup owner = group(launcher, script, marker)) {
            owner.prepare();
            owner.begin();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!Files.exists(marker) || Files.size(marker) == 0) {
                require(System.nanoTime() < deadline, "Descendants did not start");
                Thread.sleep(10);
            }
            String[] pids = Files.readString(marker).trim().split(" ");
            require(pids.length == 2, "Missing descendant identities");
            int child = Integer.parseInt(pids[0]);
            int grandchild = Integer.parseInt(pids[1]);
            require(live(child) && live(grandchild), "Descendants must be live before cleanup");
            if (!mode.equals("forced")) {
                require(owner.process.waitFor(5, TimeUnit.SECONDS), "Leader did not exit");
                require(
                        owner.process.exitValue() == (mode.equals("failed") ? 7 : 0),
                        "Wrong leader exit");
                require(
                        live(child) && live(grandchild),
                        "Leader exit unexpectedly cleaned descendants");
            }
            owner.close();
            owner.close();
            require(!owner.process.isAlive(), "Backend leader survived");
            require(!live(child) && !live(grandchild), "A descendant survived group cleanup");
            try {
                require(
                        owner.process.getInputStream().read() == -1,
                        "Backend stdout remained open");
            } catch (IOException expected) {
                // The owner explicitly closes pipes after group cleanup.
            }
        }
    }

    public static void main(String[] args) throws Exception {
        String launcher = args[0];
        Path root = Path.of(args[1]);
        Process unrelated = new ProcessBuilder("/bin/sleep", "120").start();
        try {
            Path marker = root.resolve("early-start");
            try (ProcessGroup owner = group(launcher, "printf started > \"$1\"", marker)) {
                Thread.sleep(50);
                require(!Files.exists(marker), "App executed before startup acceptance");
                owner.close();
                require(!Files.exists(marker), "Cancelled startup executed app code");
                require(!owner.process.isAlive(), "Cancelled launcher survived");
            }
            try (ProcessGroup owner = group(launcher, "printf started > \"$1\"", marker)) {
                owner.prepare();
                require(!Files.exists(marker), "Prepared launcher executed app code");
                owner.close();
                try {
                    owner.begin();
                    throw new AssertionError("Closed launcher accepted startup");
                } catch (IOException expected) {
                    require(!Files.exists(marker), "Cancelled preparation executed app code");
                }
            }
            for (String mode : Arrays.asList("graceful", "failed", "forced")) {
                descendants(launcher, root, mode);
                require(unrelated.isAlive(), "Cleanup killed an unrelated process");
            }
            System.out.println(
                    "PASS: gated startup, graceful/failed/forced group cleanup, descendants and"
                            + " pipes");
        } finally {
            unrelated.destroyForcibly();
            unrelated.waitFor();
        }
    }
}
