import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
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
const CONTENT = "uploaded through the generated adapter";
/** Larger than the socket buffers, so a server that does not read keeps the upload running. */
const HELD_BYTES = 16 * 1024 * 1024;
const root = mkdtempSync(join(tmpdir(), "bunaway-network-upload-"));
let received = "";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    if (new URL(request.url).pathname === "/held") {
      // Takes the first chunk and then waits until the client ends the request.
      await request.body?.getReader().read();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return new Response("late");
    }
    received = await request.text();
    return new Response("stored");
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
  "generated %s network adapter uploads a file and releases it on cancel and dispose",
  async (name, platform) => {
    assert(platform);
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
    const upload = (path: string, route: string) => {
      const uploadId = crypto.randomUUID();
      return {
        uploadId,
        promise: call("upload", {
          uploadId,
          url: `http://127.0.0.1:${server.port}${route}`,
          path,
        }),
      };
    };
    const outcomeOf = (pending: unknown) =>
      Promise.resolve(pending).then(
        () => "sent",
        (error: { code?: string }) => error.code,
      );
    const sentBytes = (uploadId: string) =>
      waitFor(
        async () => {
          const status = (await call("uploadStatus", {
            uploadId,
          })) as {
            sentBytes: number;
          };
          return status.sentBytes > 0 ? status : undefined;
        },
        {
          deadline: "childStep",
          what: "the first chunk of a held upload",
        },
      );
    try {
      const small = join(root, `${name}-small.txt`);
      writeFileSync(small, CONTENT);
      const sent = upload(small, "/ok");
      expect(await sent.promise).toMatchObject({
        status: 200,
        bytesSent: CONTENT.length,
      });
      expect(received).toBe(CONTENT);
      // The file can be deleted after the transfer.
      unlinkSync(small);
      expect(existsSync(small)).toBe(false);
      await expect(
        upload(join(root, `${name}-missing.txt`), "/ok").promise,
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      const large = join(root, `${name}-large.bin`);
      writeFileSync(large, Buffer.alloc(HELD_BYTES));
      const held = upload(large, "/held");
      const outcome = outcomeOf(held.promise);
      expect(await sentBytes(held.uploadId)).toMatchObject({
        totalBytes: HELD_BYTES,
      });
      expect(
        await call("cancelUpload", {
          uploadId: held.uploadId,
        }),
      ).toEqual({});
      expect(await outcome).toBe("CANCELLED");
      unlinkSync(large);
      await expect(
        call("uploadStatus", {
          uploadId: held.uploadId,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      // Disposing the adapter ends an upload that is still running and closes its file.
      writeFileSync(large, Buffer.alloc(HELD_BYTES));
      const pending = upload(large, "/held");
      const disposed = outcomeOf(pending.promise);
      await sentBytes(pending.uploadId);
      await adapter.dispose();
      expect(await disposed).toBe("CANCELLED");
      unlinkSync(large);
    } finally {
      await adapter.dispose();
    }
  },
);
