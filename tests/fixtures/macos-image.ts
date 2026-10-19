import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import type { JsonValue } from "@bunaway/protocol";
import { nativeFactory } from "./native-platform.ts";

/** Build independent PNG inputs, including palette and grayscale layouts that the encoder never emits. */
function pngChunk(name: string, payload: Buffer): Buffer {
  const body = Buffer.concat([
    Buffer.from(name),
    payload,
  ]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
function png(
  width: number,
  height: number,
  colorType: number,
  rows: Buffer,
  extra: Buffer[] = [],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
    ]),
    pngChunk("IHDR", header),
    ...extra,
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A complete two-frame APNG must not silently publish only its first frame. */
function animatedPNG(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  const frame = (sequence: number) => {
    const value = Buffer.alloc(26);
    value.writeUInt32BE(sequence, 0);
    value.writeUInt32BE(1, 4);
    value.writeUInt32BE(1, 8);
    value.writeUInt16BE(1, 20);
    value.writeUInt16BE(10, 22);
    return value;
  };
  const second = Buffer.alloc(4);
  second.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
    ]),
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
    pngChunk("fcTL", frame(0)),
    pngChunk(
      "IDAT",
      deflateSync(
        Buffer.from([
          0,
          255,
          0,
          0,
          255,
        ]),
      ),
    ),
    pngChunk("fcTL", frame(1)),
    pngChunk(
      "fdAT",
      Buffer.concat([
        second,
        deflateSync(
          Buffer.from([
            0,
            0,
            255,
            0,
            255,
          ]),
        ),
      ]),
    ),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const operationNames = [
  "createRGBA",
  "createBytes",
  "createDataURL",
  "getInfo",
  "getPixels",
  "exportBytes",
  "exportDataURL",
  "dispose",
  "crop",
  "resize",
].map((name) => `image.${name}`);

/** Call helpers bound to one adapter: execution, resource ids, encoded bytes and error codes. */
function createImageCalls(
  adapter: ReturnType<ReturnType<typeof nativeFactory>>,
  grants: {
    permissions: string[];
  },
) {
  const call = async (
    name: string,
    input: JsonValue,
    signal?: AbortSignal,
    permissions = grants,
  ) => {
    assert(adapter.executeUI, "Contextual image execution is required");
    // Host messages cross structured clone; protocol validation may use null-prototype objects.
    // Compare the JSON fields and exact bytes after that same boundary, not object prototypes.
    return structuredClone(
      await adapter.executeUI(`image.${name}`, input, "backend", {
        requestId: crypto.randomUUID(),
        permissions,
        ...(signal
          ? {
              signal,
            }
          : {}),
      }),
    );
  };
  const resource = async (
    name: string,
    input: JsonValue,
    signal?: AbortSignal,
  ): Promise<string> => {
    const result = await call(name, input, signal);
    assert(
      result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        typeof result.id === "string",
    );
    return result.id;
  };
  const encoded = async (id: string, mime: string) => {
    const bytes = await call("exportBytes", {
      id,
      format: mime,
    });
    assert(
      bytes &&
        typeof bytes === "object" &&
        !Array.isArray(bytes) &&
        typeof bytes.data === "string",
    );
    return bytes;
  };
  const error = async (action: () => unknown, code: string) => {
    await assert.rejects(
      async () => action(),
      (value: unknown) => {
        // The packaged SDK checks already-aborted requests before native execution.
        if (
          code === "CANCELLED" &&
          value instanceof Error &&
          value.name === "AbortError"
        ) {
          return true;
        }
        assert(value && typeof value === "object" && "code" in value);
        assert.equal(value.code, code);
        return true;
      },
    );
  };
  return {
    call,
    resource,
    encoded,
    error,
  };
}

type ImageCalls = ReturnType<typeof createImageCalls>;

/** An opaque pixel survives an encode and decode round trip: exactly for BMP, within a lossy tolerance for JPEG. */
async function checkOpaqueRoundTrip(
  { call, resource, encoded }: ImageCalls,
  mime: string,
): Promise<void> {
  const opaquePixels = {
    width: 1,
    height: 1,
    rgba: Buffer.from([
      21,
      81,
      141,
      255,
    ]).toString("base64"),
  };
  const opaque = await resource("createRGBA", opaquePixels);
  const decoded = await resource("createBytes", await encoded(opaque, mime));
  const result = await call("getPixels", {
    id: decoded,
  });
  assert(
    result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      typeof result.rgba === "string",
  );
  const channels = Buffer.from(result.rgba, "base64");
  assert.equal(channels[3], 255);
  if (mime === "image/bmp") {
    assert.deepEqual(result, opaquePixels);
  } else {
    for (let channel = 0; channel < 3; channel++) {
      assert(
        Math.abs(
          (channels[channel] ?? 0) -
            ([
              21,
              81,
              141,
            ][channel] ?? 0),
        ) < 8,
      );
    }
  }
  await call("dispose", {
    id: opaque,
  });
  await call("dispose", {
    id: decoded,
  });
}

