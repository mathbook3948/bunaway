import { expect, test } from "bun:test";
import opener from "@bunaway/plugin-opener";
import { NativeRegistry } from "@bunaway/protocol";
import {
  shortcutLinkSchema,
  validateOpenerInput,
} from "#plugins/opener/src/contract";
import { windowsOperations } from "#plugins/opener/src/operations";
import {
  normalizeShortcutDetails,
  normalizeShortcutPath,
} from "#plugins/opener/src/platforms/windows-path";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("opener", windowsOperations);
const registry = new NativeRegistry([
  opener._definition,
]);

const WRITE = {
  path: "C:\\Users\\a\\app.lnk",
  operation: "create",
  details: {
    target: "C:\\Windows\\notepad.exe",
  },
};

test("shortcut paths must be absolute .lnk files", () => {
  expect(normalizeShortcutPath("c:/Users/a/app.LNK")).toBe(
    "C:\\Users\\a\\app.LNK",
  );
  for (const path of [
    "C:\\Users\\a\\app.txt",
    "C:\\Users\\a\\app.lnk.exe",
    "app.lnk",
    "C:\\Users\\a\\.lnk ",
    1,
  ]) {
    expect(() => normalizeShortcutPath(path)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("create and replace need a target, update does not", () => {
  expect(() => normalizeShortcutDetails({}, "create")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(() => normalizeShortcutDetails({}, "replace")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(normalizeShortcutDetails({}, "update")).toEqual({});
  expect(
    normalizeShortcutDetails(
      {
        target: "c:/a/b.exe",
        cwd: "c:/a",
        args: '--flag "x y"',
        description: "한글 설명",
        icon: "c:/a/b.ico",
        iconIndex: 2,
      },
      "create",
    ),
  ).toEqual({
    target: "C:\\a\\b.exe",
    cwd: "C:\\a",
    args: '--flag "x y"',
    description: "한글 설명",
    icon: "C:\\a\\b.ico",
    iconIndex: 2,
  });
});

test("text limits count UTF-16 code units and an empty cwd or icon clears the property", () => {
  const target = "C:\\a.exe";
  expect(
    normalizeShortcutDetails(
      {
        target,
        description: "x".repeat(1023),
      },
      "create",
    ),
  ).toBeDefined();
  for (const description of [
    "x".repeat(1024),
    "😀".repeat(512),
  ]) {
    expect(() =>
      normalizeShortcutDetails(
        {
          target,
          description,
        },
        "create",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  expect(
    normalizeShortcutDetails(
      {
        cwd: "",
        icon: "",
        args: "",
      },
      "update",
    ),
  ).toEqual({
    cwd: "",
    icon: "",
    args: "",
  });
  expect(() =>
    normalizeShortcutDetails(
      {
        target: "",
      },
      "update",
    ),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});

test("shortcut properties reject relative paths, control characters and bad shapes", () => {
  for (const details of [
    {
      target: "notepad.exe",
    },
    {
      target: "C:\\a.exe",
      cwd: "relative",
    },
    {
      target: "C:\\a.exe",
      icon: "%SystemRoot%\\system32\\shell32.dll",
    },
    {
      target: "C:\\a.exe",
      args: "a\nb",
    },
    {
      target: "C:\\a.exe",
      description: "x".repeat(1025),
    },
    {
      target: "C:\\a.exe",
      args: "x".repeat(2049),
    },
    {
      target: "C:\\a.exe",
      iconIndex: 1.5,
    },
    {
      target: "C:\\a.exe",
      extra: 1,
    },
  ]) {
    expect(() => normalizeShortcutDetails(details, "create")).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("host inputs are strict", () => {
  expect(validateOpenerInput("opener.writeShortcutLink", WRITE)).toEqual(WRITE);
  expect(
    validateOpenerInput("opener.readShortcutLink", {
      path: "C:\\Users\\a\\app.lnk",
    }),
  ).toEqual({
    path: "C:\\Users\\a\\app.lnk",
  });
  for (const input of [
    {
      ...WRITE,
      operation: "append",
    },
    {
      ...WRITE,
      details: null,
    },
    {
      ...WRITE,
      extra: 1,
    },
  ]) {
    expect(() =>
      validateOpenerInput("opener.writeShortcutLink", input),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("shortcut result is a strict object with every property", () => {
  const link = {
    target: "C:\\a.exe",
    cwd: "",
    args: "",
    description: "",
    icon: "",
    iconIndex: 0,
  };
  expect(windowsOperations.readShortcutLink.output.parse(link)).toEqual(link);
  expect(
    shortcutLinkSchema.safeParse({
      ...link,
      appUserModelId: "x",
    }).success,
  ).toBe(false);
  expect(
    shortcutLinkSchema.safeParse({
      target: "C:\\a.exe",
    }).success,
  ).toBe(false);
});

test("reading and writing shortcuts are separate permissions", async () => {
  const write = await parsers.validateCall({
    operation: "opener.writeShortcutLink",
    payload: WRITE,
  });
  const read = await parsers.validateCall({
    operation: "opener.readShortcutLink",
    payload: {
      path: WRITE.path,
    },
  });
  const grant = (name: string) => ({
    permissions: [
      name,
    ],
  });
  expect(registry.allowed(grant("opener.writeShortcutLink"), write)).toBe(true);
  expect(registry.allowed(grant("opener.readShortcutLink"), write)).toBe(false);
  expect(registry.allowed(grant("opener.readShortcutLink"), read)).toBe(true);
  expect(registry.allowed(grant("opener.writeShortcutLink"), read)).toBe(false);
  expect(registry.allowed(grant("opener.openFile"), write)).toBe(false);
});
