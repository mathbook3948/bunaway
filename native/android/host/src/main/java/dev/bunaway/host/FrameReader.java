package dev.bunaway.host;

import static dev.bunaway.host.Protocol.require;
import static dev.bunaway.host.ProtocolLimits.MAX_MESSAGE_BYTES;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * Reads bounded, newline-delimited UTF-8 frames without appending individual bytes.
 *
 * <p>The caller owns and closes the stream, and validates the returned JSON before dispatch. Only
 * one frame is buffered; unread bytes of the current chunk remain for the next call.
 */
final class FrameReader {
    private static final int READ_BUFFER_BYTES = 4096;

    private final InputStream input;
    private final byte[] bytes = new byte[READ_BUFFER_BYTES];
    private final ByteArrayOutputStream line = new ByteArrayOutputStream();
    private final CharsetDecoder decoder =
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT);
    private int position;
    private int length;

    FrameReader(InputStream input) {
        this.input = input;
    }

    /**
     * Returns the next frame, or null at a clean EOF.
     *
     * @throws IOException when reading or strict UTF-8 decoding fails
     * @throws IllegalArgumentException when a frame exceeds the shared byte limit or EOF leaves an
     *     incomplete frame
     */
    String read() throws IOException {
        while (true) {
            if (position == length) {
                length = input.read(bytes);
                position = 0;
            }
            if (length == -1) {
                require(line.size() == 0, "Incomplete IPC frame");
                return null;
            }
            int start = position;
            while (position < length && bytes[position] != '\n') position++;
            int count = position - start;
            // Check the bound before a bulk append can allocate an oversized frame.
            require(count <= MAX_MESSAGE_BYTES - line.size(), "IPC frame too large");
            line.write(bytes, start, count);
            if (position < length) {
                position++;
                String text = decoder.decode(ByteBuffer.wrap(line.toByteArray())).toString();
                line.reset();
                return text;
            }
        }
    }
}
