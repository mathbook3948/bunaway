import { expect, test } from "bun:test";
import {
  type InnoOptions,
  renderInnoScript,
} from "#packaging/channels/windows/inno";

const base: InnoOptions = {
  name: "Relocation fixture",
  identifier: "com.example.relocation",
  appId: "app.relocation",
  version: "1.0.0",
  publisher: "Test",
  scope: "perUser",
  payloadDir: "C:\\stage\\app",
  payloadListPath: "C:\\stage\\payload-files.txt",
  outputDir: "C:\\stage\\installer",
  outputBaseName: "setup",
  desktopShortcut: true,
  startMenuShortcut: true,
  webView2: "check",
  appDataDir: "{localappdata}\\bunaway\\app.relocation",
  preserveUserData: true,
  assetPaths: [],
  executableName: "App.exe",
};

/** Source of one Pascal procedure or function, up to the next blank line after its `end;`. */
function routine(script: string, name: string) {
  const start = script.search(
    new RegExp(`^(procedure|function) ${name}\\b`, "m"),
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf("\nend;\n", start);
  return script.slice(start, end + "\nend;\n".length);
}

test("a relocated installation is removed by named files, never by running the old uninstaller", () => {
  const script = renderInnoScript(base);
  // The uninstall record stays an overwritten snapshot and the old uninstaller is only deleted.
  expect(script).toContain("UninstallLogMode=overwrite");
  expect(script).not.toMatch(/Exec\([^)]*unins/i);
  expect(script).not.toContain("DelTree");
  expect(script).not.toMatch(/DeleteFile\([^)]*\*/);
  expect(script).toContain('DestName: "payload-files.txt"; Flags: dontcopy');
});

test("the previous Inno record is read before Setup rewrites it and rechecked before installing", () => {
  const script = renderInnoScript(base);
  const init = routine(script, "InitializeSetup");
  expect(init.indexOf("CaptureInstallationSnapshot")).toBeLessThan(
    init.indexOf("CaptureRelocationRecord"),
  );
  const steps = routine(script, "CurStepChanged");
  expect(steps).toContain("ValidateRelocationRecord");
  expect(steps.indexOf("ValidateRelocationRecord")).toBeLessThan(
    steps.indexOf("Exit;"),
  );
});

test("the previous folder is removed only after registrations and shortcuts name the new executable", () => {
  const script = renderInnoScript(base);
  const complete = routine(script, "CompleteInstallation");
  const order = [
    "UpdateShortcut(",
    "UpdateUninstallShortcut(",
    "RemovePreviousExecutable(",
    "RemoveRelocatedInstallationWithPayload",
  ].map((marker) => complete.indexOf(marker));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual(
    [
      ...order,
    ].sort((a, b) => a - b),
  );
  // The removal runs only when the registration stage reported no error.
  expect(complete).toContain("if PostInstallError = '' then begin");
  const install = routine(script, "CurStepChanged");
  expect(install.indexOf("InstallAssociations")).toBeLessThan(
    install.indexOf("CompleteInstallation"),
  );
  expect(install.indexOf("InstallAutostart")).toBeLessThan(
    install.indexOf("CompleteInstallation"),
  );
});

test("the old folder is trusted only when plain, local, unrelated to the new folder and recorded by Inno", () => {
  const script = renderInnoScript(base);
  const safe = routine(script, "IsSafeRelocationSource");
  expect(safe).toContain("Dir[2] <> ':'");
  expect(safe).toContain("IsNestedDirectory(Dir, ExpandConstant('{app}'))");
  expect(safe).toContain("IsNestedDirectory(ExpandConstant('{app}'), Dir)");
  expect(safe).toContain("IsProtectedRelocationDirectory(Dir)");
  expect(safe).toContain("IsPlainDirectoryChain(Dir)");
  expect(safe).not.toContain("{commonpf}");
  const uninstaller = routine(script, "RelocationUninstallerPath");
  expect(uninstaller).toContain("IsSameDirectory(RelocationAppPath, Dir)");
  expect(uninstaller).toContain("IsUninstallerFileName");
});

test("a per-machine installation is removed only below Program Files", () => {
  const script = renderInnoScript({
    ...base,
    scope: "perMachine",
    autostart: false,
  });
  const safe = routine(script, "IsSafeRelocationSource");
  expect(safe).toContain(
    "IsNestedDirectory(ExpandConstant('{commonpf}'), Dir)",
  );
  expect(script).not.toContain("HKCU");
});

test("without a payload list only the executable and uninstaller of the old folder are removed", () => {
  const { payloadListPath: _omitted, ...withoutList } = base;
  const script = renderInnoScript(withoutList);
  expect(script).not.toContain("payload-files.txt");
  expect(routine(script, "RemoveRelocatedInstallationWithPayload")).toContain(
    "Payload := nil;",
  );
});
