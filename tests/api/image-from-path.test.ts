import { expect, test } from "bun:test";
import { defineNativePlugin } from "@bunaway/plugin";
import image from "@bunaway/plugin-image";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { z } from "zod";
import {
  createFromPathSchema,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_SOURCE_PATH_LENGTH,
} from "#plugins/image/src/contract";
import { validateImageInput } from "#plugins/image/src/operations";
import type { ImageCodec } from "#plugins/image/src/platforms/codec";
import { ImagePlatform } from "#plugins/image/src/platforms/image-platform";
import { fitWithin } from "#plugins/image/src/platforms/resize";

const emptyPolicy: Policy = {
  version: 1,
  views: [],
  backend: {
    permissions: [],
  },
};

test("createFromPath accepts only a local drive path made of valid file names", () => {
  for (const path of [
    "C:\\Users\\app\\photo.png",
    "d:/images/a.jpg",
    `C:\\${"a".repeat(100)}\\${"a".repeat(MAX_SOURCE_PATH_LENGTH - 3 - 101)}`,
  ]) {
    expect(
      createFromPathSchema.safeParse({
        path,
      }).success,
    ).toBe(true);
  }
  for (const path of [
    "",
    "photo.png",
    "\\photo.png",
    "\\\\server\\share\\photo.png",
    "\\\\?\\C:\\photo.png",
    "\\\\.\\C:\\photo.png",
    "C:photo.png",
    "C:\\",
    "C:\\dir\\",
    "C:\\dir\\..\\photo.png",
    "C:\\dir\\.\\photo.png",
    "C:\\dir\\\\photo.png",
    "C:\\dir\\CON",
    "C:\\dir\\nul.png",
    "C:\\dir\\photo.png:stream",
    "C:\\dir\\photo.png.",
    "C:\\dir\\pho?to.png",
    "C:\\dir\\photo\0.png",
    `C:\\${"a".repeat(100)}\\${"a".repeat(MAX_SOURCE_PATH_LENGTH - 2 - 101)}`,
  ]) {
    expect(
      createFromPathSchema.safeParse({
        path,
      }).success,
    ).toBe(false);
  }
});

test("createFromPath bounds maxDimension to a positive integer within the image limit", () => {
  const path = "C:\\photo.png";
  for (const maxDimension of [
    1,
    64,
    MAX_IMAGE_DIMENSION,
  ]) {
    expect(
      validateImageInput("image.createFromPath", {
        path,
        maxDimension,
      }),
    ).toEqual({
      path,
      maxDimension,
    });
  }
  for (const maxDimension of [
    0,
    -1,
    1.5,
    MAX_IMAGE_DIMENSION + 1,
    "64",
  ]) {
    expect(() =>
      validateImageInput("image.createFromPath", {
        path,
        maxDimension,
      }),
    ).toThrow("Invalid image input.");
  }
  expect(() =>
    validateImageInput("image.createFromPath", {
      path,
      extra: true,
    }),
  ).toThrow("Invalid image input.");
  expect(
    validateImageInput("image.createFromPath", {
      path,
    }),
  ).toEqual({
    path,
  });
});

test("fitWithin keeps the aspect ratio, never enlarges and respects the resource pixel limit", () => {
  expect(fitWithin(10, 10, 4096)).toEqual({
    width: 10,
    height: 10,
  });
  expect(fitWithin(300, 200, 64)).toEqual({
    width: 64,
    height: 42,
  });
  expect(fitWithin(200, 300, 64)).toEqual({
    width: 42,
    height: 64,
  });
  // 5000x2000 at the default edge limit still exceeds 512 KiB of pixels.
  const large = fitWithin(5000, 2000, MAX_IMAGE_DIMENSION);
  expect(large.width * large.height * 4).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  expect(large.width / large.height).toBeCloseTo(2.5, 1);
  // A very thin source keeps at least one pixel on the short edge.
  expect(fitWithin(16_384, 1, MAX_IMAGE_DIMENSION)).toEqual({
    width: 4096,
    height: 1,
  });
  expect(fitWithin(1, 16_384, 64)).toEqual({
    width: 1,
    height: 64,
  });
});

test("createFromPath is rejected when the codec cannot decode files", () => {
  const codec = {
    dispose() {},
  } as unknown as ImageCodec;
  const platform = new ImagePlatform(codec);
  try {
    expect(() =>
      platform.createFromPath({
        path: "C:\\photo.png",
      }),
    ).toThrow("Image files are not supported on this platform.");
  } finally {
    platform.dispose();
  }
});

test("policy validation refuses a view grant of a backend-only operation but allows the backend", () => {
  const registry = new NativeRegistry([
    image._definition,
  ]);
  expect(
    image._definition.native.operations.find(
      (operation) => operation.name === "image.createFromPath",
    ),
  ).toEqual({
    name: "image.createFromPath",
    backendOnly: true,
  });
  expect(
    image._definition.native.operations.find(
      (operation) => operation.name === "image.createBytes",
    ),
  ).toEqual({
    name: "image.createBytes",
  });
  expect(() =>
    registry.validatePolicy({
      ...emptyPolicy,
      backend: {
        permissions: [
          "image.createFromPath",
        ],
      },
    }),
  ).not.toThrow();
  const view = (permissions: string[], commands: string[] = []) => ({
    ...emptyPolicy,
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands,
        events: [],
        host: {
          permissions,
        },
      },
    ],
  });
  expect(() =>
    registry.validatePolicy(
      view([
        "image.createBytes",
      ]),
    ),
  ).not.toThrow();
  expect(() =>
    registry.validatePolicy(
      view([
        "image.createFromPath",
      ]),
    ),
  ).toThrow("backend-only operation");
  // The generated view command is refused as well, whether or not a host grant accompanies it.
  expect(() =>
    registry.validatePolicy(
      view(
        [],
        [
          "plugin.image.createFromPath",
        ],
      ),
    ),
  ).toThrow("backend-only operation");
  expect(() =>
    registry.validatePolicy(
      view(
        [
          "image.createBytes",
        ],
        [
          "plugin.image.createBytes",
        ],
      ),
    ),
  ).not.toThrow();
});

test("a plugin declares backendOnly only as true", () => {
  const declare = (backendOnly: unknown) =>
    defineNativePlugin({
      name: "probe",
      operations: {
        read: {
          input: z.unknown(),
          output: z.unknown(),
          backendOnly,
        } as never,
      },
    });
  expect(declare(true)._definition.native.operations).toEqual([
    {
      name: "probe.read",
      backendOnly: true,
    },
  ]);
  expect(() => declare(false)).toThrow("backendOnly must be true");
});
