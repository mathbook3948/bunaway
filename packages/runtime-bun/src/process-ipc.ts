import { MAX_MESSAGE_BYTES } from "@bunaway/protocol";

/**
 * Reads newline-delimited UTF-8 frames.
 * Rejects invalid UTF-8, empty frames, oversized frames, or a final frame without a newline.
 * Leaves JSON validation to the caller.
 */
export async function* readJsonLines(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  let parts: Uint8Array[] = [];
  let size = 0;
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
  });
  for await (const chunk of chunks) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      size += part.length;
      if (size > MAX_MESSAGE_BYTES) {
        throw new Error("Process frame exceeds limit.");
      }
      if (newline >= 0) {
        if (!size) {
          throw new Error("Empty process frame.");
        }
        // Decode the borrowed view before yielding; only unfinished frames need owned copies.
        if (parts.length === 0) {
          yield decoder.decode(part);
        } else {
          parts.push(part);
          yield decoder.decode(Buffer.concat(parts, size));
        }
        parts = [];
        size = 0;
      } else if (part.length) {
        parts.push(new Uint8Array(part));
      }
      start = end + 1;
    }
  }
  if (size) {
    throw new Error("Incomplete process frame.");
  }
}
