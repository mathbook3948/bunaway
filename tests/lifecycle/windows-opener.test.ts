import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Channel } from "#native/windows/bun/channel";
import type { HostContext, HostResponse } from "@bunaway/protocol";
import { openerPlugin } from "@bunaway/plugin-opener";
import { bundleIOPluginFixture } from "../fixtures/native-worker.ts";

test.skipIf(process.platform !== "win32")(
  "Windows opener owns an I/O STA and validates pinned files",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-opener-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const workerPath = resolve(root, "probe.ts");
    const shellModule = pathToFileURL(
      resolve(import.meta.dir, "../../plugins/opener/src/shell.ts"),
    ).href;
    const operationsModule = resolve(
      import.meta.dir,
      "../../plugins/opener/src/windows.ts",
    );
    await Bun.write(
      workerPath,
      `import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { parentPort } from "node:worker_threads";
import { createShell } from ${JSON.stringify(shellModule)};
import { createOperations } from ${JSON.stringify(operationsModule)};
import { createFiles } from ${JSON.stringify(resolve("plugins/opener/src/windows-file.ts"))};
import { writeFileSync, mkdirSync, linkSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const sample = ${JSON.stringify(resolve(root, "한글 공백, 😀.txt"))};
writeFileSync(sample, "file content");
const files = createFiles();
try {
  files.withFile(sample, () => {
    assert.throws(() => unlinkSync(sample), "The file must remain pinned during request submission");
  });
  const hardlink = sample + ".link";
  linkSync(sample, hardlink);
  assert.throws(() => files.withFile(sample, () => assert.fail("Hardlink escaped checks")), (error) => error.code === "PERMISSION_DENIED");
  unlinkSync(hardlink);
  const directory = ${JSON.stringify(resolve(root, "folder"))};
  const junction = ${JSON.stringify(resolve(root, "alias"))};
  mkdirSync(directory);
  writeFileSync(join(directory, "file.txt"), "linked file");
  symlinkSync(directory, junction, "junction");
  assert.throws(() => files.withFile(join(junction, "file.txt"), () => assert.fail("Junction escaped checks")), (error) => error.code === "PERMISSION_DENIED");
  assert.throws(() => files.withFile(sample.replace(".txt", ".TXT"), () => assert.fail("Case alias escaped checks")), (error) => error.code === "PERMISSION_DENIED");
} finally { files.dispose(); files.dispose(); }
const ole = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoGetApartmentType: { args: ["ptr", "ptr"], returns: "i32" },
  CoUninitialize: { args: [], returns: "void" },
});
// No COM apartment is initialized yet, so a launch must fail without opening
// a browser. Repeating the failure exercises native cleanup on the error path.
const shell = createShell();
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(
      () => shell.open("https://example.com/"),
      (error) => error instanceof Error && "code" in error && error.code === "INTERNAL",
    );
  }
} finally {
  shell.dispose();
  shell.dispose();
}
assert.throws(
  () => shell.open("https://example.com/"),
  (error) => error instanceof Error && "code" in error && error.code === "CANCELLED",
);
const initialized = ole.symbols.CoInitializeEx(null, 0x2 | 0x4) >= 0;
try {
  assert(initialized);
  const apartment = new Uint32Array(1);
  const qualifier = new Uint32Array(1);
  assert.equal(ole.symbols.CoGetApartmentType(ptr(apartment), ptr(qualifier)), 0);
  assert([0, 3].includes(apartment[0]), "ShellExecute must run in an STA");

  const adapter = createOperations({ dataRoot: ".", capabilities: [] });
  try {
    for (const action of ["openFile", "revealFile"]) {
      const call = (path) => adapter.execute("opener." + action, { path }, "backend");
      const missing = sample + ".missing";
      assert.throws(() => call(missing), (error) => error.code === "INVALID_ARGUMENT" && error.details.reason === "FILE_NOT_FOUND");
      const directory = ${JSON.stringify(root)};
      assert.throws(() => call(directory), (error) => error.code === "INVALID_ARGUMENT");
      const lockApi = dlopen("kernel32.dll", {
        CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        CloseHandle: { args: ["u64"], returns: "i32" },
      });
      const lock = lockApi.symbols.CreateFileW(ptr(Buffer.from(sample + "\\0", "utf16le")), 0x80000000, 0, null, 3, 0, 0n);
      assert.notEqual(lock, 0xffffffffffffffffn);
      try {
        assert.throws(() => call(sample), (error) => error.code === "PERMISSION_DENIED");
      } finally { lockApi.symbols.CloseHandle(lock); lockApi.close(); }
    }
    assert.throws(
      () => adapter.execute("opener.openUrl", { url: "file:///C:/secret.txt" }, "backend"),
      (error) => error instanceof Error && "code" in error && error.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => adapter.execute("opener.missing", { url: "https://example.com/" }, "backend"),
      (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED",
    );
    assert.throws(
      () => adapter.execute("opener.openUrl", { url: 42 }, "backend"),
      (error) => error instanceof Error && "code" in error && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    await adapter.dispose();
    await adapter.dispose();
  }
  assert.throws(
    () => adapter.execute("opener.openUrl", { url: "https://example.com/" }, "backend"),
    (error) => error instanceof Error && "code" in error && error.code === "CANCELLED",
  );
} finally {
  if (initialized) {
    ole.symbols.CoUninitialize();
  }
  ole.close();
}
parentPort?.postMessage("passed");
parentPort?.close();
`,
    );

    const worker = new Worker(pathToFileURL(workerPath));
    let result: unknown;
    let failure: unknown;
    let exitCode: number | undefined;
    const exited = new Promise<number>((resolveExit) => {
      worker.once("exit", (code) => {
        exitCode = code;
        resolveExit(code);
      });
    });
    worker.once("message", (message) => {
      result = message;
    });
    worker.once("error", (error) => {
      failure = error;
    });
    const timeout = setTimeout(() => {
      failure = new Error("Windows opener probe timed out.");
      void worker.terminate();
    }, 15000);
    try {
      await exited;
      expect(exitCode).toBe(0);
      expect(failure).toBeUndefined();
      expect(result).toBe("passed");
    } finally {
      clearTimeout(timeout);
      if (exitCode === undefined) {
        await worker.terminate();
      }
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  20000,
);

test.skipIf(process.platform !== "win32")(
  "Windows I/O Worker owns the opener STA and rejects unapproved and cancelled work",
  async () => {
    const dataRoot = resolve(
      import.meta.dir,
      `../../build/windows-opener-io-${crypto.randomUUID()}`,
    );
    await mkdir(dataRoot, {
      recursive: true,
    });
    const operationsModule = resolve(
      import.meta.dir,
      "../../plugins/opener/src/windows.ts",
    );
    const disposedPath = resolve(dataRoot, "opener-disposed.txt");
    await bundleIOPluginFixture(
      dataRoot,
      [
        {
          name: "opener",
          version: openerPlugin.version,
          native: openerPlugin.native,
          execution: "io",
          authorization: true,
        },
      ],
      `import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { writeFileSync } from "node:fs";
const ole = dlopen("ole32.dll", {
  CoGetApartmentType: { args: ["ptr", "ptr"], returns: "i32" },
});
const apartment = new Uint32Array(1);
const qualifier = new Uint32Array(1);
const apartmentType = () => ole.symbols.CoGetApartmentType(ptr(apartment), ptr(qualifier));
export const pluginImports = { opener: {
  authorization: async () => ({ matches: () => false }),
  operations: async () => {
    const { createOperations } = await import(${JSON.stringify(operationsModule)});
    return { createOperations(environment) {
      assert(apartmentType() < 0, "I/O worker must start without COM initialization");
      const adapter = createOperations(environment);
      assert.equal(apartmentType(), 0);
      assert([0, 3].includes(apartment[0]), "Opener must own an STA");
      return { ...adapter, dispose() {
        adapter.dispose();
        adapter.dispose();
        assert(apartmentType() < 0, "Disposal must balance the adapter's COM initialization");
        writeFileSync(${JSON.stringify(disposedPath)}, "STA");
        ole.close();
      }};
    }};
  },
}};
`,
    );
    const runtime = {
      id: `opener-${crypto.randomUUID()}`,
      generation: "1",
    };
    const context = "backend" as HostContext;
    const worker = new Worker(
      pathToFileURL(resolve(dataRoot, "host-operations.js")),
      {
        workerData: {
          runtime,
          dataRoot,
          assets: dataRoot,
          plugins: [
            {
              name: openerPlugin.name,
              version: openerPlugin.version,
              native: openerPlugin.native,
            },
          ],
        },
      },
    );
    let failure: unknown;
    let exitCode: number | undefined;
    let ready = false;
    let cleaned = false;
    const prepares: string[] = [];
    const replies = new Map<string, HostResponse>();
    const exited = new Promise<number>((done) =>
      worker.once("exit", (code) => {
        exitCode = code;
        done(code);
      }),
    );
    worker.once("error", (error) => {
      failure = error;
    });
    const channel = new Channel(
      worker,
      runtime,
      "main-io",
      (packet) => {
        if (packet.kind === "ready") {
          ready = true;
        } else if (packet.kind === "prepare") {
          prepares.push(packet.requestId);
        } else if (packet.kind === "host-response") {
          replies.set(packet.requestId, packet.response);
        } else if (packet.kind === "cleaned") {
          cleaned = true;
        }
      },
      (error) => {
        failure = error;
      },
    );
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!condition()) {
        if (failure) {
          throw failure;
        }
        if (exitCode !== undefined) {
          throw new Error(`Opener I/O worker exited early: ${exitCode}`);
        }
        if (Date.now() > deadline) {
          throw new Error("Opener I/O worker timed out.");
        }
        await Bun.sleep(2);
      }
    };
    const operation = (requestId: string) =>
      channel.send({
        kind: "operation",
        context,
        requestId,
        source: "backend",
        call: {
          operation: "opener.openFile",
          payload: {
            path: "relative.txt",
          },
        },
      });
    const grant = (requestId: string, allowed: boolean) =>
      channel.send({
        kind: "grant",
        context,
        requestId,
        allowed,
      });
    try {
      await waitFor(() => ready);
      await operation("denied");
      await waitFor(() => prepares.includes("denied"));
      await grant("denied", false);
      await waitFor(() => replies.has("denied"));
      expect(replies.get("denied")).toMatchObject({
        kind: "error",
        error: {
          code: "PERMISSION_DENIED",
        },
      });
      await operation("cancelled");
      await waitFor(() => prepares.includes("cancelled"));
      await channel.send({
        kind: "cancel",
        context,
        requestId: "cancelled",
      });
      await grant("cancelled", true);
      await operation("approved");
      await waitFor(() => prepares.includes("approved"));
      await grant("approved", true);
      await waitFor(() => replies.has("approved"));
      expect(replies.get("approved")).toMatchObject({
        kind: "error",
        error: {
          code: "INVALID_ARGUMENT",
        },
      });
      expect(replies.has("cancelled")).toBe(false);
      await channel.send({
        kind: "shutdown",
      });
      expect(await exited).toBe(0);
      expect(cleaned).toBe(true);
      expect(await Bun.file(disposedPath).text()).toBe("STA");
      expect(failure).toBeUndefined();
    } finally {
      if (exitCode === undefined) {
        await worker.terminate();
      }
      channel.close();
      await rm(dataRoot, {
        recursive: true,
        force: true,
      });
    }
  },
  20000,
);
