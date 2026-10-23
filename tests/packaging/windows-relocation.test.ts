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
  expect(uninstaller).toContain("IsUninstallerIn(Path, Dir)");
  expect(routine(script, "IsUninstallerIn")).toContain("IsUninstallerFileName");
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

test("a folder reached through another path is detected by a probe before anything is removed", () => {
  const script = renderInnoScript(base);
  const remove = routine(script, "RemoveRelocatedInstallation");
  const probe = remove.indexOf("IsNewFolderOnDisk(Dir)");
  expect(probe).toBeGreaterThan(0);
  expect(probe).toBeLessThan(remove.indexOf("DeleteRelocationFile("));
  // An unwritable probe counts as the same folder, so the safe outcome is to keep the files.
  expect(routine(script, "IsNewFolderOnDisk")).toContain("Result := True;");
});

test("a shortcut that could not be updated keeps the old folder and fails the run for a retry", () => {
  const script = renderInnoScript(base);
  const remove = routine(script, "RemoveRelocatedInstallationWithPayload");
  expect(remove.indexOf("RelocationShortcutFailed")).toBeLessThan(
    remove.indexOf("RemoveRelocatedInstallation("),
  );
  expect(remove).toContain("RaiseException(");
});

test("the old uninstaller path survives a failed attempt and is cleared with the pending predecessor", () => {
  const script = renderInnoScript(base);
  const register = routine(script, "RegisterPreviousData");
  expect(register).toContain(
    "SaveRelocationPendingUninstaller(PreviousDataKey)",
  );
  const steps = routine(script, "CurStepChanged");
  expect(steps.indexOf("ClearPendingAssociationOwner")).toBeLessThan(
    steps.indexOf("ClearRelocationPendingUninstaller"),
  );
});

test("user known folders are never removed as an old installation folder", () => {
  const protectedFolders = routine(
    renderInnoScript(base),
    "IsProtectedRelocationDirectory",
  );
  for (const folder of [
    "{userdesktop}",
    "{userdocs}",
    "{userappdata}",
    "{commonappdata}",
  ]) {
    expect(protectedFolders).toContain(folder);
  }
});

test("a shortcut that exists but cannot be read counts as a failed update, and only fixed drives are cleaned", () => {
  const script = renderInnoScript(base);
  const read = routine(script, "ReadShortcut");
  expect(read).toContain("RelocationShortcutFailed := True;");
  const safe = routine(script, "IsSafeRelocationSource");
  expect(safe).toContain("GetRelocationDriveType(Copy(Dir, 1, 3)) <> 3");
});

test("a link whose start folder is the old install folder gets the new folder", () => {
  const update = routine(renderInnoScript(base), "UpdateShortcut");
  expect(update).toContain("WorkingDirectory := Link.WorkingDirectory;");
  expect(update).toContain("Link.WorkingDirectory := ExpandConstant('{app}');");
});
