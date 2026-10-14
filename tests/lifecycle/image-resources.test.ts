import { expect, test } from "bun:test";
import { defineNativePlugin } from "@bunaway/plugin";
import { MAX_IMAGE_BYTES, MAX_RESOURCES } from "#plugins/image/src/contract";
import { imageOperations } from "#plugins/image/src/operations";
import { ImagePlatform } from "#plugins/image/src/platforms/image-platform";
import { ImageResources } from "#plugins/image/src/platforms/resources";

import { verifyMacosImage } from "../fixtures/macos-image.ts";

test("image IDs retain exact pixels and become unavailable after idempotent disposal or app shutdown", () => {
  const resources = new ImageResources();
  const rgba = Buffer.from([
    255,
    0,
    0,
    128,
  ]);
  const first = resources.create({
    width: 1,
    height: 1,
    rgba,
  });
  const empty = resources.create({
    width: 0,
    height: 0,
    rgba: Buffer.alloc(0),
  });
  expect(first).toEqual({
    id: first.id,
    width: 1,
    height: 1,
    empty: false,
  });
  expect(resources.get(first.id).rgba).toEqual(rgba);
  expect(resources.info(empty.id)).toEqual({
    width: 0,
    height: 0,
    empty: true,
  });
  expect(resources.remove(first.id)).toBe(true);
  expect(resources.remove(first.id)).toBe(false);
  expect(() => resources.get(first.id)).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  resources.dispose();
  resources.dispose();
  expect(() => resources.info(empty.id)).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(() =>
    resources.create({
      width: 0,
      height: 0,
      rgba: Buffer.alloc(0),
    }),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("creation cancellation discards undelivered images and releases their count and byte quota", () => {
  const resources = new ImageResources();
  const controller = new AbortController();
  const resource = resources.create(
    {
      width: 512,
      height: 256,
      rgba: Buffer.alloc(MAX_IMAGE_BYTES),
    },
    controller.signal,
  );
  controller.abort();
  expect(() => resources.get(resource.id)).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(() =>
    resources.create(
      {
        width: 0,
        height: 0,
        rgba: Buffer.alloc(0),
      },
      controller.signal,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  for (let count = 0; count < 16; count++) {
    resources.create({
      width: 512,
      height: 256,
      rgba: Buffer.alloc(MAX_IMAGE_BYTES),
    });
  }
  expect(() =>
    resources.create({
      width: 1,
      height: 1,
      rgba: Buffer.alloc(4),
    }),
  ).toThrow(
    expect.objectContaining({
      code: "BUSY",
    }),
  );
  resources.dispose();
});

test("empty resources still consume slots and disposal restores capacity without reusing identities", () => {
  const resources = new ImageResources();
  const ids = Array.from(
    {
      length: MAX_RESOURCES,
    },
    () =>
      resources.create({
        width: 0,
        height: 0,
        rgba: Buffer.alloc(0),
      }).id,
  );
  expect(new Set(ids).size).toBe(MAX_RESOURCES);
  expect(() =>
    resources.create({
      width: 0,
      height: 0,
      rgba: Buffer.alloc(0),
    }),
  ).toThrow(
    expect.objectContaining({
      code: "BUSY",
    }),
  );
  const oldId = ids[0] ?? "";
  expect(resources.remove(oldId)).toBe(true);
  expect(
    resources.create({
      width: 0,
      height: 0,
      rgba: Buffer.alloc(0),
    }).id,
  ).not.toBe(oldId);
  resources.dispose();
});

test("image probe validates direct calls, permissions and cancellation before native codec work", async () => {
  const codecReached = new Error("Native codec boundary reached.");
  let disposed = 0;
  const plugin = defineNativePlugin({
    name: "image",
    platforms: {
      macos: {
        initialize: () =>
          new ImagePlatform({
            decode() {
              throw new Error("Unexpected decode before encoding.");
            },
            encode() {
              throw codecReached;
            },
            resize() {
              throw new Error("Unexpected resize before encoding.");
            },
            dispose() {
              disposed++;
            },
          }),
        dispose: (instance: ImagePlatform) => instance.dispose(),
        operations: imageOperations,
      },
    },
  });
  // Run the shared installed/compiled probe on every OS up to its first real codec call.
  // A stale execution or permission assertion fails before this sentinel is reached.
  await expect(verifyMacosImage(plugin)).rejects.toBe(codecReached);
  expect(disposed).toBe(2);
});
