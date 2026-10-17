import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import opener from "@bunaway/plugin-opener";
import type { HostContext, HostResponse } from "@bunaway/protocol";
import { Channel } from "#native/windows/bun/channel";
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
      resolve(
        import.meta.dir,
        "../../plugins/opener/src/platforms/windows-shell.ts",
      ),
    ).href;
    const operationsModule = resolve(
      import.meta.dir,
      "../../plugins/opener/src/index.ts",
    );
    await Bun.write(
      workerPath,
      `import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { parentPort } from "node:worker_threads";
import { createShell } from ${JSON.stringify(shellModule)};
import definition from ${JSON.stringify(operationsModule)};
const createOperations = definition._definition.nativePlatforms.windows.create;
import { createFiles } from ${JSON.stringify(resolve("plugins/opener/src/platforms/windows-file.ts"))};
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
// Without any apartment a launch must fail without opening a browser. If an earlier
// test in the same process left an implicit MTA (SHAddToRecentDocs can), COM calls
// succeed on this thread and a launch would really open a browser, so only the
// explicit-initialization state is asserted below and this negative check is skipped.
const probeApartment = new Uint32Array(1);
const probeQualifier = new Uint32Array(1);
const noApartment = ole.symbols.CoGetApartmentType(ptr(probeApartment), ptr(probeQualifier)) < 0;
const shell = createShell();
try {
  for (let attempt = 0; attempt < (noApartment ? 2 : 0); attempt++) {
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
      await assert.rejects(() => call(missing), (error) => error.code === "INVALID_ARGUMENT" && error.details.reason === "FILE_NOT_FOUND");
      const directory = ${JSON.stringify(root)};
      await assert.rejects(() => call(directory), (error) => error.code === "INVALID_ARGUMENT");
      const lockApi = dlopen("kernel32.dll", {
        CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        CloseHandle: { args: ["u64"], returns: "i32" },
      });
      const lock = lockApi.symbols.CreateFileW(ptr(Buffer.from(sample + "\\0", "utf16le")), 0x80000000, 0, null, 3, 0, 0n);
      assert.notEqual(lock, 0xffffffffffffffffn);
      try {
        await assert.rejects(() => call(sample), (error) => error.code === "PERMISSION_DENIED");
      } finally { lockApi.symbols.CloseHandle(lock); lockApi.close(); }
    }
    await assert.rejects(
      () => adapter.execute("opener.openUrl", { url: "file:///C:/secret.txt" }, "backend"),
      (error) => error instanceof Error && "code" in error && error.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      () => adapter.execute("opener.missing", { url: "https://example.com/" }, "backend"),
      (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED",
    );
    await assert.rejects(
      () => adapter.execute("opener.openUrl", { url: 42 }, "backend"),
      (error) => error instanceof Error && "code" in error && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    await adapter.dispose();
    await adapter.dispose();
  }
  await assert.rejects(
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
      expect(
        exitCode,
        failure instanceof Error ? failure.stack : undefined,
      ).toBe(0);
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
      "../../plugins/opener/src/index.ts",
    );
    const disposedPath = resolve(dataRoot, "opener-disposed.txt");
    await bundleIOPluginFixture(
      dataRoot,
      [
        {
          name: "opener",
          version: opener._definition.version,
          native: opener._definition.native,
          thread: "worker",
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
// A thread that never initialized COM is either outside every apartment or, when the
// process holds an MTA (SHAddToRecentDocs can leave one), an implicit MTA member
// (APTTYPE_MTA with APTTYPEQUALIFIER_IMPLICIT_MTA). Neither is an explicit initialization.
const APTTYPE_MTA = 1;
const APTTYPEQUALIFIER_IMPLICIT_MTA = 1;
const explicitlyInitialized = () =>
  apartmentType() >= 0 && !(apartment[0] === APTTYPE_MTA && qualifier[0] === APTTYPEQUALIFIER_IMPLICIT_MTA);
export const pluginImports = { opener: {
  operations: async () => {
    const { default: definition } = await import(${JSON.stringify(operationsModule)});
    const createOperations = definition._definition.nativePlatforms.windows.create;
    return { createOperations(environment) {
      assert(!explicitlyInitialized(), "I/O worker must start without explicit COM initialization");
      const adapter = createOperations(environment);
      assert.equal(apartmentType(), 0);
      assert([0, 3].includes(apartment[0]), "Opener must own an STA");
      return { ...adapter, async dispose() {
        await adapter.dispose();
        await adapter.dispose();
        assert(!explicitlyInitialized(), "Disposal must balance the adapter's own COM initialization");
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
              name: opener._definition.name,
              version: opener._definition.version,
              native: opener._definition.native,
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
        } else if (packet.kind === "authorize-input") {
          channel.notify({
            kind: "input-authorized",
            requestId: packet.requestId,
            context: packet.context,
            allowed: true,
          });
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
