import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import macosLog from "@bunaway/plugin-log/native/macos";
import windowsLog from "@bunaway/plugin-log/native/windows";
import { NativeRegistry } from "@bunaway/protocol";
import { nativeFactory } from "../fixtures/native-platform.ts";

const record = {
  level: "info",
  message: "한글 😀",
  details: {
    text: "x".repeat(1100),
  },
} as const;

for (const [platform, plugin] of [
  [
    "windows",
    windowsLog,
  ],
  [
    "macos",
    macosLog,
  ],
] as const) {
  const createLog = nativeFactory(plugin, platform);
  async function withLog(
    run: (fixture: {
      root: string;
      path: string;
      adapter: ReturnType<typeof createLog>;
    }) => Promise<void>,
  ) {
    const root = mkdtempSync(resolve(tmpdir(), `bunaway-${platform}-app-log-`));
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
      try {
        await adapter.dispose();
      } finally {
        rmSync(root, {
          recursive: true,
          force: true,
        });
      }
    }
  }

  test(`${platform} app log configuration is bounded, backend-only and separately authorized`, async () => {
    await withLog(async ({ root, adapter }) => {
      const registry = new NativeRegistry([
        plugin._definition,
      ]);
      for (const operation of [
        "log.configure",
        "log.flush",
      ]) {
        const call = registry.validateCall({
          operation,
          payload: operation === "log.flush" ? null : {},
        });
        expect(
          registry.allowed(
            {
              permissions: [
                "log.write",
              ],
            },
            call,
          ),
        ).toBe(false);
        expect(
          registry.allowed(
            {
              permissions: [
                operation,
              ],
            },
            call,
          ),
        ).toBe(true);
      }
      await expect(
        adapter.executeUI?.("log.configure", {}, "backend", {
          requestId: "denied",
          permissions: {
            permissions: [
              "log.write",
            ],
          },
        }),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(
        adapter.executeUI?.("log.configure", {}, "view:main", {
          requestId: "view",
          permissions: {
            permissions: [
              "log.configure",
            ],
          },
        }),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      for (const input of [
        {
          minimumLevel: "fatal",
        },
        {
          maxFileBytes: 1023,
        },
        {
          maxFileBytes: 64 * 1024 * 1024 + 1,
        },
        {
          maxFileBytes: 1024.5,
        },
        {
          maxArchives: -1,
        },
        {
          maxArchives: 11,
        },
        {
          maxArchives: 1.5,
        },
        {
          target: "../outside",
        },
        {
          path: "/outside",
        },
        {
          source: "backend",
        },
      ]) {
        await expect(
          adapter.execute("log.configure", input, "backend"),
        ).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      }
      await expect(
        adapter.execute("log.flush", {}, "backend"),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(
        await adapter.execute(
          "log.configure",
          {
            maxFileBytes: 64 * 1024 * 1024,
            maxArchives: 10,
            target: "appData",
          },
          "backend",
        ),
      ).toBeNull();
      expect(await adapter.execute("log.flush", null, "backend")).toBeNull();
      expect(readdirSync(root)).toEqual([]);
    });
  });

  test(`${platform} app log settings stay local and filtering retains validation and attribution`, async () => {
    await withLog(async ({ root, path, adapter }) => {
      await adapter.execute(
        "log.configure",
        {
          minimumLevel: "warn",
        },
        "backend",
      );
      for (const level of [
        "debug",
        "info",
      ] as const) {
        expect(
          await adapter.execute(
            "log.write",
            {
              ...record,
              level,
            },
            "view:main",
          ),
        ).toBeNull();
      }
      expect(readdirSync(root)).toEqual([]);
      await expect(
        adapter.execute(
          "log.write",
          {
            ...record,
            message: "😀".repeat(1025),
          },
          "backend",
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await adapter.execute(
        "log.write",
        {
          ...record,
          level: "warn",
        },
        "view:main",
      );
      await adapter.execute(
        "log.write",
        {
          ...record,
          level: "error",
        },
        "backend",
      );
      const values = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        values.map((value) => [
          value.level,
          value.source,
        ]),
      ).toEqual([
        [
          "warn",
          "view:main",
        ],
        [
          "error",
          "backend",
        ],
      ]);
      // A fresh adapter starts with defaults rather than inheriting another instance's settings.
      await withLog(async ({ path: otherPath, adapter: other }) => {
        await other.execute(
          "log.write",
          {
            level: "debug",
            message: "default",
          },
          "backend",
        );
        expect(JSON.parse(readFileSync(otherPath, "utf8")).level).toBe("debug");
      });
      await adapter.execute(
        "log.configure",
        {
          maxArchives: 2,
        },
        "backend",
      );
      await adapter.execute("log.write", record, "backend");
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    });
  });

  test(`${platform} app log preserves the rotation boundary and prunes bounded retention`, async () => {
    await withLog(async ({ root, path, adapter }) => {
      await adapter.execute(
        "log.configure",
        {
          maxFileBytes: 1024,
          maxArchives: 3,
        },
        "backend",
      );
      mkdirSync(resolve(root, "logs"));
      writeFileSync(path, "a".repeat(1024));
      await adapter.execute("log.write", record, "backend");
      expect(readdirSync(resolve(root, "logs"))).toEqual([
        "app.log",
      ]);
      const initial = readFileSync(path, "utf8");
      for (let index = 0; index < 6; index++) {
        await adapter.execute(
          "log.write",
          {
            ...record,
            message: String(index),
          },
          "backend",
        );
      }
      expect(readdirSync(resolve(root, "logs")).sort()).toEqual([
        "app.log",
        "app.log.1",
        "app.log.2",
        "app.log.3",
      ]);
      expect(readFileSync(`${path}.3`, "utf8")).not.toBe(initial);
      expect(JSON.parse(readFileSync(`${path}.1`, "utf8")).message).toBe("4");
      expect(JSON.parse(readFileSync(`${path}.3`, "utf8")).message).toBe("2");
      expect(statSync(path).size).toBeLessThan(1024 + 1500);
      writeFileSync(resolve(root, "logs/other.log"), "preserved");
      await adapter.execute(
        "log.configure",
        {
          maxArchives: 1,
        },
        "backend",
      );
      expect(readdirSync(resolve(root, "logs")).sort()).toEqual([
        "app.log",
        "app.log.1",
        "other.log",
      ]);
      await adapter.execute(
        "log.configure",
        {
          maxArchives: 0,
        },
        "backend",
      );
      await adapter.execute("log.write", record, "backend");
      expect(readdirSync(resolve(root, "logs")).sort()).toEqual([
        "app.log",
        "other.log",
      ]);
      expect(readFileSync(resolve(root, "logs/other.log"), "utf8")).toBe(
        "preserved",
      );
      expect(await adapter.execute("log.flush", null, "backend")).toBeNull();
    });
  });

  test(`${platform} app log restarts with the legacy defaults and prunes older retention on rotation`, async () => {
    await withLog(async ({ root, path, adapter }) => {
      mkdirSync(resolve(root, "logs"));
      writeFileSync(path, "a".repeat(1024 * 1024));
      writeFileSync(`${path}.1`, "previous");
      writeFileSync(`${path}.2`, "older settings");
      await adapter.execute(
        "log.write",
        {
          level: "debug",
          message: "default level",
        },
        "backend",
      );
      expect(readFileSync(`${path}.1`, "utf8")).toBe("previous");
      const previous = readFileSync(path, "utf8");
      await adapter.execute(
        "log.write",
        {
          level: "info",
          message: "rotation",
        },
        "backend",
      );
      expect(readFileSync(`${path}.1`, "utf8")).toBe(previous);
      expect(readdirSync(resolve(root, "logs")).sort()).toEqual([
        "app.log",
        "app.log.1",
      ]);
    });
  });

  test(`${platform} app log recovers from retention and flush failures and retries disposal`, async () => {
    await withLog(async ({ path, adapter }) => {
      await adapter.execute("log.write", record, "backend");
      writeFileSync(`${path}.1`, "retained");
      mkdirSync(`${path}.2`);
      await expect(
        adapter.execute(
          "log.configure",
          {
            minimumLevel: "error",
            maxArchives: 0,
          },
          "backend",
        ),
      ).rejects.toThrow();
      expect(readFileSync(`${path}.1`, "utf8")).toBe("retained");
      rmSync(`${path}.2`, {
        recursive: true,
      });
      await adapter.execute(
        "log.write",
        {
          level: "debug",
          message: "old settings",
        },
        "backend",
      );
      expect(readFileSync(path, "utf8")).toContain("old settings");
      rmSync(`${path}.1`);
      mkdirSync(`${path}.1`);
      await expect(
        adapter.execute("log.flush", null, "backend"),
      ).rejects.toThrow();
      await expect(adapter.dispose()).rejects.toThrow();
      await expect(
        adapter.execute("log.write", record, "backend"),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
      rmSync(`${path}.1`, {
        recursive: true,
      });
      await adapter.dispose();
      await adapter.dispose();
      await expect(
        adapter.execute("log.flush", null, "backend"),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
      await expect(
        adapter.execute("log.configure", {}, "backend"),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
      expect(readFileSync(path, "utf8")).toContain("old settings");
    });
  });

  test.skipIf(process.platform === "win32")(
    `${platform} app log follows a linked log file and removes only archive links`,
    async () => {
      await withLog(async ({ root, path, adapter }) => {
        const outside = resolve(root, "outside.log");
        writeFileSync(outside, "kept\n");
        mkdirSync(resolve(root, "logs"));
        symlinkSync(outside, path);
        await adapter.execute("log.write", record, "backend");
        expect(readFileSync(outside, "utf8")).toStartWith("kept\n");
        expect(readFileSync(outside, "utf8").length).toBeGreaterThan(5);
        rmSync(path);
        const target = resolve(root, "target.log");
        writeFileSync(target, "preserved");
        symlinkSync(target, `${path}.1`);
        await adapter.execute(
          "log.configure",
          {
            maxArchives: 0,
          },
          "backend",
        );
        expect(existsSync(`${path}.1`)).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("preserved");
      });
    },
  );

  test(`${platform} app log writes through a linked log directory`, async () => {
    await withLog(async ({ root, adapter }) => {
      const real = resolve(root, "real-logs");
      mkdirSync(real);
      // A junction needs no privilege on Windows; POSIX creates a directory symlink.
      symlinkSync(real, resolve(root, "logs"), "junction");
      await adapter.execute("log.write", record, "backend");
      expect(readFileSync(resolve(real, "app.log"), "utf8")).not.toBe("");
    });
  });

  test(`${platform} app log refuses a directory in place of the log file`, async () => {
    await withLog(async ({ path, adapter }) => {
      mkdirSync(path, {
        recursive: true,
      });
      await expect(
        adapter.execute("log.write", record, "backend"),
      ).rejects.toThrow();
      rmSync(path, {
        recursive: true,
      });
    });
  });
}
