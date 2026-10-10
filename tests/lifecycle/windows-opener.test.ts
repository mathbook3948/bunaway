import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { openerPlugin } from "@bunaway/plugin-opener";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

test.skipIf(process.platform !== "win32")(
  "Windows opener validates calls and releases Explorer COM resources on an STA",
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
const permissions = (action, path) => ({ permissions: [{ identifier: "opener:" + action, allow: [{ path }] }] });
const fileAdapter = createOperations({ dataRoot: ".", capabilities: [] });
try {
  // Valid file and grant reach a real OS failure because this thread has no COM apartment.
  assert.throws(() => fileAdapter.executeUI("opener.openFile", { path: sample }, "backend", {
    requestId: "os-failure", permissions: permissions("openFile", sample),
  }), (error) => error.code === "INTERNAL");
} finally { fileAdapter.dispose(); }

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
      const call = (path, grants) => adapter.executeUI("opener." + action, { path }, "backend", {
        requestId: "files", permissions: grants,
      });
      assert.throws(() => call(sample, { permissions: ["opener:openUrl", "opener:" + action] }), (error) => error.code === "PERMISSION_DENIED");
      const missing = sample + ".missing";
      assert.throws(() => call(missing, permissions(action, sample)), (error) => error.code === "PERMISSION_DENIED");
      assert.throws(() => call(missing, permissions(action, missing)), (error) => error.code === "INVALID_ARGUMENT" && error.details.reason === "FILE_NOT_FOUND");
      const directory = ${JSON.stringify(root)};
      assert.throws(() => call(directory, permissions(action, directory)), (error) => error.code === "INVALID_ARGUMENT");
      const lockApi = dlopen("kernel32.dll", {
        CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        CloseHandle: { args: ["u64"], returns: "i32" },
      });
      const lock = lockApi.symbols.CreateFileW(ptr(Buffer.from(sample + "\\0", "utf16le")), 0x80000000, 0, null, 3, 0, 0n);
      assert.notEqual(lock, 0xffffffffffffffffn);
      try {
        assert.throws(() => call(sample, permissions(action, sample)), (error) => error.code === "PERMISSION_DENIED");
      } finally { lockApi.symbols.CloseHandle(lock); lockApi.close(); }
    }
    assert.throws(
      () => adapter.execute("opener.openUrl", { url: "https://example.com/" }, "backend"),
      (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED",
    );
    assert.throws(
      () => adapter.executeUI("opener.openUrl", { url: "https://example.com/" }, "backend", {
        requestId: "denied",
        permissions: { permissions: [] },
      }),
      (error) => error instanceof Error && "code" in error && error.code === "PERMISSION_DENIED",
    );
    assert.throws(
      () => adapter.executeUI("opener.openUrl", { url: "file:///C:/secret.txt" }, "backend", {
        requestId: "invalid",
        permissions: { permissions: ["opener:openUrl"] },
      }),
      (error) => error instanceof Error && "code" in error && error.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => adapter.executeUI("opener.missing", { url: "https://example.com/" }, "backend", {
        requestId: "unknown",
        permissions: { permissions: ["opener:openUrl"] },
      }),
      (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED",
    );
    assert.throws(
      () => adapter.executeUI("opener.openUrl", { url: 42 }, "backend", {
        requestId: "malformed",
        permissions: { permissions: ["opener:openUrl"] },
      }),
      (error) => error instanceof Error && "code" in error && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    await adapter.dispose();
    await adapter.dispose();
  }
  assert.throws(
    () => adapter.executeUI("opener.openUrl", { url: "https://example.com/" }, "backend", {
      requestId: "disposed",
      permissions: { permissions: ["opener:openUrl"] },
    }),
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
  "Windows UI Worker creates and disposes the opener adapter on its STA",
  async () => {
    const dataRoot = resolve(
      import.meta.dir,
      `../../build/windows-opener-ui-${crypto.randomUUID()}`,
    );
    await mkdir(dataRoot, {
      recursive: true,
    });
    const operationsModule = resolve(
      import.meta.dir,
      "../../plugins/opener/src/windows.ts",
    );
    const disposedPath = resolve(dataRoot, "opener-disposed.txt");
    await bundleUIPluginFixture(
      dataRoot,
      [
        {
          name: "opener",
          version: openerPlugin.version,
          native: openerPlugin.native,
          execution: "ui",
          authorization: false,
        },
      ],
      `import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { writeFileSync } from "node:fs";
const ole = dlopen("ole32.dll", {
  CoGetApartmentType: { args: ["ptr", "ptr"], returns: "i32" },
});
function checkApartment() {
  const type = new Uint32Array(1);
  const qualifier = new Uint32Array(1);
  assert.equal(ole.symbols.CoGetApartmentType(ptr(type), ptr(qualifier)), 0);
  assert([0, 3].includes(type[0]), "Opener adapter must use the UI STA");
}
export const pluginImports = { 'opener': {
  operations: async () => {
    const { createOperations } = await import(${JSON.stringify(operationsModule)});
    return {
      createOperations(environment) {
        checkApartment();
        const adapter = createOperations(environment);
        return {
          ...adapter,
          async dispose() {
            checkApartment();
            await adapter.dispose();
            writeFileSync(${JSON.stringify(disposedPath)}, "STA");
            ole.close();
          },
        };
      },
    };
  },
}};
`,
    );
    const config: UIConfig = {
      runtime: {
        id: `opener-${crypto.randomUUID()}`,
        generation: "1",
      },
      policy: {
        version: 1,
        views: [],
        backend: {
          permissions: [],
        },
      },
      backendContext: "backend" as UIConfig["backendContext"],
      windows: [],
      assets: dataRoot,
      dataRoot,
      loader: "",
      plugins: [
        {
          name: openerPlugin.name,
          version: openerPlugin.version,
          native: openerPlugin.native,
        },
      ],
    };
    const worker = new Worker(pathToFileURL(resolve(dataRoot, "ui.js")), {
      workerData: config,
    });
    let failure: unknown;
    let ready = false;
    let cleaned = false;
    const exited = new Promise<number>((resolveExit) => {
      worker.once("exit", resolveExit);
    });
    worker.once("error", (error) => {
      failure = error;
    });
    const channel = new Channel(
      worker,
      config.runtime,
      "main",
      (packet) => {
        if (packet.kind === "ready") {
          ready = true;
          channel.notify({
            kind: "shutdown",
          });
        } else if (packet.kind === "cleaned") {
          cleaned = true;
        } else if (packet.kind === "fatal") {
          failure = new Error(packet.error.message);
        }
      },
      (error) => {
        failure = error;
        void worker.terminate();
      },
    );
    const timeout = setTimeout(() => {
      failure = new Error("Opener UI Worker timed out.");
      void worker.terminate();
    }, 15000);
    try {
      expect(await exited).toBe(0);
      expect(failure).toBeUndefined();
      expect(ready).toBe(true);
      expect(cleaned).toBe(true);
      expect(await Bun.file(disposedPath).text()).toBe("STA");
    } finally {
      clearTimeout(timeout);
      channel.close();
      await worker.terminate();
      await rm(dataRoot, {
        recursive: true,
        force: true,
      });
    }
  },
  20000,
);
