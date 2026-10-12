import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { processPlugin } from "@bunaway/plugin-process/native/windows";
import type { JsonValue } from "@bunaway/protocol";
import { processOperations } from "#plugins/process/src/contract";

test.skipIf(process.platform !== "win32")(
  "generated Windows argv adapter handles completion, timeout, capacity and repeated disposal",
  async () => {
    const platform = processPlugin.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    const call = (input: JsonValue, signal?: AbortSignal) => {
      assert(adapter.executeUI);
      return adapter.executeUI("process.run", input, "view:test", {
        requestId: crypto.randomUUID(),
        permissions: {
          permissions: [
            "process.run",
          ],
        },
        ...(signal
          ? {
              signal,
            }
          : {}),
      });
    };
    try {
      const result = processOperations.run.output.parse(
        await call({
          executablePath: process.execPath,
          args: [
            "-e",
            'process.stdout.write("한글 😀"); process.exitCode = 23;',
          ],
        }),
      );
      expect(result.exitCode).toBe(23);
      expect(Buffer.from(result.stdoutBase64, "base64").toString()).toBe(
        "한글 😀",
      );
      await expect(
        call({
          executablePath: process.execPath,
          args: [
            "-e",
            "setInterval(() => {}, 1000)",
          ],
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      const pending = Array.from(
        {
          length: 8,
        },
        () =>
          call({
            executablePath: process.execPath,
            args: [
              "-e",
              "setInterval(() => {}, 1000)",
            ],
          }),
      );
      const observed = Promise.allSettled(pending);
      await Bun.sleep(50);
      await expect(
        call({
          executablePath: process.execPath,
          args: [
            "-e",
            "",
          ],
        }),
      ).rejects.toMatchObject({
        code: "BUSY",
      });
      await adapter.dispose();
      await adapter.dispose();
      expect(
        (await observed).every(
          (result) =>
            result.status === "rejected" && result.reason.code === "CANCELLED",
        ),
      ).toBe(true);
      await expect(
        call({
          executablePath: process.execPath,
        }),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
    } finally {
      await adapter.dispose();
    }
  },
);
