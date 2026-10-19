import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP_ORIGIN = "https://app.bunaway.local";
const MISSING_FILE_CODES = [
  "ENOENT",
  "EISDIR",
  "ENOTDIR",
];

type AssetResponse = {
  status: number;
  reason: string;
  headers: string;
  body: Buffer;
};

function emptyResponse(
  status: number,
  reason: string,
  headers = "",
): AssetResponse {
  return {
    status,
    reason,
    headers,
    body: Buffer.alloc(0),
  };
}

/**
 * Map the request URI to path segments under the compiled web directory.
 * Returns an error response for a foreign origin, credentials, malformed
 * escapes and any segment that could leave the directory.
 */
function assetSegments(uri: string): string[] | AssetResponse {
  try {
    const url = new URL(uri);
    if (url.origin !== APP_ORIGIN || url.username || url.password) {
      return emptyResponse(403, "Forbidden");
    }
    const path = decodeURIComponent(url.pathname);
    const parts = (path === "/" ? "index.html" : path.slice(1)).split("/");
    if (
      parts.some(
        (part) =>
          !part || part === "." || part === ".." || /[\\:\0]/.test(part),
      )
    ) {
      return emptyResponse(404, "Not Found");
    }
    return parts;
  } catch {
    return emptyResponse(400, "Bad Request");
  }
}

/** Read an asset, mapping only "missing or not a file" to undefined; other errors propagate. */
function readAsset(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (
      MISSING_FILE_CODES.includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolve a single-range request header against the file size.
 * HTTP permits ignoring unsupported or multipart ranges, so those return undefined (send the full file).
 * An unsatisfiable range returns the 416 response.
 */
function resolveRange(
  range: string,
  size: number,
):
  | {
      start: number;
      end: number;
    }
  | AssetResponse
  | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || !(match[1] || match[2])) {
    return undefined;
  }
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
    return emptyResponse(
      416,
      "Range Not Satisfiable",
      `Content-Range: bytes */${size}`,
    );
  }
  return {
    start,
    end,
  };
}

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
): AssetResponse {
  const parts = assetSegments(uri);
  if (!Array.isArray(parts)) {
    return parts;
  }
  if (method !== "GET" && method !== "HEAD") {
    return emptyResponse(405, "Method Not Allowed", "Allow: GET, HEAD");
  }
  const path = resolve(assets, "web", ...parts);
  let bytes = readAsset(path);
  if (!bytes) {
    return emptyResponse(404, "Not Found");
  }
  const size = bytes.length;
  let status = 200;
  let contentRange = "";
  const requested = method === "GET" ? resolveRange(range, size) : undefined;
  if (requested && "status" in requested) {
    return requested;
  }
  if (requested) {
    status = 206;
    bytes = bytes.subarray(requested.start, requested.end + 1);
    contentRange = `Content-Range: bytes ${requested.start}-${requested.end}/${size}\r\n`;
  }
  return {
    status,
    reason: status === 206 ? "Partial Content" : "OK",
    headers: `${contentRange}Content-Type: ${Bun.file(path).type || "application/octet-stream"}\r\nContent-Length: ${bytes.length}\r\nAccept-Ranges: bytes\r\nX-Content-Type-Options: nosniff`,
    body: method === "HEAD" ? Buffer.alloc(0) : bytes,
  };
}
