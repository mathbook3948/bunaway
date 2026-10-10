package dev.bunaway.host;

import static org.junit.Assert.*;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public class FrameDispatcherTest {
    @Test
    public void terminalControlDiscardsRepliesBehindIt() {
        ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1);
        timer.setRemoveOnCancelPolicy(true);
        List<String> received = new ArrayList<>();
        try (FrameDispatcher dispatcher =
                new FrameDispatcher(timer, 5000, () -> fail("Unexpected timeout"))) {
            assertTrue(dispatcher.submit(() -> received.add("before")));
            assertTrue(dispatcher.submit(dispatcher::close));
            assertFalse(dispatcher.submit(() -> received.add("after")));
            assertEquals(List.of("before"), received);
            assertTrue(timer.getQueue().isEmpty());
        } finally {
            timer.shutdownNow();
        }
    }

    @Test
    public void blockedDeliveryCannotBlockItsDeadlineEvenAfterIdle() throws Exception {
        ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1);
        var producer = Executors.newSingleThreadExecutor();
        CountDownLatch idle = new CountDownLatch(1);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch expired = new CountDownLatch(1);
        try (FrameDispatcher dispatcher = new FrameDispatcher(timer, 100, expired::countDown)) {
            dispatcher.submit(() -> {});
            timer.schedule(idle::countDown, 150, TimeUnit.MILLISECONDS);
            assertTrue(idle.await(2, TimeUnit.SECONDS));
            assertEquals(1, expired.getCount());
            var delivery =
                    producer.submit(
                            () ->
                                    dispatcher.submit(
                                            () -> {
                                                entered.countDown();
                                                try {
                                                    release.await();
                                                } catch (InterruptedException error) {
                                                    Thread.currentThread().interrupt();
                                                }
                                            }));
            assertTrue(entered.await(1, TimeUnit.SECONDS));
            assertTrue(expired.await(2, TimeUnit.SECONDS));
            assertFalse(dispatcher.submit(() -> fail("Late reply delivered")));
            release.countDown();
            assertTrue(delivery.get(1, TimeUnit.SECONDS));
        } finally {
            release.countDown();
            producer.shutdownNow();
            timer.shutdownNow();
        }
    }
}
