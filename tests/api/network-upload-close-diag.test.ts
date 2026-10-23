import { afterAll, beforeAll, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadInputSchema } from "#plugins/network/src/contract";
import {
  dispose,
  initialize,
  runCancelUpload,
  runUpload,
  runUploadStatus,
} from "#plugins/network/src/platforms/shared";
import { deadline } from "../fixtures/deadlines";

// DIAG: temporary measurement of how long the server side takes to see a cancelled upload close.
setDefaultTimeout(deadline("build") * 6);

const BYTES = 8 * 1024 * 1024;
const ROUNDS = 12;
const GIVE_UP_MS = 15_000;
let folder: string;
let file: string;
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "bunaway-close-diag-"));
  file = join(folder, "body.bin");
  writeFileSync(file, Buffer.alloc(BYTES));
});
afterAll(() => {
  rmSync(folder, {
    recursive: true,
    force: true,
  });
});

type Sink = {
  port: number;
  closedAt: () => number | undefined;
  received: () => number;
  stop: () => void;
};

/** Plain socket server that reads freely and notes when its connection closes. */
function makeSink(mode: "free" | "paused" = "free"): Sink & {
  resume: () => void;
} {
  let closed: number | undefined;
  let held:
    | {
        resume(): void;
      }
    | undefined;
  let received = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        received += chunk.byteLength;
        if (mode === "paused") {
          held = socket;
          socket.pause();
        }
      },
      close() {
        closed = performance.now();
      },
      error(_socket, error) {
        console.log(`DIAG sink error ${error.message}`);
      },
    },
  });
  return {
    port: listener.port,
    closedAt: () => closed,
    received: () => received,
    stop: () => listener.stop(true),
    resume: () => held?.resume(),
  };
}

async function waitClosed(sink: Sink) {
  const start = performance.now();
  while (sink.closedAt() === undefined) {
    if (performance.now() - start > GIVE_UP_MS) {
      return undefined;
    }
    await Bun.sleep(5);
  }
  return sink.closedAt();
}

function report(
  label: string,
  round: number,
  cancelAt: number,
  sink: Sink,
  closed: number | undefined,
  extra = "",
) {
  const delay =
    closed === undefined ? "NOT CLOSED" : (closed - cancelAt).toFixed(0);
  console.log(
    `DIAG ${process.platform} ${label} round=${round} closeDelayMs=${delay} received=${sink.received()} ${extra}`,
  );
}

test("DIAG plugin upload cancel", async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const state = initialize();
    const sink = makeSink();
    const request = uploadInputSchema.parse({
      uploadId: crypto.randomUUID(),
      url: `http://127.0.0.1:${sink.port}/`,
      path: file,
    });
    const pending = runUpload(state, "app", request).catch(() => undefined);
    while (runUploadStatus(state, "app", request).sentBytes === 0) {
      await Bun.sleep(1);
    }
    const sent = runUploadStatus(state, "app", request).sentBytes;
    const cancelAt = performance.now();
    await runCancelUpload(state, "app", request);
    const cancelReturned = performance.now() - cancelAt;
    await pending;
    const settled = performance.now() - cancelAt;
    const closed = await waitClosed(sink);
    report(
      "plugin",
      round,
      cancelAt,
      sink,
      closed,
      `sentAtCancel=${sent} cancelReturnedMs=${cancelReturned.toFixed(0)} settledMs=${settled.toFixed(0)}`,
    );
    sink.stop();
    await dispose(state);
  }
});

test("DIAG raw fetch with file stream body abort", async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const sink = makeSink();
    const handle = await open(file, "r");
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = new Uint8Array(64 * 1024);
        const { bytesRead } = await handle.read(
          chunk,
          0,
          chunk.byteLength,
          sent,
        );
        sent += bytesRead;
        controller.enqueue(chunk.subarray(0, bytesRead));
      },
    });
    const controller = new AbortController();
    const done = fetch(`http://127.0.0.1:${sink.port}/`, {
      method: "PUT",
      headers: [
        [
          "content-length",
          String(BYTES),
        ],
      ],
      body,
      signal: controller.signal,
    }).catch(() => undefined);
    while (sent === 0) {
      await Bun.sleep(1);
    }
    const cancelAt = performance.now();
    controller.abort();
    await done;
    const closed = await waitClosed(sink);
    report(
      "raw-stream",
      round,
      cancelAt,
      sink,
      closed,
      `sentAtCancel=${sent} settledMs=${(performance.now() - cancelAt).toFixed(0)}`,
    );
    sink.stop();
    await handle.close();
  }
});

test("DIAG raw fetch with buffer body abort", async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const sink = makeSink();
    const controller = new AbortController();
    const done = fetch(`http://127.0.0.1:${sink.port}/`, {
      method: "PUT",
      body: Buffer.alloc(BYTES),
      signal: controller.signal,
    }).catch(() => undefined);
    while (sink.received() === 0) {
      await Bun.sleep(1);
    }
    const cancelAt = performance.now();
    controller.abort();
    await done;
    const closed = await waitClosed(sink);
    report(
      "raw-buffer",
      round,
      cancelAt,
      sink,
      closed,
      `settledMs=${(performance.now() - cancelAt).toFixed(0)}`,
    );
    sink.stop();
  }
});

for (const resume of [
  false,
  true,
]) {
  test(`DIAG plugin upload cancel against a paused server resume=${resume}`, async () => {
    for (let round = 0; round < 6; round += 1) {
      const state = initialize();
      const sink = makeSink("paused");
      const request = uploadInputSchema.parse({
        uploadId: crypto.randomUUID(),
        url: `http://127.0.0.1:${sink.port}/`,
        path: file,
      });
      const pending = runUpload(state, "app", request).catch(() => undefined);
      while (sink.received() === 0) {
        await Bun.sleep(1);
      }
      await Bun.sleep(200);
      const sent = runUploadStatus(state, "app", request).sentBytes;
      const cancelAt = performance.now();
      await runCancelUpload(state, "app", request);
      await pending;
      const settled = performance.now() - cancelAt;
      if (resume) {
        sink.resume();
      }
      const closed = await waitClosed(sink);
      report(
        `paused-resume=${resume}`,
        round,
        cancelAt,
        sink,
        closed,
        `sentAtCancel=${sent} settledMs=${settled.toFixed(0)}`,
      );
      sink.resume();
      sink.stop();
      await dispose(state);
    }
  });
}
