import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  NativeTrayInitialization,
  NativeTrayServices,
} from "@bunaway/plugin-api/native";
import {
  readTrayIcon,
  validateTrayIconPath,
} from "#native/windows/bun/tray-icon";
import { initializeWith } from "#plugins/tray/src/platforms/windows";
import { trayIco } from "../fixtures/tray-icon.ts";

async function resources<T>(
  run: (root: string, outside: string) => Promise<T>,
) {
  const base = await mkdtemp(resolve(tmpdir(), "bunaway-tray-icon-"));
  try {
    const root = resolve(base, "resources");
    const outside = resolve(base, "outside");
    await mkdir(resolve(root, "icons"), {
      recursive: true,
    });
    await mkdir(outside);
    await writeFile(resolve(root, "icons", "tray.ico"), trayIco());
    await writeFile(resolve(outside, "secret.ico"), trayIco());
    return await run(root, outside);
  } finally {
    await rm(base, {
      recursive: true,
      force: true,
    });
  }
}

test("a declared tray icon resolves inside the resources directory", async () => {
  await resources(async (root) => {
    expect(await readTrayIcon(root, "icons/tray.ico")).toBe(
      trayIco().toString("base64"),
    );
    expect(await readTrayIcon(root, "icons\\tray.ico")).toBe(
      trayIco().toString("base64"),
    );
  });
});

test("tray icon paths outside the resources directory are rejected", async () => {
  for (const icon of [
    "../outside/secret.ico",
    "icons/../../outside/secret.ico",
    "icons/./tray.ico",
    "/etc/tray.ico",
    "\\\\server\\share\\tray.ico",
    "C:\\icons\\tray.ico",
    "C:tray.ico",
    "file:///C:/tray.ico",
    "https://example.com/tray.ico",
    "icons/tray.ico:stream",
    "icons//tray.ico",
    "icons/tray.ico.",
    "icons/CON",
    "icons/nul.ico",
    "COM1.ico",
    "icons/tray.ico ",
    "icons/tray\0.ico",
    "",
    "x".repeat(300),
    undefined,
    null,
    1,
    {},
  ]) {
    expect(() => validateTrayIconPath(icon)).toThrow("desktop.tray.icon");
  }
  await resources(async (root) => {
    await expect(readTrayIcon(root, "../outside/secret.ico")).rejects.toThrow(
      "desktop.tray.icon",
    );
  });
});

test("a symlink cannot lead a tray icon out of the resources directory", async () => {
  await resources(async (root, outside) => {
    // Creating a file symlink needs a privilege on Windows; the junction below covers that platform.
    if (process.platform !== "win32") {
      await symlink(
        resolve(outside, "secret.ico"),
        resolve(root, "icons", "link.ico"),
      );
      await expect(readTrayIcon(root, "icons/link.ico")).rejects.toThrow(
        "outside the resources directory",
      );
    }
    await symlink(outside, resolve(root, "linked"), "junction");
    await expect(readTrayIcon(root, "linked/secret.ico")).rejects.toThrow(
      "outside the resources directory",
    );
  });
});

test("a missing, non-file, oversized or invalid tray icon fails", async () => {
  await resources(async (root) => {
    await writeFile(resolve(root, "icons", "bad.ico"), "not an icon");
    await writeFile(resolve(root, "icons", "big.ico"), Buffer.alloc(70_000));
    await expect(readTrayIcon(root, "icons/none.ico")).rejects.toThrow(
      "was not found",
    );
    await expect(readTrayIcon(root, "icons")).rejects.toThrow("must be a file");
    await expect(readTrayIcon(root, "icons/big.ico")).rejects.toThrow(
      "larger than the ICO limit",
    );
    await expect(readTrayIcon(root, "icons/bad.ico")).rejects.toThrow(
      "not a valid ICO",
    );
    await expect(
      readTrayIcon(resolve(root, "missing"), "icons/tray.ico"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.not.stringContaining(root),
    });
    await expect(readTrayIcon(undefined, "icons/tray.ico")).rejects.toThrow(
      "needs an app resources directory",
    );
  });
});

test("the tray plugin hands the declared icon to the tray factory", () => {
  let create:
    | ((initialization: NativeTrayInitialization) => unknown)
    | undefined;
  const services = {
    initialize(callback: typeof create) {
      create = callback;
    },
    subscribe: () => () => {},
  } as unknown as NativeTrayServices;
  const received: unknown[] = [];
  initializeWith(
    {
      tray: services,
    } as never,
    (...args) => {
      received.push(args[7]);
      return {} as never;
    },
  );
  const base = {
    windows: {},
    tooltip: "t",
    receive: () => {},
    notify: () => {},
    retain: () => {},
  } as unknown as NativeTrayInitialization;
  create?.({
    ...base,
    icon: "AAAA",
  });
  create?.(base);
  expect(received).toEqual([
    "AAAA",
    undefined,
  ]);
});
