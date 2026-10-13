import { expect, test } from "bun:test";
import { cropPixels } from "#plugins/image/src/crop";
import { ImageResources } from "#plugins/image/src/resources";

const source = {
  width: 3,
  height: 2,
  rgba: Buffer.from([
    1,
    2,
    3,
    0,
    4,
    5,
    6,
    128,
    7,
    8,
    9,
    255,
    10,
    11,
    12,
    255,
    13,
    14,
    15,
    64,
    16,
    17,
    18,
    255,
  ]),
};

test("crop copies offset rows and alpha without sharing or changing source pixels", () => {
  const cropped = cropPixels(source, {
    x: 1,
    y: 0,
    width: 2,
    height: 2,
  });
  expect(cropped).toEqual({
    width: 2,
    height: 2,
    rgba: Buffer.from([
      4,
      5,
      6,
      128,
      7,
      8,
      9,
      255,
      13,
      14,
      15,
      64,
      16,
      17,
      18,
      255,
    ]),
  });
  const all = cropPixels(source, {
    x: 0,
    y: 0,
    width: 3,
    height: 2,
  });
  expect(all.rgba).toEqual(source.rgba);
  all.rgba.fill(0);
  expect(source.rgba[0]).toBe(1);
  expect(
    cropPixels(source, {
      x: 2,
      y: 1,
      width: 1,
      height: 1,
    }).rgba,
  ).toEqual(
    Buffer.from([
      16,
      17,
      18,
      255,
    ]),
  );
});

test("crop rejects empty, fractional and out-of-bounds rectangles rather than clamping", () => {
  for (const rectangle of [
    {
      x: -1,
      y: 0,
      width: 1,
      height: 1,
    },
    {
      x: 0.5,
      y: 0,
      width: 1,
      height: 1,
    },
    {
      x: 0,
      y: 0,
      width: 0,
      height: 1,
    },
    {
      x: 2,
      y: 1,
      width: 2,
      height: 1,
    },
    {
      x: 0,
      y: 1,
      width: 1,
      height: 2,
    },
  ]) {
    expect(() => cropPixels(source, rectangle)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  expect(() =>
    cropPixels(
      {
        width: 0,
        height: 0,
        rgba: Buffer.alloc(0),
      },
      {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});

test("a transformed resource has its own ID and cancellation/disposal preserves the source", () => {
  const resources = new ImageResources();
  const original = resources.create(source);
  const controller = new AbortController();
  const transformed = resources.create(
    cropPixels(resources.get(original.id), {
      x: 1,
      y: 1,
      width: 2,
      height: 1,
    }),
    controller.signal,
  );
  expect(transformed.id).not.toBe(original.id);
  controller.abort();
  expect(() => resources.info(transformed.id)).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(resources.get(original.id).rgba).toEqual(source.rgba);
  resources.dispose();
});
