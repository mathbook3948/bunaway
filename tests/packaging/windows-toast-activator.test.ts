import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toastActivatorClsid } from "@bunaway/protocol";
import { findIscc, must } from "#packaging/channels/windows/common";
import {
  type InnoOptions,
  renderInnoScript,
} from "#packaging/channels/windows/inno";
import { writeToastActivatorServer } from "#plugins/notification/src/platforms/toast-activator-registry";
import { guid } from "#plugins/notification/src/platforms/toast-winrt";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

const base: InnoOptions = {
  name: "Toast fixture",
  identifier: "com.example.toast",
  appId: "com.example.toast.app",
  version: "1.0.0",
  publisher: "Test",
  scope: "perUser",
  payloadDir: "C:\\stage\\app",
  outputDir: "C:\\stage\\installer",
  outputBaseName: "setup",
  desktopShortcut: true,
  startMenuShortcut: true,
  webView2: "check",
  appDataDir: "{localappdata}\\bunaway\\com.example.toast.app",
  preserveUserData: true,
  assetPaths: [],
  executableName: "App.exe",
};

test("the Start menu shortcut names the activator class and a per-user uninstall removes its key", () => {
  const clsid = toastActivatorClsid("com.example.toast.app");
  const script = renderInnoScript(base);
  const icons = script.split("[Icons]")[1]?.split("[Run]")[0] ?? "";
  const lines = icons.split("\n");
  const property = `AppUserModelToastActivatorCLSID: "{{${clsid}}"`;
  const menu = lines.find((line) => line.includes('Name: "{group}\\Toast'));
  const desktop = lines.find((line) => line.includes("{autodesktop}"));
  expect(menu).toContain(property);
  expect(menu).toContain('AppUserModelID: "com.example.toast.app"');
  // Only the Start menu entry takes part in toast activation.
  expect(desktop).not.toContain("AppUserModelToastActivatorCLSID");
  expect(script).toContain(
    `RemoveToastActivatorRegistration('Software\\Classes\\CLSID\\{${clsid}}');`,
  );
  expect(script).toContain("HKCU64, Key");
  const perMachine = renderInnoScript({
    ...base,
    scope: "perMachine",
  });
  expect(perMachine).toContain(property);
  expect(perMachine).not.toContain("RemoveToastActivatorRegistration");
  expect(
    renderInnoScript({
      ...base,
      startMenuShortcut: false,
    }),
  ).not.toContain("AppUserModelToastActivatorCLSID");
});

const iscc = process.platform === "win32" ? await findIscc() : undefined;

async function run(command: string[]) {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    stdout,
    stderr,
    code,
  };
}

