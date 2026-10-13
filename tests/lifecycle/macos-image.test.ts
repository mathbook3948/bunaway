import { test } from "bun:test";
import { createOperations } from "#plugins/image/src/platforms/macos";
import { verifyMacosImage } from "../fixtures/macos-image.ts";

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "real ImageIO/CoreGraphics codecs, transforms, quotas and cancellation own detached app resources",
  async () => {
    await verifyMacosImage(createOperations);
  },
  30000,
);
