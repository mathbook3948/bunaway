import { expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@bunaway/protocol";
import createOperationsDefinition from "#plugins/opener/src/index";
import { deadline } from "../fixtures/deadlines.ts";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

setDefaultTimeout(deadline("build"));

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

const APP = {
  id: "test.opener-jump-list",
  launch: {
    mode: "development" as const,
    executablePath: "C:\\Bunaway Test\\app.exe",
    args: [
      "--flag",
    ],
  },
};

type Adapter = ReturnType<typeof createOperations>;

const run = (adapter: Adapter, operation: string, input: JsonValue = {}) =>
  adapter.execute(`opener.${operation}`, input, "backend");

/**
 * Names of the Shell's custom destination files that hold `text`. The Shell writes a committed
 * list there, so this reads the result independently of the code under test.
 */
async function filesHolding(text: string): Promise<string[]> {
  const folder = join(
    process.env.APPDATA ?? "",
    "Microsoft",
    "Windows",
    "Recent",
    "CustomDestinations",
  );
  const needle = Buffer.from(text, "utf16le");
  const found: string[] = [];
  for (const name of await readdir(folder).catch(() => [])) {
    const content = await readFile(join(folder, name)).catch(() => undefined);
    if (content?.includes(needle)) {
      found.push(name);
    }
  }
  return found;
}

function listFor(id: string) {
  return {
    categories: [
      {
        type: "tasks",
        items: [
          {
            type: "task",
            title: `Task ${id}`,
            args: [
              "--open",
              'a "b" c',
            ],
            description: "Opens a document",
            cwd: "C:\\Bunaway Test",
            iconPath: "C:\\Windows\\System32\\shell32.dll",
            iconIndex: 3,
          },
          {
            type: "separator",
          },
          {
            type: "task",
            title: `Second ${id}`,
          },
        ],
      },
      {
        type: "custom",
        name: `Category ${id}`,
        items: [
          {
            type: "task",
            title: `Custom ${id}`,
            args: [
              "--custom",
            ],
          },
        ],
      },
    ],
  };
}

test.skipIf(process.platform !== "win32")(
  "set, read removed items, replace and delete the Jump List",
  async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app: APP,
    });
    try {
      expect(await run(adapter, "setJumpList", listFor(id))).toBe("ok");
      // The committed list is on disk with its task titles and category name.
      for (const text of [
        `Task ${id}`,
        `Second ${id}`,
        `Custom ${id}`,
        `Category ${id}`,
      ]) {
        expect((await filesHolding(text)).length).toBeGreaterThan(0);
      }
      // Nothing was removed by the user.
      expect(await run(adapter, "getJumpListRemovedItems")).toEqual([]);
      // Setting again replaces the list and begins a fresh one.
      expect(await run(adapter, "setJumpList", listFor(id))).toBe("ok");
      expect(await run(adapter, "deleteJumpList")).toBeNull();
      for (const text of [
        `Task ${id}`,
        `Custom ${id}`,
      ]) {
        expect(await filesHolding(text)).toEqual([]);
      }
      // Deleting a list that is already gone is accepted.
      expect(await run(adapter, "deleteJumpList")).toBeNull();
    } finally {
      await run(adapter, "deleteJumpList");
      await adapter.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "invalid requests change nothing and report INVALID_ARGUMENT",
  async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app: APP,
    });
    try {
      expect(await run(adapter, "setJumpList", listFor(id))).toBe("ok");
      const bad = {
        categories: [
          {
            type: "tasks",
            items: [
              {
                type: "task",
                title: `Bad ${id}`,
                args: [
                  "%1",
                ],
              },
            ],
          },
        ],
      };
      await expect(run(adapter, "setJumpList", bad)).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      // The earlier list is still in place and the rejected one never reached the Shell.
      expect((await filesHolding(`Task ${id}`)).length).toBeGreaterThan(0);
      expect(await filesHolding(`Bad ${id}`)).toEqual([]);
    } finally {
      await run(adapter, "deleteJumpList");
      await adapter.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "without a host app identity the list operations report UNSUPPORTED",
  async () => {
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    try {
      await expect(run(adapter, "setJumpList", listFor("x"))).rejects.toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
      await expect(run(adapter, "getJumpListRemovedItems")).rejects.toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
    } finally {
      await adapter.dispose();
    }
  },
);
