import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { Channel, type Packet } from "../../native/windows/bun/channel.ts";
import { API_LIMITS, type HostContext } from "../../packages/protocol/src/index.ts";

test.skipIf(process.platform !== "win32")(
  "oversized Web strings do not poison COM callbacks",
  async () => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", resolve(import.meta.dir, "windows-bun-com.ts")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited, await errors).toBe(0);
    expect(await output).toContain("PASS oversized native string rejected");
  },
);

test.skipIf(process.platform !== "win32")(
  "view profile names preserve case-sensitive identities on Windows",
  async () => {
    const { viewDirName } = await import("../../native/windows/bun/webview.ts");
    const names = [
      "main",
      "Main",
      "MAIN",
      "mAin",
      "..",
      "-2e-2e",
      "-3a",
      "con",
      "nul",
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-",
    ].map(viewDirName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^v[a-z0-9-]+$/);
  },
);

test.skipIf(process.platform !== "win32")(
  "I/O cancellation prevents queued work; a started write is not rolled back",
  async () => {
    const dataRoot = resolve(
      import.meta.dir,
      `../../build/windows-bun-io-${process.pid}-${crypto.randomUUID()}`,
    );
    const runtime = { id: "io-test", generation: "1" };
    const context = "backend-test" as HostContext;
    const worker = new Worker(
      new URL("../../native/windows/bun/host-operations.ts", import.meta.url),
      { workerData: { runtime, dataRoot } },
    );
    const prepares: Extract<Packet, { kind: "prepare" }>[] = [];
    const replies: Extract<Packet, { kind: "host-result" | "host-response" }>[] = [];
    let cleaned = false;
    let failure: unknown;
    const exited = new Promise<number>((done) => worker.once("exit", done));
    worker.on("error", (error) => {
      failure = error;
    });
    const channel = new Channel(
      worker,
      runtime,
      "main-io",
      (packet) => {
        if (packet.kind === "prepare") prepares.push(packet);
        else if (packet.kind === "host-response") replies.push(packet);
        else if (packet.kind === "cleaned") cleaned = true;
        else throw new Error("Unexpected I/O response");
      },
      (error) => {
        failure = error;
      },
    );
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!condition()) {
        if (failure) throw failure;
        if (Date.now() > deadline) throw new Error("I/O test timeout");
        await Bun.sleep(1);
      }
    };
    const operation = (id: string) =>
      channel.send({
        kind: "operation",
        requestId: id,
        context,
        source: "backend",
        call: {
          operation: "storage.writeText",
          payload: { scope: "temp", path: `${id}.txt`, text: "written" },
        },
      });
    try {
      await operation("waiting");
      await operation("queued");
      await waitFor(() => prepares.length === 1);
      await channel.send({ kind: "cancel", requestId: "queued", context });
      await channel.send({ kind: "cancel", requestId: "waiting", context });
      await channel.send({ kind: "grant", requestId: "waiting", context, allowed: true });
      await operation("started");
      await waitFor(() => prepares.length === 2);
      expect(prepares.map((packet) => packet.requestId)).toEqual(["waiting", "started"]);
      await channel.send({ kind: "grant", requestId: "started", context, allowed: true });
      await channel.send({ kind: "cancel", requestId: "started", context });
      await waitFor(() => replies.length === 1);
      expect(replies[0]?.response.kind).toBe("result");
      expect(existsSync(resolve(dataRoot, "temp/queued.txt"))).toBe(false);
      expect(existsSync(resolve(dataRoot, "temp/waiting.txt"))).toBe(false);
      expect(await readFile(resolve(dataRoot, "temp/started.txt"), "utf8")).toBe("written");
      const batch = Array.from({ length: API_LIMITS.maxPending }, (_, index) => `batch-${index}`);
      await Promise.all(batch.map(operation));
      await Promise.all(
        batch.map((requestId) => channel.send({ kind: "cancel", requestId, context })),
      );
      // Late approvals must not write any of the cancelled files.
      await Promise.all(
        batch.map((requestId) =>
          channel.send({ kind: "grant", requestId, context, allowed: true }),
        ),
      );
      for (const id of batch) expect(existsSync(resolve(dataRoot, `temp/${id}.txt`))).toBe(false);
      expect(replies).toHaveLength(1);
      for (const [id, text] of [
        ["oversized", "a".repeat(1048576)],
        ["escaped", "\u0001".repeat(200000)],
        ["ordinary", "ordinary read"],
      ] as const) {
        await writeFile(resolve(dataRoot, `temp/${id}.txt`), text);
        const prior = prepares.length;
        const completed = replies.length;
        await channel.send({
          kind: "operation",
          requestId: id,
          context,
          source: "backend",
          call: { operation: "storage.readText", payload: { scope: "temp", path: `${id}.txt` } },
        });
        await waitFor(() => prepares.length === prior + 1);
        await channel.send({ kind: "grant", requestId: id, context, allowed: true });
        await waitFor(() => replies.length === completed + 1);
        const response = replies.at(-1)?.response;
        if (id === "ordinary") expect(response).toEqual({ kind: "result", payload: text });
        else expect(response?.kind === "error" && response.error.code).toBe("INTERNAL");
      }
    } finally {
      await channel.send({ kind: "shutdown" });
      expect(await exited).toBe(0);
      expect(cleaned).toBe(true);
      channel.close();
    }
    expect(failure).toBeUndefined();
  },
  15000,
);