/** Exercise a real native adapter, also reused by the compiled and isolated-install consumers. */
export async function verifyMacosImage(
  plugin: Parameters<typeof nativeFactory>[0],
) {
  // Every consumer uses the SDK factory with the same fixture host permission checks.
  // Real WKWebView authorization is covered separately by macos-image-host.ts.
  const create = nativeFactory(plugin, "macos");
  const adapter = create({
    dataRoot: "/unused-image-fixture",
    capabilities: [],
  });
  const other = create({
    dataRoot: "/unused-image-fixture",
    capabilities: [],
  });
  const grants = {
    permissions: operationNames,
  };
  const { call, resource, encoded, error } = createImageCalls(adapter, grants);
  try {
    // Direct SDK execution is supported and validates schemas without a host context.
    const direct = await adapter.execute(
      "image.createRGBA",
      {
        width: 0,
        height: 0,
        rgba: "",
      },
      "backend",
    );
    assert(direct && typeof direct === "object" && !Array.isArray(direct));
    assert(typeof direct.id === "string");
    assert.deepEqual(structuredClone(direct), {
      id: direct.id,
      width: 0,
      height: 0,
      empty: true,
    });
    assert.deepEqual(
      await call("getInfo", {
        id: direct.id,
      }),
      {
        width: 0,
        height: 0,
        empty: true,
      },
    );
    assert.equal(
      await call("dispose", {
        id: direct.id,
      }),
      true,
    );
    await error(
      () =>
        adapter.execute(
          "image.createRGBA",
          {
            width: 0,
            height: 1,
            rgba: "",
          },
          "backend",
        ),
      "INVALID_ARGUMENT",
    );
    const bytes = Buffer.from([
      255,
      0,
      0,
      128,
      0,
      255,
      0,
      255,
      17,
      31,
      63,
      0,
      11,
      22,
      33,
      44,
    ]);
    const pixels = {
      width: 2,
      height: 2,
      rgba: bytes.toString("base64"),
    };
    const id = await resource("createRGBA", pixels);
    assert.deepEqual(
      await call("getPixels", {
        id,
      }),
      pixels,
    );
    assert.deepEqual(
      await call("getInfo", {
        id,
      }),
      {
        width: 2,
        height: 2,
        empty: false,
      },
    );
    await error(
      () =>
        other.executeUI?.(
          "image.getInfo",
          {
            id,
          },
          "backend",
          {
            requestId: "other",
            permissions: grants,
          },
        ),
      "INVALID_ARGUMENT",
    );
    await error(
      () =>
        call(
          "getPixels",
          {
            id,
          },
          undefined,
          {
            permissions: [
              "image.getInfo",
            ],
          },
        ),
      "PERMISSION_DENIED",
    );
    const controller = new AbortController();
    controller.abort();
    await error(
      () => call("createRGBA", pixels, controller.signal),
      "CANCELLED",
    );
    const pending = new AbortController();
    const cancelled = await resource("createRGBA", pixels, pending.signal);
    pending.abort();
    await error(
      () =>
        call("getInfo", {
          id: cancelled,
        }),
      "INVALID_ARGUMENT",
    );

    const pngBytes = await encoded(id, "image/png");
    const restored = await resource("createBytes", pngBytes);
    assert.deepEqual(
      await call("getPixels", {
        id: restored,
      }),
      pixels,
    );
    const url = await call("exportDataURL", {
      id,
      format: "image/png",
    });
    assert.equal(typeof url, "string");
    const fromURL = await resource("createDataURL", {
      url,
    });
    assert.deepEqual(
      await call("getPixels", {
        id: fromURL,
      }),
      pixels,
    );
    await error(
      () =>
        call("createBytes", {
          ...pngBytes,
          mime: "image/jpeg",
        }),
      "INVALID_ARGUMENT",
    );
    for (const mime of [
      "image/jpeg",
      "image/bmp",
    ]) {
      await error(() => encoded(id, mime), "INVALID_ARGUMENT");
      await checkOpaqueRoundTrip(
        {
          call,
          resource,
          encoded,
          error,
        },
        mime,
      );
    }
    for (const input of [
      {
        data: png(
          2,
          1,
          0,
          Buffer.from([
            0,
            19,
            203,
          ]),
        ),
        rgba: Buffer.from([
          19,
          19,
          19,
          255,
          203,
          203,
          203,
          255,
        ]),
      },
      {
        data: png(
          2,
          1,
          3,
          Buffer.from([
            0,
            0,
            1,
          ]),
          [
            pngChunk(
              "PLTE",
              Buffer.from([
                255,
                0,
                0,
                0,
                255,
                0,
              ]),
            ),
            pngChunk(
              "tRNS",
              Buffer.from([
                128,
                0,
              ]),
            ),
          ],
        ),
        rgba: Buffer.from([
          255,
          0,
          0,
          128,
          0,
          255,
          0,
          0,
        ]),
      },
    ]) {
      const decoded = await resource("createBytes", {
        mime: "image/png",
        data: input.data.toString("base64"),
      });
      assert.deepEqual(
        await call("getPixels", {
          id: decoded,
        }),
        {
          width: 2,
          height: 1,
          rgba: input.rgba.toString("base64"),
        },
      );
      await call("dispose", {
        id: decoded,
      });
    }
    for (const data of [
      Buffer.from("invalid image"),
      animatedPNG(),
      Buffer.from(pngBytes.data as string, "base64").subarray(0, 30),
      png(
        4096,
        4096,
        6,
        Buffer.from([
          0,
          0,
          0,
          0,
          0,
        ]),
      ),
    ]) {
      await error(
        () =>
          call("createBytes", {
            mime: "image/png",
            data: data.toString("base64"),
          }),
        "INVALID_ARGUMENT",
      );
    }
    const crop = await resource("crop", {
      id,
      x: 1,
      y: 0,
      width: 1,
      height: 2,
    });
    assert.deepEqual(
      await call("getPixels", {
        id: crop,
      }),
      {
        width: 1,
        height: 2,
        rgba: Buffer.concat([
          bytes.subarray(4, 8),
          bytes.subarray(12, 16),
        ]).toString("base64"),
      },
    );
    await error(
      () =>
        call("crop", {
          id,
          x: 1,
          y: 1,
          width: 2,
          height: 2,
        }),
      "INVALID_ARGUMENT",
    );
    const nearest = await resource("resize", {
      id,
      width: 1,
      height: 1,
      interpolation: "nearest",
    });
    assert.deepEqual(
      await call("getPixels", {
        id: nearest,
      }),
      {
        width: 1,
        height: 1,
        rgba: bytes.subarray(12, 16).toString("base64"),
      },
    );
    const solid = await resource("createRGBA", {
      width: 1,
      height: 1,
      rgba: "/wAAgA==",
    });
    const linear = await resource("resize", {
      id: solid,
      width: 3,
      height: 2,
    });
    assert.deepEqual(
      await call("getPixels", {
        id: linear,
      }),
      {
        width: 3,
        height: 2,
        rgba: Buffer.from([
          255,
          0,
          0,
          128,
          255,
          0,
          0,
          128,
          255,
          0,
          0,
          128,
          255,
          0,
          0,
          128,
          255,
          0,
          0,
          128,
          255,
          0,
          0,
          128,
        ]).toString("base64"),
      },
    );
    // Distinct rows and columns verify that native drawing preserves the top-to-bottom RGBA order.
    const cornerBytes = Buffer.from([
      255,
      0,
      0,
      255,
      0,
      255,
      0,
      255,
      0,
      0,
      255,
      255,
      255,
      255,
      0,
      255,
    ]);
    const corners = await resource("createRGBA", {
      width: 2,
      height: 2,
      rgba: cornerBytes.toString("base64"),
    });
    const larger = await resource("resize", {
      id: corners,
      width: 4,
      height: 4,
    });
    const largerPixels = await call("getPixels", {
      id: larger,
    });
    assert(
      largerPixels &&
        typeof largerPixels === "object" &&
        !Array.isArray(largerPixels) &&
        typeof largerPixels.rgba === "string",
    );
    const largerBytes = Buffer.from(largerPixels.rgba, "base64");
    for (const [outputOffset, sourceOffset] of [
      [
        0,
        0,
      ],
      [
        12,
        4,
      ],
      [
        48,
        8,
      ],
      [
        60,
        12,
      ],
    ]) {
      assert.deepEqual(
        largerBytes.subarray(outputOffset, (outputOffset ?? 0) + 4),
        cornerBytes.subarray(sourceOffset, (sourceOffset ?? 0) + 4),
      );
    }
    assert.deepEqual(
      await call("getPixels", {
        id: corners,
      }),
      {
        width: 2,
        height: 2,
        rgba: cornerBytes.toString("base64"),
      },
    );
    await call("dispose", {
      id: corners,
    });
    await call("dispose", {
      id: larger,
    });
    // A real midpoint must blend. A solid-color test alone cannot distinguish nearest sampling.
    for (const edgeCase of [
      {
        right: [
          0,
          0,
          255,
          255,
        ],
        middle: [
          128,
          0,
          128,
          255,
        ],
      },
      {
        right: [
          0,
          255,
          0,
          0,
        ],
        middle: [
          255,
          0,
          0,
          128,
        ],
      },
    ]) {
      const edge = await resource("createRGBA", {
        width: 2,
        height: 1,
        rgba: Buffer.from([
          255,
          0,
          0,
          255,
          ...edgeCase.right,
        ]).toString("base64"),
      });
      const filtered = await resource("resize", {
        id: edge,
        width: 3,
        height: 1,
      });
      const result = await call("getPixels", {
        id: filtered,
      });
      assert(
        result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          typeof result.rgba === "string",
      );
      const middle = Buffer.from(result.rgba, "base64").subarray(4, 8);
      for (let channel = 0; channel < 4; channel++) {
        assert(
          Math.abs((middle[channel] ?? 0) - (edgeCase.middle[channel] ?? 0)) <=
            1,
        );
      }
      // Hidden green at alpha zero must not bleed into a visible output pixel.
      assert.equal(middle[1], 0);
      await call("dispose", {
        id: edge,
      });
      await call("dispose", {
        id: filtered,
      });
    }
    assert.deepEqual(
      await call("getPixels", {
        id,
      }),
      pixels,
    );
    for (const value of [
      crop,
      nearest,
      solid,
      linear,
      restored,
      fromURL,
    ]) {
      await call("dispose", {
        id: value,
      });
    }
    assert.equal(
      await call("dispose", {
        id,
      }),
      true,
    );
    assert.equal(
      await call("dispose", {
        id,
      }),
      false,
    );
    await error(
      () =>
        call("getPixels", {
          id,
        }),
      "INVALID_ARGUMENT",
    );
    const empty = await resource("createRGBA", {
      width: 0,
      height: 0,
      rgba: "",
    });
    assert.deepEqual(
      await call("getPixels", {
        id: empty,
      }),
      {
        width: 0,
        height: 0,
        rgba: "",
      },
    );
    await error(() => encoded(empty, "image/png"), "INVALID_ARGUMENT");
    await error(
      () =>
        call("resize", {
          id: empty,
          width: 1,
          height: 1,
        }),
      "INVALID_ARGUMENT",
    );
    await error(
      () =>
        call("crop", {
          id: empty,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        }),
      "INVALID_ARGUMENT",
    );
    await call("dispose", {
      id: empty,
    });

    // Random alpha and hidden RGB stress the straight RGBA conversion at the decode byte ceiling.
    const maximum = Buffer.alloc(524288);
    for (let offset = 0; offset < maximum.length; offset += 65536) {
      crypto.getRandomValues(maximum.subarray(offset, offset + 65536));
    }
    const maximumPixels = {
      width: 512,
      height: 256,
      rgba: maximum.toString("base64"),
    };
    const large = await resource("createRGBA", maximumPixels);
    const largeDecoded = await resource(
      "createBytes",
      await encoded(large, "image/png"),
    );
    assert.deepEqual(
      await call("getPixels", {
        id: largeDecoded,
      }),
      maximumPixels,
    );
    await call("dispose", {
      id: largeDecoded,
    });
    const memoryIDs = [
      large,
    ];
    for (let count = 1; count < 16; count++) {
      memoryIDs.push(await resource("createRGBA", maximumPixels));
    }
    await error(
      () =>
        call("createRGBA", {
          width: 1,
          height: 1,
          rgba: "AAAA/w==",
        }),
      "BUSY",
    );
    await error(
      () =>
        call("resize", {
          id: large,
          width: 1,
          height: 1,
        }),
      "BUSY",
    );
    for (const value of memoryIDs) {
      await call("dispose", {
        id: value,
      });
    }
    const countIDs: string[] = [];
    for (let count = 0; count < 64; count++) {
      countIDs.push(
        await resource("createRGBA", {
          width: 0,
          height: 0,
          rgba: "",
        }),
      );
    }
    await error(() => call("createBytes", pngBytes), "BUSY");
    for (const value of countIDs) {
      await call("dispose", {
        id: value,
      });
    }
    const finalID = await resource("createRGBA", pixels);
    await adapter.dispose();
    await adapter.dispose();
    await error(
      () =>
        call("getInfo", {
          id: finalID,
        }),
      "CANCELLED",
    );
    return {
      platform: process.platform,
      architecture: process.arch,
      bun: Bun.version,
      revision: Bun.revision,
      codecs: [
        "PNG",
        "JPEG",
        "BMP",
      ],
      passed: true,
    };
  } finally {
    await adapter.dispose();
    await other.dispose();
  }
}
