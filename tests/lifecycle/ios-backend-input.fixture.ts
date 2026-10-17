import { mock } from "bun:test";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { parentPort } from "node:worker_threads";
import { plugin } from "bun";

// runBunApp owns input destruction. Hold cleanup open to exercise a late host frame.
mock.module("@bunaway/runtime-bun", () => ({
  runBunApp: async (
    _app: unknown,
    {
      input,
    }: {
      input: Readable;
    },
  ) => {
    input.destroy();
    parentPort?.postMessage("input-closed");
    await new Promise(() => {});
  },
}));
await plugin({
  name: "ios-fixture-app",
  setup(build) {
    build.onResolve(
      {
        filter: /^bunaway-generated\/app-metadata\.ts$/,
      },
      () => ({
        path: resolve(import.meta.dir, "../fixtures/app-info.ts"),
      }),
    );
    build.onResolve(
      {
        filter: /^\.\/app\.js$/,
      },
      () => ({
        path: resolve(import.meta.dir, "../fixtures/ios/app.ts"),
      }),
    );
  },
});
await import("../../native/ios/backend.ts");
