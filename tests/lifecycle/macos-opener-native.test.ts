import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { JsonValue } from "@bunaway/protocol";
import { createReceiver } from "../fixtures/macos-opener-receiver-app.ts";

const isolated =
  process.platform === "darwin" && process.env.BUNAWAY_OPENER_ISOLATED === "1";
test.skipIf(!isolated)(
  "real I/O Worker NSWorkspace delivers a controlled file and accepts loopback HTTP/HTTPS requests",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-opener-native-")),
    );
    let receiver: Awaited<ReturnType<typeof createReceiver>> | undefined;
    let worker: Worker | undefined;
    try {
      receiver = await createReceiver(root);
      worker = new Worker(
        new URL("../fixtures/macos-opener-worker.ts", import.meta.url),
      );
      let nextId = 0;
      const request = (
        operation: string,
        payload: JsonValue,
        permissions = [
          operation,
        ],
        cancelled = false,
      ) =>
        new Promise<{
          id: number;
          result?: null;
          error?: string;
          message?: string;
        }>((resolveRequest, reject) => {
          const requestId = ++nextId;
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Native fixture dispatch timed out."));
          }, 15000);
          const receive = (reply: {
            id: number;
            result?: null;
            error?: string;
            message?: string;
          }) => {
            if (reply.id === requestId) {
              cleanup();
              resolveRequest(reply);
            }
          };
          const cleanup = () => {
            clearTimeout(timer);
            worker?.off("message", receive);
            worker?.off("error", rejectWorker);
          };
          const rejectWorker = (error: Error) => {
            cleanup();
            reject(error);
          };
          worker?.on("message", receive);
          worker?.once("error", rejectWorker);
          worker?.postMessage({
            id: requestId,
            operation,
            payload,
            permissions,
            cancelled,
          });
        });
      expect(
        await request(
          "opener.openFile",
          {
            path: receiver.sample,
          },
          [],
        ),
      ).toMatchObject({
        error: "PERMISSION_DENIED",
      });
      expect(
        await request(
          "opener.openUrl",
          {
            url: "http://127.0.0.1/cancelled",
          },
          [
            "opener.openUrl",
          ],
          true,
        ),
      ).toMatchObject({
        error: "CANCELLED",
      });
      expect(
        await request("opener.openFile", {
          path: receiver.sample,
        }),
      ).toMatchObject({
        result: null,
      });
      await receiver.waitFor(
        (event) =>
          (event.kind === "file" && event.target === receiver?.sample) ||
          (event.kind === "url" &&
            event.target.startsWith("file:") &&
            fileURLToPath(event.target) === receiver?.sample),
      );
      for (const scheme of [
        "http",
        "https",
      ]) {
        const url = new URL(
          `${scheme}://127.0.0.1:43210/한글 값?q=one&second=two#quote"`,
        ).href;
        expect(
          await request("opener.openUrl", {
            url,
          }),
        ).toMatchObject({
          result: null,
        });
      }
      expect(
        await request(
          "opener.revealFile",
          {
            path: receiver.sample,
          },
          [
            "opener.openFile",
          ],
        ),
      ).toMatchObject({
        error: "PERMISSION_DENIED",
      });
      expect(
        await request("opener.revealFile", {
          path: receiver.sample,
        }),
      ).toMatchObject({
        result: null,
      });
      expect(
        await request("opener.openFileWith", {
          path: receiver.sample,
          app: "C:/app.exe",
        }),
      ).toMatchObject({
        error: "UNSUPPORTED",
      });
      expect(await request("dispose", null)).toMatchObject({
        result: null,
      });
      const events = await receiver.readEvents();
      expect(events.some((event) => event.target.includes("/cancelled"))).toBe(
        false,
      );
      await mkdir("build", {
        recursive: true,
      });
      await writeFile(
        "build/macos-opener-results.json",
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            bun: Bun.version,
            revision: Bun.revision,
            execution: "isolated I/O Worker fixture",
            events,
            urls: "Native acceptance for loopback HTTP/HTTPS; page loading not inspected",
            reveal:
              "NSWorkspace request acceptance; selection UI not inspected",
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        await worker?.terminate();
      } finally {
        try {
          await receiver?.dispose();
        } finally {
          await rm(root, {
            recursive: true,
            force: true,
          });
        }
      }
    }
  },
  120000,
);
