import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Serve only compiled web files for the app origin.
 * Never read other app files or fetch from the network.
 * Invalid paths and methods return HTTP errors; unexpected filesystem errors propagate.
 */
export function webAsset(
  assets: string,
  uri: string,
  method: string,
  range = "",
) {
  const empty = (status: number, reason: string, headers = "") => ({
    status,
    reason,
    headers,
    body: Buffer.alloc(0),
  });
  let parts: string[];
  try {
    const url = new URL(uri);
    if (
      url.origin !== "https://app.bunaway.local" ||
      url.username ||
      url.password
    ) {
      return empty(403, "Forbidden");
    }
    const path = decodeURIComponent(url.pathname);
    parts = (path === "/" ? "index.html" : path.slice(1)).split("/");
    if (
      parts.some(
        (part) =>
          !part || part === "." || part === ".." || /[\\:\0]/.test(part),
      )
    ) {
      return empty(404, "Not Found");
    }
  } catch {
    return empty(400, "Bad Request");
  }
  if (method !== "GET" && method !== "HEAD") {
    return empty(405, "Method Not Allowed", "Allow: GET, HEAD");
  }
  const path = resolve(assets, "web", ...parts);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (
      [
        "ENOENT",
        "EISDIR",
        "ENOTDIR",
      ].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return empty(404, "Not Found");
    }
    throw error;
  }
  const size = bytes.length;
  let status = 200;
  let contentRange = "";
  // HTTP permits ignoring unsupported/multipart ranges and sending the full file.
  const match = method === "GET" && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match && (match[1] || match[2])) {
    const start = match[1]
      ? Number(match[1])
      : Math.max(0, size - Number(match[2]));
    const end =
      match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    ) {
      return empty(
        416,
        "Range Not Satisfiable",
        `Content-Range: bytes */${size}`,
      );
    }
    status = 206;
    bytes = bytes.subarray(start, end + 1);
    contentRange = `Content-Range: bytes ${start}-${end}/${size}\r\n`;
  }
  return {
    status,
    reason: status === 206 ? "Partial Content" : "OK",
    headers: `${contentRange}Content-Type: ${Bun.file(path).type || "application/octet-stream"}\r\nContent-Length: ${bytes.length}\r\nAccept-Ranges: bytes\r\nX-Content-Type-Options: nosniff`,
    body: method === "HEAD" ? Buffer.alloc(0) : bytes,
  };
}