test.skipIf(!iscc)(
  "an installed shortcut carries the activator class and uninstall deletes the key the app wrote",
  async () => {
    if (!iscc) {
      throw new Error("Expected ISCC.");
    }
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-toast-activator-")),
    );
    const identifier = `app.test-${crypto.randomUUID()}`;
    const appId = `${identifier}.first`;
    const clsid = toastActivatorClsid(appId);
    const destination = join(root, "install");
    const key = `HKCU\\Software\\Classes\\CLSID\\{${clsid}}`;
    const setup = (flags: string[]) =>
      run([
        flags[0] ?? "",
        "/SP-",
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        ...flags.slice(1),
      ]);
    try {
      await mkdir(join(root, "stage", "app"), {
        recursive: true,
      });
      await mkdir(join(root, "stage", "installer"));
      await Bun.write(join(root, "stage", "app", "App.exe"), "1");
      const script = renderInnoScript({
        ...base,
        identifier,
        appId,
        appDataDir: `{localappdata}\\bunaway\\${appId}`,
        desktopShortcut: false,
        payloadDir: join(root, "stage", "app"),
        outputDir: join(root, "stage", "installer"),
      });
      const source = join(root, "stage", "setup.iss");
      await Bun.write(source, `\uFEFF${script}`);
      await must(iscc, [
        "/Q",
        source,
      ]);
      const installer = join(root, "stage", "installer", "setup.exe");
      expect(
        (
          await setup([
            installer,
            `/DIR=${destination}`,
          ])
        ).code,
      ).toBe(0);
      // The shortcut stores the class as a serialized property, so its bytes appear in the file.
      const group = join(
        process.env.APPDATA ?? "",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        identifier,
      );
      const shortcuts = (await readdir(group)).filter((name) =>
        name.endsWith(".lnk"),
      );
      const withClass = [];
      for (const name of shortcuts) {
        const bytes = Buffer.from(
          await Bun.file(join(group, name)).arrayBuffer(),
        );
        if (bytes.includes(guid(clsid))) {
          withClass.push(name);
        }
      }
      expect(withClass, shortcuts.join(", ")).toHaveLength(1);
      // The app writes this key when it starts; the uninstaller removes it.
      writeToastActivatorServer(clsid, join(destination, "App.exe"));
      expect(
        (
          await run([
            "reg.exe",
            "query",
            key,
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await setup([
            join(destination, "unins000.exe"),
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await run([
            "reg.exe",
            "query",
            key,
          ])
        ).code,
      ).not.toBe(0);
    } finally {
      await run([
        "reg.exe",
        "delete",
        key,
        "/f",
      ]);
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test.skipIf(!iscc)(
  "an upgrade adds the activator class to a Start menu shortcut made without it and keeps its arguments",
  async () => {
    if (!iscc) {
      throw new Error("Expected ISCC.");
    }
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-toast-upgrade-")),
    );
    const identifier = `app.test-${crypto.randomUUID()}`;
    const appId = `${identifier}.first`;
    const clsid = toastActivatorClsid(appId);
    const destination = join(root, "install");
    const group = join(
      process.env.APPDATA ?? "",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      identifier,
    );
    const options: InnoOptions = {
      ...base,
      identifier,
      appId,
      appDataDir: `{localappdata}\\bunaway\\${appId}`,
      desktopShortcut: false,
      payloadDir: join(root, "stage", "app"),
      outputDir: join(root, "stage", "installer"),
    };
    const build = async (script: string, name: string) => {
      const source = join(root, "stage", `${name}.iss`);
      await Bun.write(source, `﻿${script}`);
      await must(iscc, [
        "/Q",
        source,
      ]);
      return join(root, "stage", "installer", "setup.exe");
    };
    const install = async (installer: string) =>
      (
        await run([
          installer,
          "/SP-",
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
          `/DIR=${destination}`,
        ])
      ).code;
    const shortcutNames = async () =>
      (await readdir(group)).filter((name) => name.endsWith(".lnk"));
    try {
      await mkdir(join(root, "stage", "app"), {
        recursive: true,
      });
      await mkdir(join(root, "stage", "installer"));
      await Bun.write(join(root, "stage", "app", "App.exe"), "1");
      // An installer from before the activator existed wrote the same link without the class.
      const current = renderInnoScript(options);
      const property = `; AppUserModelToastActivatorCLSID: "{{${clsid}}"`;
      expect(current).toContain(property);
      const previous = current.replace(property, "");
      expect(await install(await build(previous, "previous"))).toBe(0);
      const [name] = await shortcutNames();
      expect(name).toBeDefined();
      const link = join(group, name ?? "");
      expect(
        Buffer.from(await Bun.file(link).arrayBuffer()).includes(guid(clsid)),
      ).toBe(false);
      const edit = await run([
        "powershell.exe",
        "-NoProfile",
        "-Command",
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${link.replace(/'/g, "''")}');$s.Arguments='--custom-flag';$s.Save()`,
      ]);
      expect(edit.code, edit.stderr).toBe(0);
      expect(await install(await build(current, "current"))).toBe(0);
      expect(await shortcutNames()).toEqual([
        name ?? "",
      ]);
      expect(
        Buffer.from(await Bun.file(link).arrayBuffer()).includes(guid(clsid)),
      ).toBe(true);
      const read = await run([
        "powershell.exe",
        "-NoProfile",
        "-Command",
        `(New-Object -ComObject WScript.Shell).CreateShortcut('${link.replace(/'/g, "''")}').Arguments`,
      ]);
      expect(read.stdout.trim()).toBe("--custom-flag");
    } finally {
      await run([
        join(destination, "unins000.exe"),
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
      ]);
      await run([
        "reg.exe",
        "delete",
        `HKCU\\Software\\Classes\\CLSID\\{${clsid}}`,
        "/f",
      ]);
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
