import { expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import capabilities from "@bunaway/plugin-capabilities/native/macos";
import log from "@bunaway/plugin-log/native/macos";
import { NativeRegistry } from "@bunaway/protocol";
import { hostResponse } from "#native/host-api/bun/host-response";
import { operations } from "#native/host-api/bun/plugins";
import capabilitiesDefinition from "#plugins/capabilities/src/index";
import { capabilitiesOperations } from "#plugins/capabilities/src/operations";
import createLogDefinition from "#plugins/log/src/index";

import { macosOperations as logOperations } from "#plugins/log/src/operations";
import {
  nativeFactory as createLogFactory,
  nativeFactory,
} from "../fixtures/native-platform.ts";

const createCapabilities = nativeFactory(capabilitiesDefinition, "macos");
const createLog = createLogFactory(createLogDefinition, "macos");

const record = {
  level: "info",
  message: "한글 😀\nnext line",
} as const;
const thresholdBytes = 1024 * 1024;

/** Own a fresh real filesystem and adapter for each case, including failure cleanup. */
async function withLog(
  run: (fixture: {
    root: string;
    path: string;
    adapter: ReturnType<typeof createLog>;
  }) => void | Promise<void>,
) {
  const root = mkdtempSync(resolve(tmpdir(), "bunaway-macos-log-"));
  const adapter = createLog({
    dataRoot: root,
    capabilities: [],
  });
  try {
    await run({
      root,
      path: resolve(root, "logs/app.log"),
      adapter,
    });
  } finally {
    await adapter.dispose();
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}

test("macOS log lazily uses host dataRoot, preserves attribution and JSONL order", async () => {
  await withLog(async ({ root, path, adapter }) => {
    expect(readdirSync(root)).toEqual([]);
    const platform = log._definition.nativePlatforms.macos;
    expect(platform?.thread).toBe("worker");
    if (!platform) {
      throw new Error("Missing macOS log adapter.");
    }
    const validated = platform.create({
      dataRoot: root,
      capabilities: [],
    });
    try {
      await Promise.all(
        Array.from(
          {
            length: 64,
          },
          async (_, index) =>
            await validated.execute(
              "log.write",
              {
                ...record,
                details: {
                  index,
                  source: "forged",
                },
              },
              index % 2 === 0 ? "backend" : "view:main",
            ),
        ),
      );
      const records = (await Bun.file(path).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(64);
      for (const [index, value] of records.entries()) {
        expect(value).toEqual({
          t: expect.any(Number),
          source: index % 2 === 0 ? "backend" : "view:main",
          ...record,
          details: {
            index,
            source: "forged",
          },
        });
      }
      expect(await adapter.execute("log.write", record, "backend")).toBeNull();
      expect((await Bun.file(path).text()).endsWith("\n")).toBe(true);
    } finally {
      await validated.dispose();
    }
  });
});

test("macOS log retains one archive, rotates on the next write and bounds repeated growth", async () => {
  await withLog(async ({ root, path, adapter }) => {
    mkdirSync(resolve(root, "logs"));
    const first = "a".repeat(thresholdBytes);
    writeFileSync(path, first);
    await adapter.execute("log.write", record, "backend");
    expect(await Bun.file(`${path}.1`).exists()).toBe(false);
    const previous = await Bun.file(path).text();
    await adapter.execute("log.write", record, "view:main");
    expect(await Bun.file(`${path}.1`).text()).toBe(previous);
    expect(statSync(path).size).toBeLessThan(512);
    for (let index = 0; index < 3; index++) {
      appendFileSync(path, "b".repeat(thresholdBytes));
      const archive = await Bun.file(path).text();
      await adapter.execute("log.write", record, "backend");
      expect(await Bun.file(`${path}.1`).text()).toBe(archive);
      expect(statSync(`${path}.1`).size).toBeLessThan(thresholdBytes + 512);
      expect(readdirSync(resolve(root, "logs")).sort()).toEqual([
        "app.log",
        "app.log.1",
      ]);
    }
  });
});

test("macOS log exposes append and rotation errors and recovers on the next call", async () => {
  await withLog(async ({ path, adapter }) => {
    mkdirSync(path, {
      recursive: true,
    });
    const append = await adapter.execute("log.write", record, "backend").then(
      (value) => hostResponse(() => value),
      (error) =>
        hostResponse(() => {
          throw error;
        }),
    );
    expect(append).toEqual({
      kind: "error",
      error: {
        code: "INTERNAL",
        message: expect.any(String),
      },
    });
    rmSync(path, {
      recursive: true,
    });
    writeFileSync(path, "a".repeat(thresholdBytes + 1));
    mkdirSync(`${path}.1`);
    await expect(
      adapter.execute("log.write", record, "backend"),
    ).rejects.toThrow();
    expect(statSync(path).size).toBe(thresholdBytes + 1);
    rmSync(`${path}.1`, {
      recursive: true,
    });
    expect(await adapter.execute("log.write", record, "backend")).toBeNull();
    expect(JSON.parse((await Bun.file(path).text()).trim()).message).toBe(
      record.message,
    );
  });
});

test.skipIf(process.platform === "win32")(
  "macOS log creates private directories and files",
  async () => {
    await withLog(async ({ root, path, adapter }) => {
      await adapter.execute("log.write", record, "backend");
      expect(statSync(resolve(root, "logs")).mode & 0o077).toBe(0);
      expect(statSync(path).mode & 0o077).toBe(0);
    });
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "macOS log propagates filesystem write denial and recovers after access is restored",
  async () => {
    await withLog(async ({ path, adapter }) => {
      await adapter.execute("log.write", record, "backend");
      chmodSync(path, 0o400);
      try {
        await expect(
          adapter.execute("log.write", record, "backend"),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "EACCES",
          }),
        );
      } finally {
        chmodSync(path, 0o600);
      }
      expect(await adapter.execute("log.write", record, "backend")).toBeNull();
    });
  },
);

test("macOS SDK rejects forged attribution and invalid input before touching disk", async () => {
  await withLog(async ({ root }) => {
    const platform = log._definition.nativePlatforms.macos;
    if (!platform) {
      throw new Error("Missing macOS log adapter.");
    }
    const validated = platform.create({
      dataRoot: root,
      capabilities: [],
    });
    try {
      for (const input of [
        {
          ...record,
          source: "backend",
        },
        {
          level: "fatal",
          message: "invalid",
        },
      ]) {
        await expect(
          Promise.resolve().then(
            async () =>
              await validated.execute("log.write", input, "view:main"),
          ),
        ).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      }
      expect(readdirSync(root)).toEqual([]);
      const registry = new NativeRegistry([
        log._definition,
        capabilities._definition,
      ]);
      const call = registry.validateCall({
        operation: "log.write",
        payload: record,
      });
      expect(
        registry.allowed(
          {
            permissions: [],
          },
          call,
        ),
      ).toBe(false);
      expect(
        registry.allowed(
          {
            permissions: [
              "capabilities.get",
            ],
          },
          call,
        ),
      ).toBe(false);
      expect(
        registry.allowed(
          {
            permissions: [
              "log.write",
            ],
          },
          call,
        ),
      ).toBe(true);
      expect(logOperations.write.output.parse(null)).toBeNull();
    } finally {
      await validated.dispose();
    }
  });
});

test("macOS log disposal is repeatable, completes accepted writes and rejects later calls", async () => {
  await withLog(async ({ root, path, adapter }) => {
    const platform = log._definition.nativePlatforms.macos;
    if (!platform) {
      throw new Error("Missing macOS log adapter.");
    }
    const validated = platform.create({
      dataRoot: root,
      capabilities: [],
    });
    const accepted = await validated.execute("log.write", record, "backend");
    await accepted;
    const prepared =
      "prepare" in validated
        ? await validated.prepare("log.write", record, "backend")
        : undefined;
    await validated.dispose();
    await validated.dispose();
    if (prepared) {
      await expect(prepared()).rejects.toMatchObject({
        code: "CANCELLED",
      });
    }
    await adapter.dispose();
    await adapter.dispose();
    const text = await Bun.file(path).text();
    await expect(
      adapter.execute("log.write", record, "backend"),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
    expect(await Bun.file(path).text()).toBe(text);
  });
});

test("macOS capabilities preserve the host snapshot including unsupported and experimental states", async () => {
  const capabilities = [
    {
      name: "log.write",
      support: "supported",
    },
    {
      name: "storage.readText",
      support: "unsupported",
    },
    {
      name: "custom.read",
      support: "experimental",
    },
  ] as const;
  const snapshot = capabilities.map((entry) => ({
    ...entry,
  }));
  const adapter = createCapabilities({
    dataRoot: ".",
    capabilities: snapshot,
  });
  expect(
    capabilitiesOperations.get.output.parse(
      await adapter.execute("capabilities.get", null, "view:main"),
    ),
  ).toEqual(snapshot);
  await adapter.dispose();
  await adapter.dispose();
  await expect(
    adapter.execute("capabilities.get", null, "backend"),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("macOS capability discovery uses installed executable operations and includes only registered plugins", async () => {
  const plugins = [
    log,
    capabilities,
  ].map((plugin) => plugin._definition);
  const catalog = plugins.map((plugin) => {
    const platform = plugin.nativePlatforms.macos;
    if (!platform) {
      throw new Error("Missing macOS adapter.");
    }
    return {
      name: plugin.name,
      version: plugin.version,
      native: plugin.native,
      thread: "worker" as const,
      supportedOperations:
        plugin.name === "log"
          ? []
          : [
              "capabilities.get",
            ],
      operations: async () => ({
        createOperations: platform.create,
      }),
    };
  });
  const dispatcher = await operations(
    plugins,
    ".",
    "worker",
    undefined,
    catalog,
  );
  try {
    expect(
      await dispatcher.execute("capabilities.get", null, "backend"),
    ).toEqual([
      {
        name: "log.write",
        support: "unsupported",
      },
      {
        name: "capabilities.get",
        support: "supported",
      },
    ]);
    await expect(
      dispatcher.execute("log.write", record, "backend"),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(dispatcher.busy()).toBe(false);
  } finally {
    await dispatcher.dispose();
  }
});
