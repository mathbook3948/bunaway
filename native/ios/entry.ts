import { createReadStream, createWriteStream } from "node:fs";
import { Worker } from "node:worker_threads";
import { API_LIMITS, parseProcessFrame } from "@bunaway/protocol";
import { readJsonLines } from "@bunaway/runtime-bun";

const MAX_FILE_DESCRIPTOR = 2_147_483_647;
const descriptors = process.argv.slice(2);
if (
  descriptors.length !== 2 ||
  descriptors.some(
    (value) => !/^\d+$/.test(value) || Number(value) > MAX_FILE_DESCRIPTOR,
  )
) {
  throw new Error("iOS entry requires two control pipe descriptors.");
}
const input = createReadStream("", {
  fd: Number(descriptors[0]),
  autoClose: true,
});
const output = createWriteStream("", {
  fd: Number(descriptors[1]),
  autoClose: true,
});
// Entry owns both control ends. Process stdio stays available to Swift and native SDK logs.
// Uncaught Worker/control errors are fatal because embedded Bun cannot be restarted.
let worker: Worker | undefined;
let exited: Promise<number> | undefined;
let consumed: (() => void) | undefined;
let failed: ((error: Error) => void) | undefined;
let writer = Promise.resolve();
let shutdownRequested = false;

for await (const line of readJsonLines(input)) {
  const frame = parseProcessFrame(line);
  if (frame.kind === "boot") {
    if (worker) {
      throw new Error(
        "Stop the iOS backend before starting another generation.",
      );
    }
    await exited;
    worker = new Worker(new URL("./backend.js", import.meta.url), {
      workerData: frame.runtime,
      stdout: true,
    });
    const current = worker;
    // Keep backend logs on the diagnostic stream, separate from the owned control descriptor.
    current.stdout?.pipe(process.stderr, {
      end: false,
    });
    shutdownRequested = false;
    exited = new Promise((resolve) =>
      current.once("exit", (code) => {
        if (!shutdownRequested || code !== 0) {
          throw new Error(`iOS backend exited unexpectedly (${code}).`);
        }
        resolve(code);
      }),
    );
    current.on("error", (error) => {
      throw error;
    });
    current.on("message", (message: unknown) => {
      if (message === "consumed") {
        consumed?.();
      } else if (typeof message === "string") {
        const packet = parseProcessFrame(message);
        if (
          packet.runtime.id !== frame.runtime.id ||
          packet.runtime.generation !== frame.runtime.generation
        ) {
          throw new Error("Stale iOS backend output.");
        }
        // Acknowledge only after the pipe write, so a slow UIKit reader bounds Worker output.
        writer = writer.then(
          () =>
            new Promise<void>((resolve, reject) => {
              output.write(`${message}\n`, (error) => {
                if (error) {
                  reject(error);
                  return;
                }
                current.postMessage("written");
                resolve();
              });
            }),
        );
        void writer.catch((error: Error) => {
          failed?.(error);
          throw error;
        });
      } else {
        throw new Error("Invalid iOS backend output.");
      }
    });
  }
  if (!worker) {
    throw new Error("iOS backend boot required.");
  }
  const current = worker;
  if (frame.kind === "shutdown") {
    // The host authorizes shutdown before delivery; no message/exit ordering assumption is needed.
    shutdownRequested = true;
  }
  // Apply the handshake deadline to input delivery, independent of shutdown cleanup.
  // Read the next host frame only after the Worker accepts this one into its input stream.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("iOS backend input timed out.")),
      API_LIMITS.handshakeTimeoutMs,
    );
    consumed = () => {
      clearTimeout(timer);
      resolve();
    };
    failed = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    current.postMessage(line);
  });
  consumed = undefined;
  failed = undefined;
  if (frame.kind === "shutdown") {
    // Wait for disposal and thread exit before accepting a replacement boot.
    await exited;
    worker = undefined;
  }
}
throw new Error("iOS host control pipe closed.");
