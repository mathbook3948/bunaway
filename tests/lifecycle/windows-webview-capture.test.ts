import { expect, test } from "bun:test";
import { MAX_PAGE_CAPTURE_BYTES } from "@bunaway/plugin-api/native";
import {
  capturePageImage,
  clipForRegion,
  decodeScreenshot,
  imageSize,
  type ProtocolCall,
  type ProtocolOutcome,
  parseVisiblePage,
  screenshotParameters,
} from "#native/windows/bun/webview-capture";

/** A PNG signature and IHDR chunk header with the given size; the rest of the file is absent. */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** A JPEG with an APP0 segment before the frame header, as an encoder writes it. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
  ]);
  const frame = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x01,
  ]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([
      0xff,
      0xd8,
    ]),
    app0,
    frame,
  ]);
}

const PAGE = {
  pageX: 100,
  pageY: 2000,
  width: 800.5,
  height: 600,
};
const layoutJson = JSON.stringify({
  cssVisualViewport: {
    pageX: 100,
    pageY: 2000,
    clientWidth: 800.5,
    clientHeight: 600,
  },
});
const screenshotJson = (bytes: Buffer) =>
  JSON.stringify({
    data: bytes.toString("base64"),
  });
const ok = (json: string): ProtocolOutcome => ({
  kind: "ok",
  json,
});

test("image headers give the pixel size of a png and of a jpeg after other segments", () => {
  expect(imageSize(pngHeader(640, 480), "png")).toEqual({
    width: 640,
    height: 480,
  });
  expect(imageSize(jpegHeader(321, 123), "jpeg")).toEqual({
    width: 321,
    height: 123,
  });
});

test("a header of the other format, a truncated header or no frame segment has no size", () => {
  expect(imageSize(jpegHeader(2, 2), "png")).toBeUndefined();
  expect(imageSize(pngHeader(2, 2), "jpeg")).toBeUndefined();
  expect(imageSize(pngHeader(2, 2).subarray(0, 20), "png")).toBeUndefined();
  expect(imageSize(jpegHeader(2, 2).subarray(0, 12), "jpeg")).toBeUndefined();
  // A DHT segment (C4) is not a frame header.
  expect(
    imageSize(
      Buffer.from([
        0xff,
        0xd8,
        0xff,
        0xc4,
        0x00,
        0x04,
        0x00,
        0x00,
        0xff,
        0xd9,
      ]),
      "jpeg",
    ),
  ).toBeUndefined();
});

test("a region is cut at the page edges and moved by the scroll offset", () => {
  expect(
    clipForRegion(
      {
        x: 10,
        y: 20,
        width: 50,
        height: 60,
      },
      PAGE,
    ),
  ).toEqual({
    x: 110,
    y: 2020,
    width: 50,
    height: 60,
    scale: 1,
  });
  expect(
    clipForRegion(
      {
        x: 700,
        y: 500,
        width: 500,
        height: 500,
      },
      PAGE,
    ),
  ).toEqual({
    x: 800,
    y: 2500,
    width: 100,
    height: 100,
    scale: 1,
  });
});

