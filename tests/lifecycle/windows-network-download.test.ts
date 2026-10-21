import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import macosNetworkPlugin from "@bunaway/plugin-network/native/macos";
import windowsNetworkPlugin from "@bunaway/plugin-network/native/windows";
import type { JsonValue } from "@bunaway/protocol";
import { deadline, waitFor } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

const platforms = [
  [
    "windows",
    windowsNetworkPlugin._definition.nativePlatforms.windows,
  ],
  [
    "macos",
    macosNetworkPlugin._definition.nativePlatforms.macos,
  ],
] as const;
const BODY = "downloaded through the generated adapter";
const root = mkdtempSync(join(tmpdir(), "bunaway-network-download-"));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    if (new URL(request.url).pathname === "/stall") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }),
      );
    }
    return new Response(BODY);
  },
});
afterAll(() => {
  void server.stop(true);
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

test.each(platforms)(
  "generated %s network adapter saves, replaces and cancels downloads on the real file system",
  async (name, platform) => {
    assert(platform);
    const folder = join(root, name);
    mkdirSync(folder);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    assert(adapter.executeUI);
    const call = (operation: string, input: JsonValue) =>
      adapter.executeUI?.(`network.${operation}`, input, "view:test", {
        requestId: crypto.randomUUID(),
        permissions: {
          permissions: [
            `network.${operation}`,
          ],
        },
      });
    const download = (
      name: string,
      {
        route = "/file",
        ...extra
      }: {
        route?: string;
        overwrite?: boolean;
      } = {},
    ) => {
      const downloadId = crypto.randomUUID();
      return {
        downloadId,
        promise: call("download", {
          downloadId,
          url: `http://127.0.0.1:${server.port}${route}`,
          path: join(folder, name),
          maxBytes: 1024 * 1024,
          ...extra,
        }),
      };
    };
    const parts = () => readdirSync(folder).filter((n) => n.endsWith(".part"));
    try {
      const first = download("data.bin");
      expect(await first.promise).toMatchObject({
        status: 200,
        saved: true,
        bytesWritten: BODY.length,
      });
      expect(readFileSync(join(folder, "data.bin"), "utf8")).toBe(BODY);
      expect(parts()).toEqual([]);
      // The target exists: refused without overwrite, replaced with it, on this file system.
      writeFileSync(join(folder, "kept.bin"), "old");
      await expect(download("kept.bin").promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(readFileSync(join(folder, "kept.bin"), "utf8")).toBe("old");
      await download("kept.bin", {
        overwrite: true,
      }).promise;
      expect(readFileSync(join(folder, "kept.bin"), "utf8")).toBe(BODY);
      mkdirSync(join(folder, "directory"));
      await expect(
        download("directory", {
          overwrite: true,
        }).promise,
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(download("absent/data.bin").promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      // A running download reports progress, and cancelling removes its temporary file.
      const stalled = download("stalled.bin", {
        route: "/stall",
      });
      const outcome = Promise.resolve(stalled.promise).then(
        () => "saved",
        (error: { code?: string }) => error.code,
      );
      await waitFor(
        async () => {
          const status = (await call("downloadStatus", {
            downloadId: stalled.downloadId,
          })) as {
            receivedBytes: number;
          };
          return status.receivedBytes > 0 ? status : undefined;
        },
        {
          deadline: "childStep",
          what: "the first chunk of a stalled download",
        },
      );
      expect(
        await call("cancelDownload", {
          downloadId: stalled.downloadId,
        }),
      ).toEqual({});
      expect(await outcome).toBe("CANCELLED");
      expect(parts()).toEqual([]);
      expect(existsSync(join(folder, "stalled.bin"))).toBe(false);
      await expect(
        call("downloadStatus", {
          downloadId: stalled.downloadId,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    } finally {
      await adapter.dispose();
    }
  },
);
