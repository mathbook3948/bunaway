import { expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import createOperationsDefinition from "#plugins/opener/src/index";
import { createShortcuts } from "#plugins/opener/src/platforms/windows-shortcut";
import { deadline } from "../fixtures/deadlines.ts";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

setDefaultTimeout(deadline("build"));

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

type Details = Record<string, string | number>;

async function withAdapter<T>(
  use: (
    root: string,
    write: (
      path: string,
      operation: string,
      details: Details,
    ) => Promise<unknown>,
    read: (path: string) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  const root = resolve(
    import.meta.dir,
    `../../build/windows-opener-shortcut-${crypto.randomUUID()}`,
  );
  await mkdir(root, {
    recursive: true,
  });
  const real = await realpath(root);
  const adapter = createOperations({
    dataRoot: real,
    capabilities: [],
  });
  try {
    return await use(
      real,
      (path, operation, details) =>
        adapter.execute(
          "opener.writeShortcutLink",
          {
            path,
            operation,
            details,
          },
          "backend",
        ),
      async (path) =>
        (await adapter.execute(
          "opener.readShortcutLink",
          {
            path,
          },
          "backend",
        )) as Record<string, unknown>,
    );
  } finally {
    await adapter.dispose();
  }
}

const rejection = (code: string, reason?: string) =>
  expect.objectContaining({
    code,
    ...(reason
      ? {
          details: {
            reason,
          },
        }
      : {}),
  });

test.skipIf(process.platform !== "win32")(
  "create, update and replace round-trip every property through the Shell",
  async () => {
    await withAdapter(async (root, write, read) => {
      const path = join(root, "한글 앱.lnk");
      const target = join(root, "app.exe");
      const args = `--flag "값 with spaces" ${"x".repeat(2000)}`;
      await write(path, "create", {
        target,
        cwd: root,
        args,
        description: "설명 text",
        icon: join(root, "app.ico"),
        iconIndex: 3,
      });
      const created = await read(path);
      expect(String(created.target).toLowerCase()).toBe(target.toLowerCase());
      expect(String(created.cwd).toLowerCase()).toBe(root.toLowerCase());
      expect(created.args).toBe(args);
      expect(created.description).toBe("설명 text");
      expect(String(created.icon).toLowerCase()).toBe(
        join(root, "app.ico").toLowerCase(),
      );
      expect(created.iconIndex).toBe(3);

      await write(path, "update", {
        description: "changed",
      });
      const updated = await read(path);
      expect(updated).toEqual({
        ...created,
        description: "changed",
      });

      await write(path, "update", {
        iconIndex: 5,
      });
      expect((await read(path)).iconIndex).toBe(5);
      expect((await read(path)).icon).toBe(created.icon);

      const longest = "d".repeat(1023);
      await write(path, "update", {
        description: longest,
        cwd: "",
        icon: "",
      });
      expect(await read(path)).toMatchObject({
        description: longest,
        cwd: "",
        icon: "",
      });

      const other = join(root, "other.exe");
      await write(path, "replace", {
        target: other,
      });
      const replaced = await read(path);
      expect(String(replaced.target).toLowerCase()).toBe(other.toLowerCase());
      expect(replaced).toMatchObject({
        cwd: "",
        args: "",
        description: "",
        icon: "",
        iconIndex: 0,
      });

      await write(path, "create", {
        target,
        args: "again",
      });
      expect(await read(path)).toMatchObject({
        args: "again",
        cwd: "",
      });
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "missing files, non-shortcut files and missing parents are reported without writing",
  async () => {
    await withAdapter(async (root, write, read) => {
      const missing = join(root, "missing.lnk");
      const target = join(root, "app.exe");
      await expect(read(missing)).rejects.toThrow(
        rejection("INVALID_ARGUMENT", "FILE_NOT_FOUND"),
      );
      await expect(
        write(missing, "update", {
          description: "x",
        }),
      ).rejects.toThrow(rejection("INVALID_ARGUMENT", "FILE_NOT_FOUND"));
      await expect(
        write(missing, "replace", {
          target,
        }),
      ).rejects.toThrow(rejection("INVALID_ARGUMENT", "FILE_NOT_FOUND"));
      await expect(
        write(join(root, "no-such-dir", "a.lnk"), "create", {
          target,
        }),
      ).rejects.toThrow(rejection("INVALID_ARGUMENT", "FILE_NOT_FOUND"));

      const fake = join(root, "fake.lnk");
      await writeFile(fake, "not a shortcut");
      await expect(read(fake)).rejects.toThrow(
        rejection("INVALID_ARGUMENT", "NOT_A_SHORTCUT"),
      );
      await expect(
        write(fake, "update", {
          description: "x",
        }),
      ).rejects.toThrow(rejection("INVALID_ARGUMENT", "NOT_A_SHORTCUT"));
      expect(await readFile(fake, "utf8")).toBe("not a shortcut");

      await expect(
        write(join(root, "plain.txt"), "create", {
          target,
        }),
      ).rejects.toThrow(rejection("INVALID_ARGUMENT"));
      await expect(write(join(root, "x.lnk"), "create", {})).rejects.toThrow(
        rejection("INVALID_ARGUMENT"),
      );
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "a junction in the parent path is refused for reads and writes",
  async () => {
    await withAdapter(async (root, write, read) => {
      const real = join(root, "real");
      await mkdir(real);
      const target = join(root, "app.exe");
      await write(join(real, "a.lnk"), "create", {
        target,
      });
      const junction = join(root, "junction");
      await symlink(real, junction, "junction");
      await expect(read(join(junction, "a.lnk"))).rejects.toThrow(
        rejection("PERMISSION_DENIED"),
      );
      await expect(
        write(join(junction, "b.lnk"), "create", {
          target,
        }),
      ).rejects.toThrow(rejection("PERMISSION_DENIED"));
      await expect(
        write(join(junction, "a.lnk"), "update", {
          description: "x",
        }),
      ).rejects.toThrow(rejection("PERMISSION_DENIED"));
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "the Shell binding rejects use after dispose",
  () => {
    const shortcuts = createShortcuts();
    shortcuts.dispose();
    shortcuts.dispose();
    expect(() => shortcuts.read("C:\\a.lnk")).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
  },
);