test("a region outside the visible page is refused", () => {
  for (const region of [
    {
      x: 800,
      y: 0,
      width: 10,
      height: 10,
    },
    {
      x: 0,
      y: 600,
      width: 10,
      height: 10,
    },
  ]) {
    expect(() => clipForRegion(region, PAGE)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("layout metrics without a numeric visible page are refused", () => {
  expect(parseVisiblePage(layoutJson)).toEqual({
    pageX: 100,
    pageY: 2000,
    width: 800.5,
    height: 600,
  });
  for (const json of [
    "[]",
    "{",
    "{}",
    JSON.stringify({
      cssVisualViewport: {
        pageX: 0,
        pageY: 0,
        clientWidth: "800",
        clientHeight: 600,
      },
    }),
  ]) {
    expect(() => parseVisiblePage(json)).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }
});

test("screenshot parameters ask for the surface, never beyond the viewport, and quality only for jpeg", () => {
  expect(screenshotParameters("png", undefined)).toEqual({
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const clip = {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    scale: 1,
  } as const;
  expect(screenshotParameters("jpeg", clip)).toEqual({
    format: "jpeg",
    fromSurface: true,
    captureBeyondViewport: false,
    quality: 90,
    clip,
  });
});

test("a screenshot reply becomes a canonical image with its mime type and size", () => {
  const png = pngHeader(7, 9);
  expect(decodeScreenshot(ok(screenshotJson(png)), "png")).toEqual({
    mime: "image/png",
    data: png.toString("base64"),
    width: 7,
    height: 9,
  });
  const jpeg = jpegHeader(5, 4);
  expect(decodeScreenshot(ok(screenshotJson(jpeg)), "jpeg")).toMatchObject({
    mime: "image/jpeg",
    width: 5,
    height: 4,
  });
});

test("an oversized, mismatched or failed screenshot is reported with a precise error", () => {
  const tooLarge = expect.objectContaining({
    code: "INVALID_ARGUMENT",
    details: {
      reason: "CAPTURE_TOO_LARGE",
    },
  });
  expect(() =>
    decodeScreenshot(
      {
        kind: "too-large",
      },
      "png",
    ),
  ).toThrow(tooLarge);
  const big = Buffer.concat([
    pngHeader(1, 1),
    Buffer.alloc(MAX_PAGE_CAPTURE_BYTES),
  ]);
  expect(() => decodeScreenshot(ok(screenshotJson(big)), "png")).toThrow(
    tooLarge,
  );
  expect(() =>
    decodeScreenshot(ok(screenshotJson(jpegHeader(1, 1))), "png"),
  ).toThrow(
    expect.objectContaining({
      code: "INTERNAL",
    }),
  );
  expect(() => decodeScreenshot(ok("{}"), "png")).toThrow(
    expect.objectContaining({
      code: "INTERNAL",
    }),
  );
  expect(() =>
    decodeScreenshot(
      {
        kind: "failed",
        reason: "RPC_E_DISCONNECTED",
      },
      "png",
    ),
  ).toThrow(/RPC_E_DISCONNECTED/);
});

test("capturing the whole page makes one screenshot call and no layout call", async () => {
  const calls: [
    string,
    object,
  ][] = [];
  const call: ProtocolCall = async (method, parameters) => {
    calls.push([
      method,
      parameters,
    ]);
    return ok(screenshotJson(pngHeader(3, 2)));
  };
  const image = await capturePageImage(call, {
    format: "png",
    region: null,
  });
  expect(image).toMatchObject({
    mime: "image/png",
    width: 3,
    height: 2,
  });
  expect(calls).toEqual([
    [
      "Page.captureScreenshot",
      screenshotParameters("png", undefined),
    ],
  ]);
});

test("capturing a region reads the layout first and clips in document coordinates", async () => {
  const calls: [
    string,
    object,
  ][] = [];
  const call: ProtocolCall = async (method, parameters) => {
    calls.push([
      method,
      parameters,
    ]);
    return method === "Page.getLayoutMetrics"
      ? ok(layoutJson)
      : ok(screenshotJson(jpegHeader(50, 60)));
  };
  const image = await capturePageImage(call, {
    format: "jpeg",
    region: {
      x: 10,
      y: 20,
      width: 50,
      height: 60,
    },
  });
  expect(image).toMatchObject({
    mime: "image/jpeg",
    width: 50,
    height: 60,
  });
  expect(calls.map(([method]) => method)).toEqual([
    "Page.getLayoutMetrics",
    "Page.captureScreenshot",
  ]);
  expect(calls[1]?.[1]).toMatchObject({
    clip: {
      x: 110,
      y: 2020,
      width: 50,
      height: 60,
    },
  });
});

test("a region outside the page fails before any screenshot is taken", async () => {
  const methods: string[] = [];
  const call: ProtocolCall = async (method) => {
    methods.push(method);
    return ok(layoutJson);
  };
  await expect(
    capturePageImage(call, {
      format: "png",
      region: {
        x: 5000,
        y: 0,
        width: 10,
        height: 10,
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(methods).toEqual([
    "Page.getLayoutMetrics",
  ]);
});

test("both calls share one deadline and the second receives only the time left", async () => {
  let clock = 0;
  const budgets: number[] = [];
  const call: ProtocolCall = async (method, _parameters, timeoutMs) => {
    budgets.push(timeoutMs);
    clock += 10_000;
    return method === "Page.getLayoutMetrics"
      ? ok(layoutJson)
      : ok(screenshotJson(pngHeader(1, 1)));
  };
  await capturePageImage(
    call,
    {
      format: "png",
      region: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      },
    },
    () => clock,
  );
  expect(budgets).toEqual([
    15_000,
    5_000,
  ]);
  clock = 0;
  const slow: ProtocolCall = async () => {
    clock += 15_000;
    return ok(layoutJson);
  };
  await expect(
    capturePageImage(
      slow,
      {
        format: "png",
        region: {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      },
      () => clock,
    ),
  ).rejects.toMatchObject({
    code: "TIMEOUT",
  });
});
