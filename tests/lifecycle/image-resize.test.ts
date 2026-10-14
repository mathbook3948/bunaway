import { expect, test } from "bun:test";
import { resizeNearestPixels } from "#plugins/image/src/platforms/resize";

const source = {
  width: 2,
  height: 2,
  rgba: Buffer.from([
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
    0,
    11,
    22,
    33,
    44,
  ]),
};

test("nearest resizing preserves transparent RGB and translucent channels at every sampled pixel", () => {
  const original = Buffer.from(source.rgba);
  const resized = resizeNearestPixels(source, 4, 4);
  const expected = Buffer.from([
    ...source.rgba.subarray(0, 4),
    ...source.rgba.subarray(0, 4),
    ...source.rgba.subarray(4, 8),
    ...source.rgba.subarray(4, 8),
    ...source.rgba.subarray(0, 4),
    ...source.rgba.subarray(0, 4),
    ...source.rgba.subarray(4, 8),
    ...source.rgba.subarray(4, 8),
    ...source.rgba.subarray(8, 12),
    ...source.rgba.subarray(8, 12),
    ...source.rgba.subarray(12, 16),
    ...source.rgba.subarray(12, 16),
    ...source.rgba.subarray(8, 12),
    ...source.rgba.subarray(8, 12),
    ...source.rgba.subarray(12, 16),
    ...source.rgba.subarray(12, 16),
  ]);
  expect(resized).toEqual({
    width: 4,
    height: 4,
    rgba: expected,
  });
  expect(resizeNearestPixels(source, 1, 1).rgba).toEqual(
    Buffer.from([
      11,
      22,
      33,
      44,
    ]),
  );
  expect(resizeNearestPixels(source, 3, 1).rgba).toEqual(
    Buffer.from([
      0,
      0,
      255,
      0,
      11,
      22,
      33,
      44,
      11,
      22,
      33,
      44,
    ]),
  );
  resized.rgba.fill(0);
  expect(source.rgba).toEqual(original);
  expect(resizeNearestPixels(source, 2, 2).rgba).toEqual(original);
});

test("nearest rejects empty sources and invalid or oversized output before allocation", () => {
  const invalidSizes: Array<
    [
      number,
      number,
    ]
  > = [
    [
      0,
      1,
    ],
    [
      1,
      0,
    ],
    [
      1.5,
      1,
    ],
    [
      1,
      Number.NaN,
    ],
    [
      4097,
      1,
    ],
    [
      512,
      512,
    ],
  ];
  for (const [width, height] of invalidSizes) {
    expect(() => resizeNearestPixels(source, width, height)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  expect(() =>
    resizeNearestPixels(
      {
        width: 0,
        height: 0,
        rgba: Buffer.alloc(0),
      },
      1,
      1,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});
