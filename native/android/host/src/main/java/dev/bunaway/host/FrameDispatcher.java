package dev.bunaway.host;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Guards ordered reader-thread delivery with an independent completion deadline. */
final class FrameDispatcher implements AutoCloseable {
    private final ScheduledExecutorService timer;
    private final Runnable failed;
    private final long timeoutNanos;
    private ScheduledFuture<?> timeout;
    private long deadline;
    private boolean delivering;
    private boolean closed;

    /** The runtime owns the timer and calls submit only from its frame reader. */
    FrameDispatcher(ScheduledExecutorService timer, long timeoutMs, Runnable failed) {
        this.timer = timer;
        this.timeoutNanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        this.failed = failed;
    }

    /** Delivers inline without holding the monitor needed by shutdown and the timer. */
    boolean submit(Runnable action) {
        synchronized (this) {
            if (closed) return false;
            Protocol.require(!delivering, "Concurrent frame delivery");
            delivering = true;
            deadline = System.nanoTime() + timeoutNanos;
            try {
                if (timeout == null) scheduleDeadline();
            } catch (RuntimeException error) {
                close();
                throw error;
            }
        }
        try {
            action.run();
            return true;
        } catch (RuntimeException error) {
            close();
            throw error;
        } finally {
            synchronized (this) {
                delivering = false;
            }
        }
    }

    private void scheduleDeadline() {
        timeout =
                timer.schedule(
                        this::expire,
                        Math.max(0, deadline - System.nanoTime()),
                        TimeUnit.NANOSECONDS);
    }

    private void expire() {
        synchronized (this) {
            if (closed) return;
            if (!delivering) {
                timeout = null;
                return;
            }
            // Retain one timer between calls, without shortening a later frame's deadline.
            if (System.nanoTime() - deadline < 0) {
                scheduleDeadline();
                return;
            }
            close();
        }
        failed.run();
    }

    /** Stops future delivery even if WebView currently blocks the reader thread. */
    @Override
    public synchronized void close() {
        closed = true;
        if (timeout != null) timeout.cancel(false);
        timeout = null;
    }
}
