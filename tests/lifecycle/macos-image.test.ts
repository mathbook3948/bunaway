import { test } from "bun:test";
import createOperationsDefinition from "#plugins/image/src/index";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

import { verifyMacosImage } from "../fixtures/macos-image.ts";
const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "macos",
);

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "real ImageIO/CoreGraphics codecs, transforms, quotas and cancellation own detached app resources",
  async () => {
    await verifyMacosImage(createOperations);
  },
  30000,
);
