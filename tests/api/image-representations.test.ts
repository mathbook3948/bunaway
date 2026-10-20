import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import {
  imageOperations,
  validateImageInput,
} from "#plugins/image/src/operations";
import type { ImageCodec, Pixels } from "#plugins/image/src/platforms/codec";
import { ImagePlatform } from "#plugins/image/src/platforms/image-platform";

// Representations are pure pixel-pool bookkeeping, so only encode and dispose may be reached.
const codec = {
  encode: (pixels: Pixels) => Buffer.from(`${pixels.width}x${pixels.height}`),
  dispose: () => undefined,
} as unknown as ImageCodec;

function rgba(width: number, height: number) {
  return {
    width,
    height,
    rgba: Buffer.alloc(width * height * 4, 1).toString("base64"),
  };
}

function setup() {
  const platform = new ImagePlatform(codec);
  return {
    platform,
    make: (width: number, height: number) =>
      platform.createRGBA(rgba(width, height)).id,
  };
}

test("operations are registered and inputs are bounded", () => {
  expect(Object.keys(imageOperations)).toContain("addRepresentation");
  expect(Object.keys(imageOperations)).toContain("getRepresentations");
  const id = crypto.randomUUID();
  const source = crypto.randomUUID();
  expect<unknown>(
    validateImageInput("image.addRepresentation", {
      id,
      source,
      scaleFactor: 1.5,
    } as JsonValue),
  ).toEqual({
    id,
    source,
    scaleFactor: 1.5,
  });
  for (const scaleFactor of [
    0,
    -1,
    1,
    4.01,
    Number.NaN,
    "2",
  ]) {
    expect(() =>
      validateImageInput("image.addRepresentation", {
        id,
        source,
        scaleFactor: scaleFactor as number,
      }),
    ).toThrow();
  }
  expect(() =>
    validateImageInput("image.getPixels", {
      id,
      scaleFactor: 0,
    }),
  ).toThrow();
  expect(() =>
    validateImageInput("image.exportBytes", {
      id,
      format: "image/png",
      scaleFactor: 5,
    }),
  ).toThrow();
});

test("selection prefers exact, then the smallest larger, then the largest", () => {
  const { platform, make } = setup();
  const base = make(2, 2);
  platform.addRepresentation({
    id: base,
    scaleFactor: 2,
    source: make(4, 4),
  });
  platform.addRepresentation({
    id: base,
    scaleFactor: 3,
    source: make(6, 6),
  });
  expect(platform.getRepresentations(base).representations).toEqual([
    {
      scaleFactor: 1,
      width: 2,
      height: 2,
    },
    {
      scaleFactor: 2,
      width: 4,
      height: 4,
    },
    {
      scaleFactor: 3,
      width: 6,
      height: 6,
    },
  ]);
  const chosen = (scaleFactor?: number) =>
    (
      platform.getInfo(base, scaleFactor) as {
        scaleFactor?: number;
      }
    ).scaleFactor;
  expect(chosen(2)).toBe(2);
  expect(chosen(1.25)).toBe(2);
  expect(chosen(2.5)).toBe(3);
  expect(chosen(4)).toBe(3);
  expect(chosen(0.5)).toBe(1);
  expect(platform.getInfo(base)).toEqual({
    width: 2,
    height: 2,
    empty: false,
  });
  expect(platform.getInfo(base, 2.5)).toMatchObject({
    width: 6,
    height: 6,
  });
  expect(platform.getPixels(base, 2).width).toBe(4);
  expect(
    platform.exportBytes({
      id: base,
      format: "image/png",
      scaleFactor: 2,
    }).data,
  ).toBe(Buffer.from("4x4").toString("base64"));
  expect(platform.getPixels(base).width).toBe(2);
});

test("a single image selects its only representation for any scale", () => {
  const { platform, make } = setup();
  const id = make(3, 3);
  expect(platform.getInfo(id, 4)).toMatchObject({
    width: 3,
    scaleFactor: 1,
  });
  expect(platform.getRepresentations(id).representations).toHaveLength(1);
});

test("logical size must match the base, allowing floor or ceil rounding", () => {
  const { platform, make } = setup();
  const base = make(3, 3);
  const add = (scaleFactor: number, size: number) =>
    platform.addRepresentation({
      id: base,
      scaleFactor,
      source: make(size, size),
    });
  expect(() => add(1.5, 4)).not.toThrow();
  expect(() => add(1.25, 4)).not.toThrow();
  expect(() => add(2, 7)).toThrow(/size/);
  expect(() => add(2, 5)).toThrow(/size/);
  const empty = platform.createRGBA({
    width: 0,
    height: 0,
    rgba: "",
  }).id;
  expect(() =>
    platform.addRepresentation({
      id: base,
      scaleFactor: 2,
      source: empty,
    }),
  ).toThrow(/size/);
  expect(() =>
    platform.addRepresentation({
      id: empty,
      scaleFactor: 2,
      source: base,
    }),
  ).toThrow(/size/);
  expect(() =>
    platform.addRepresentation({
      id: base,
      scaleFactor: 2,
      source: crypto.randomUUID(),
    }),
  ).toThrow(/does not exist/);
});

