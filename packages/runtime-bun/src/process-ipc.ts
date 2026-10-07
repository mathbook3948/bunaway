import { MAX_MESSAGE_BYTES } from "@bunaway/protocol";

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
    for (let end = 0; end <= chunk.length; end++) {
      if (end < chunk.length && chunk[end] !== 10) {
        continue;
      }
      const part = chunk.subarray(start, end);
      size += part.length;
      if (size > MAX_MESSAGE_BYTES) {
        throw new Error("Process frame exceeds limit.");
      }
      if (part.length) {
        parts.push(new Uint8Array(part));
      }
      if (end < chunk.length) {
        if (!size) {
          throw new Error("Empty process frame.");
        }
        yield decoder.decode(Buffer.concat(parts, size));
        parts = [];
        size = 0;
      }
      start = end + 1;
    }
  }
  if (size) {
    throw new Error("Incomplete process frame.");
  }
}
