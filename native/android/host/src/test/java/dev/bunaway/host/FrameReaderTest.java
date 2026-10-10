package dev.bunaway.host;

import static dev.bunaway.host.ProtocolLimits.MAX_MESSAGE_BYTES;

import static org.junit.Assert.*;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;

/** Exercises pipe fragmentation, coalescing and byte boundaries independently of Android UI. */
public class FrameReaderTest {
    private InputStream chunks(String text, int chunkBytes) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)) {
            @Override
            public synchronized int read(byte[] bytes, int offset, int length) {
                return super.read(bytes, offset, Math.min(length, chunkBytes));
            }
        };
    }

    @Test
    public void preservesCoalescedAndFragmentedFramesIncludingSplitUnicode() throws Exception {
        String large = "가".repeat(45000) + "😀";
        String input = "first\n" + large + "\nlast\n";
        for (int chunkBytes : new int[] {2, 4096}) {
            FrameReader reader = new FrameReader(chunks(input, chunkBytes));
            assertEquals("first", reader.read());
            assertEquals(large, reader.read());
            assertEquals("last", reader.read());
            assertNull(reader.read());
            assertNull(reader.read());
        }
    }

    @Test
    public void enforcesBytesAcrossChunksBeforeAllocatingPastTheLimit() throws Exception {
        String maximum = "x".repeat(MAX_MESSAGE_BYTES);
        FrameReader allowed = new FrameReader(chunks(maximum + "\nnext\n", 4096));
        assertEquals(maximum, allowed.read());
        assertEquals("next", allowed.read());
        assertNull(allowed.read());
        FrameReader oversized = new FrameReader(chunks(maximum + "x\n", 4096));
        assertThrows(IllegalArgumentException.class, oversized::read);
    }

    @Test
    public void rejectsMalformedUtf8AndIncompleteEof() throws Exception {
        FrameReader invalid =
                new FrameReader(new ByteArrayInputStream(new byte[] {(byte) 0xc3, 0x28, '\n'}));
        assertThrows(CharacterCodingException.class, invalid::read);
        FrameReader incomplete = new FrameReader(chunks("complete\npartial", 2));
        assertEquals("complete", incomplete.read());
        assertThrows(IllegalArgumentException.class, incomplete::read);
        FrameReader empty = new FrameReader(chunks("\n", 2));
        assertEquals("", empty.read());
        assertNull(empty.read());
    }
}
