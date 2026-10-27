import {
  MAX_PAGE_CAPTURE_BYTES,
  type NativePageCapture,
  type NativePageCaptureOptions,
  type NativePageCaptureRegion,
  PAGE_CAPTURE_TIMEOUT_MS,
} from "@bunaway/plugin-api/native";
import { BunawayError, isRecord } from "@bunaway/protocol";

// Page images come from the DevTools protocol (`Page.captureScreenshot`) instead of
// ICoreWebView2::CapturePreview, because CapturePreview has no clip rectangle and always renders
// the whole visible page. The protocol call needs no IStream, renders from the compositor surface
// and works with the DevTools UI disabled.

/** Quality of a JPEG capture, from 0 to 100. */
const JPEG_QUALITY = 90;
/** Reported in `details.reason` so a caller can tell this failure from other INVALID_ARGUMENT errors. */
const TOO_LARGE_REASON = "CAPTURE_TOO_LARGE";
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
/** Byte offsets of the width and height in the IHDR chunk that follows the PNG signature. */
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PNG_HEADER_BYTES = 24;

/** How one DevTools protocol call ended; the caller maps the native HRESULT to one of these. */
export type ProtocolOutcome =
  | {
      kind: "ok";
      json: string;
    }
  | {
      kind: "too-large";
    }
  | {
      kind: "failed";
      reason: string;
    };

/**
 * Run one DevTools protocol method and resolve with its outcome. Rejects with TIMEOUT after
 * `timeoutMs`, with BUSY when the view cannot take another call, and with INVALID_ARGUMENT
 * when the view closes first.
 */
export type ProtocolCall = (
  method: string,
  parameters: object,
  timeoutMs: number,
) => Promise<ProtocolOutcome>;

/** The part of `Page.getLayoutMetrics` a clip needs: the visible page in CSS pixels. */
type VisiblePage = {
  pageX: number;
  pageY: number;
  width: number;
  height: number;
};

type Clip = NativePageCaptureRegion & {
  scale: 1;
};

function captureError(
  code: "INVALID_ARGUMENT" | "INTERNAL" | "TIMEOUT",
  message: string,
  reason?: string,
) {
  return new BunawayError({
    code,
    message,
    ...(reason === undefined
      ? {}
      : {
          details: {
            reason,
          },
        }),
  });
}

function tooLarge() {
  return captureError(
    "INVALID_ARGUMENT",
    "The captured image exceeds the size limit. Use jpeg or a smaller region.",
    TOO_LARGE_REASON,
  );
}

function parseObject(json: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Reported below with the same message as a non-object reply.
  }
  throw captureError("INTERNAL", `The WebView returned an invalid ${what}.`);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Read the visible page of a `Page.getLayoutMetrics` reply. */
export function parseVisiblePage(json: string): VisiblePage {
  const metrics = parseObject(json, "layout reply");
  const viewport = isRecord(metrics.cssVisualViewport)
    ? metrics.cssVisualViewport
    : {};
  const pageX = finiteNumber(viewport.pageX);
  const pageY = finiteNumber(viewport.pageY);
  const width = finiteNumber(viewport.clientWidth);
  const height = finiteNumber(viewport.clientHeight);
  if (
    pageX === undefined ||
    pageY === undefined ||
    width === undefined ||
    height === undefined
  ) {
    throw captureError("INTERNAL", "The WebView returned an invalid layout.");
  }
  return {
    pageX,
    pageY,
    width,
    height,
  };
}

/**
 * Turn a region measured from the visible page's corner into a document clip: the region is cut
 * at the page edges and shifted by the scroll offset, which `clip` is measured against.
 */
export function clipForRegion(
  region: NativePageCaptureRegion,
  page: VisiblePage,
): Clip {
  const right = Math.min(region.x + region.width, Math.floor(page.width));
  const bottom = Math.min(region.y + region.height, Math.floor(page.height));
  if (right <= region.x || bottom <= region.y) {
    throw captureError(
      "INVALID_ARGUMENT",
      "The region lies outside the visible page.",
    );
  }
  return {
    x: page.pageX + region.x,
    y: page.pageY + region.y,
    width: right - region.x,
    height: bottom - region.y,
    scale: 1,
  };
}