test("same scale replaces and the representation count is bounded", () => {
  const { platform, make } = setup();
  const base = make(100, 100);
  platform.addRepresentation({
    id: base,
    scaleFactor: 2,
    source: make(200, 200),
  });
  platform.addRepresentation({
    id: base,
    scaleFactor: 2,
    source: make(200, 200),
  });
  expect(platform.getRepresentations(base).representations).toContainEqual({
    scaleFactor: 2,
    width: 200,
    height: 200,
  });
  expect(platform.getRepresentations(base).representations).toHaveLength(2);
  const small = make(1, 1);
  for (let i = 1; i < 8; i++) {
    platform.addRepresentation({
      id: small,
      scaleFactor: 1 + i / 4,
      source: make(Math.floor(1 + i / 4), Math.floor(1 + i / 4)),
    });
  }
  expect(() =>
    platform.addRepresentation({
      id: small,
      scaleFactor: 4,
      source: make(4, 4),
    }),
  ).not.toThrow();
  expect(() =>
    platform.addRepresentation({
      id: small,
      scaleFactor: 3.5,
      source: make(3, 3),
    }),
  ).toThrow(/limit/);
});

test("representation pixels count toward the pool and dispose releases them", () => {
  const { platform, make } = setup();
  // 1024 x 128 RGBA is the 524288 byte image limit; the pool holds 16 of them.
  const base = make(1024, 128);
  const filler = make(1024, 128);
  const spare = make(1024, 128);
  for (let i = 0; i < 13; i++) {
    make(1024, 128);
  }
  expect(() =>
    platform.addRepresentation({
      id: base,
      scaleFactor: 1.0001,
      source: filler,
    }),
  ).toThrow(/memory/);
  // Freeing an unrelated image makes room, and disposing the owner returns the bytes.
  platform.remove(filler);
  platform.remove(spare);
  platform.addRepresentation({
    id: base,
    scaleFactor: 1.0001,
    source: make(1024, 128),
  });
  expect(platform.remove(base)).toBe(true);
  expect(() => make(1024, 128)).not.toThrow();
  platform.dispose();
});

test("representations of a disposed image are released with it", () => {
  const { platform, make } = setup();
  const base = make(2, 2);
  const big = make(4, 4);
  platform.addRepresentation({
    id: base,
    scaleFactor: 2,
    source: big,
  });
  expect(platform.remove(base)).toBe(true);
  expect(platform.remove(base)).toBe(false);
  expect(() => platform.getRepresentations(base)).toThrow(/does not exist/);
  expect(() => platform.getPixels(base, 2)).toThrow(/does not exist/);
  expect(platform.getInfo(big).width).toBe(4);
});

test("a disposed source keeps the attached representation and the adapter close cancels", () => {
  const { platform, make } = setup();
  const base = make(2, 2);
  const big = make(4, 4);
  platform.addRepresentation({
    id: base,
    scaleFactor: 2,
    source: big,
  });
  platform.remove(big);
  expect(platform.getPixels(base, 2).width).toBe(4);
  platform.dispose();
  expect(() => platform.getInfo(base)).toThrow(/cancelled/);
});

test("transforms use the base image of a source with representations", () => {
  const { platform, make } = setup();
  const base = make(2, 2);
  platform.addRepresentation({
    id: base,
    scaleFactor: 2,
    source: make(4, 4),
  });
  const cropped = platform.crop({
    id: base,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  expect(platform.getRepresentations(cropped.id).representations).toEqual([
    {
      scaleFactor: 1,
      width: 1,
      height: 1,
    },
  ]);
});

test("a product that is mathematically whole accepts only that size", () => {
  const { platform, make } = setup();
  const base = make(50, 50);
  expect(() =>
    platform.addRepresentation({
      id: base,
      scaleFactor: 1.1,
      source: make(56, 56),
    }),
  ).toThrow(/size/);
  expect(() =>
    platform.addRepresentation({
      id: base,
      scaleFactor: 1.1,
      source: make(55, 55),
    }),
  ).not.toThrow();
  const other = make(45, 45);
  expect(() =>
    platform.addRepresentation({
      id: other,
      scaleFactor: 1.4,
      source: make(62, 62),
    }),
  ).toThrow(/size/);
  const third = make(25, 25);
  expect(() =>
    platform.addRepresentation({
      id: third,
      scaleFactor: 2.2,
      source: make(56, 56),
    }),
  ).toThrow(/size/);
});
