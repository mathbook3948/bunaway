import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { win32 } from "node:path";

export type LaunchArguments = {
  argv: string[];
  cwd: string;
};
const MAX_BYTES = 64 * 1024;
const MAX_PENDING = 32;

/** Derives the per-app named pipe from the canonical data directory. */
export function instanceAddress(dataRoot: string): string {
  const id = createHash("sha256")
    .update(realpathSync(dataRoot).toLowerCase())
    .digest("hex");
  return `\\\\.\\pipe\\bunaway-${id}`;
}

/**
 * Validates and copies pipe input.
 * Throws for malformed or oversized launch data.
 */
export function parseLaunchArguments(value: unknown): LaunchArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid launch arguments");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    !Array.isArray(input.argv) ||
    input.argv.length > 256 ||
    input.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    typeof input.cwd !== "string" ||
    !win32.isAbsolute(input.cwd) ||
    win32.parse(input.cwd).root.length < 3 ||
    input.cwd.includes("\0") ||
    Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES
  ) {
    throw new Error("Invalid launch arguments");
  }
  return {
    argv: [
      ...input.argv,
    ],
    cwd: input.cwd,
  };
}

/**
 * Binds the single-instance pipe and buffers launches until the host is ready.
 * Acknowledgements confirm queueing only. Bind errors reject.
 * Closing drops queued work and connected clients.
 */
export async function listenForInstances(address: string) {
  const queue: LaunchArguments[] = [];
  const sockets = new Set<Socket>();
  let handler: ((input: LaunchArguments) => void) | undefined;
  let closed = false;
  const server = createServer((socket) => {
    if (sockets.size >= MAX_PENDING) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timeout = setTimeout(() => socket.destroy(), 5000);
    socket.on("close", () => {
      clearTimeout(timeout);
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    const chunks: Buffer[] = [];
    let length = 0;
    let received = false;
    socket.on("data", (chunk: Buffer) => {
      if (received) {
        return;
      }
      length += chunk.length;
      if (length > MAX_BYTES + 1) {
        return socket.destroy();
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) {
        return;
      }
      const buffer = Buffer.concat(chunks, length);
      const end = buffer.indexOf(10);
      received = true;
      try {
        if (end !== buffer.length - 1 || queue.length >= MAX_PENDING) {
          throw new Error("Launch queue full or invalid framing");
        }
        const input = parseLaunchArguments(
          JSON.parse(buffer.subarray(0, end).toString("utf8")),
        );
        if (handler) {
          handler(input);
        } else {
          queue.push(input);
        }
        socket.end("accepted\n");
      } catch {
        socket.end("rejected\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    start(receive: (input: LaunchArguments) => void) {
      if (closed) {
        throw new Error("Instance inbox is closed");
      }
      handler = receive;
      for (const input of queue.splice(0)) {
        receive(input);
      }
    },
    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      handler = undefined;
      queue.length = 0;
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * Sends launch data to the owning host and waits for its queue acknowledgement.
 * Retries startup pipe races until the five-second deadline.
 * Rejects delivery failures, including timeout and invalid acknowledgements.
 */
export async function forwardToInstance(
  address: string,
  input: LaunchArguments,
): Promise<void> {
  const payload = `${JSON.stringify(parseLaunchArguments(input))}\n`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(address);
        let response = "";
        const timeout = setTimeout(
          () => {
            // Reject before closing so a pending Windows pipe write cannot replace the timeout.
            reject(new Error("Instance delivery timed out"));
            socket.destroy();
          },
          Math.max(0, deadline - Date.now()),
        );
        socket.on("close", () => {
          clearTimeout(timeout);
          reject(new Error("Instance closed before acknowledgement"));
        });
        socket.on("error", reject);
        socket.on("connect", () => socket.write(payload));
        socket.on("data", (chunk) => {
          response += chunk.toString();
          if (response.length > 32) {
            socket.destroy(new Error("Invalid instance acknowledgement"));
          }
        });
        socket.on("end", () => {
          socket.destroy();
          response === "accepted\n"
            ? resolve()
            : reject(new Error("Instance rejected launch request"));
        });
      });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        Date.now() >= deadline ||
        (code !== "ENOENT" && code !== "ECONNREFUSED")
      ) {
        throw error;
      }
      await Bun.sleep(25);
    }
  }
}