/** Parameters of `Page.captureScreenshot` for the visible page or a clip of it. */
export function screenshotParameters(
  format: NativePageCaptureOptions["format"],
  clip: Clip | undefined,
): object {
  return {
    format,
    fromSurface: true,
    captureBeyondViewport: false,
    ...(format === "jpeg"
      ? {
          quality: JPEG_QUALITY,
        }
      : {}),
    ...(clip
      ? {
          clip,
        }
      : {}),
  };
}

/** Whether a JPEG marker is a start-of-frame segment, which holds the image size. */
function isStartOfFrame(marker: number): boolean {
  // C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frame headers.
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    ![
      0xc4,
      0xc8,
      0xcc,
    ].includes(marker)
  );
}

/** Read the pixel size from a PNG or JPEG header, or undefined when the header is not that format. */
export function imageSize(
  bytes: Buffer,
  format: NativePageCaptureOptions["format"],
):
  | {
      width: number;
      height: number;
    }
  | undefined {
  if (format === "png") {
    if (
      bytes.length < PNG_HEADER_BYTES ||
      !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      return undefined;
    }
    return {
      width: bytes.readUInt32BE(PNG_WIDTH_OFFSET),
      height: bytes.readUInt32BE(PNG_HEIGHT_OFFSET),
    };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  // Walk the segments after the SOI marker: each is FF, marker, then a length that includes itself.
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) {
        return undefined;
      }
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

/** Validate a `Page.captureScreenshot` reply and describe the image it carries. */
export function decodeScreenshot(
  outcome: ProtocolOutcome,
  format: NativePageCaptureOptions["format"],
): NativePageCapture {
  if (outcome.kind === "too-large") {
    throw tooLarge();
  }
  if (outcome.kind === "failed") {
    throw captureError(
      "INTERNAL",
      `Capturing the page failed: ${outcome.reason}`,
    );
  }
  const reply = parseObject(outcome.json, "screenshot reply");
  if (typeof reply.data !== "string") {
    throw captureError("INTERNAL", "The WebView returned no image data.");
  }
  const bytes = Buffer.from(reply.data, "base64");
  if (bytes.length > MAX_PAGE_CAPTURE_BYTES) {
    throw tooLarge();
  }
  const size = imageSize(bytes, format);
  if (!size || size.width < 1 || size.height < 1) {
    throw captureError(
      "INTERNAL",
      `The WebView returned data that is not a ${format} image.`,
    );
  }
  return {
    mime: format === "png" ? "image/png" : "image/jpeg",
    // Re-encoded from the decoded bytes so the result is canonical padded base64.
    data: bytes.toString("base64"),
    ...size,
  };
}

/**
 * Capture the visible page, or a region of it, as an encoded image.
 *
 * A region first reads the visible page size and scroll offset so it can be cut at the page edges
 * and positioned in document coordinates. Both protocol calls share one deadline of
 * PAGE_CAPTURE_TIMEOUT_MS. The caller owns the single-flight rule and the view's lifetime.
 */
export async function capturePageImage(
  call: ProtocolCall,
  options: NativePageCaptureOptions,
  now: () => number = () => performance.now(),
): Promise<NativePageCapture> {
  const deadline = now() + PAGE_CAPTURE_TIMEOUT_MS;
  const run = (method: string, parameters: object) => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw captureError(
        "TIMEOUT",
        "The WebView did not produce an image in time.",
      );
    }
    return call(method, parameters, remaining);
  };
  let clip: Clip | undefined;
  if (options.region) {
    const layout = await run("Page.getLayoutMetrics", {});
    if (layout.kind !== "ok") {
      throw captureError("INTERNAL", "Reading the page layout failed.");
    }
    clip = clipForRegion(options.region, parseVisiblePage(layout.json));
  }
  return decodeScreenshot(
    await run(
      "Page.captureScreenshot",
      screenshotParameters(options.format, clip),
    ),
    options.format,
  );
}
