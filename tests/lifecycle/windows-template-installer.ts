import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findIscc } from "#packaging/channels/windows/common";
import { innoIdentity } from "#packaging/channels/windows/inno-identity";
import { type DeadlineName, waitFor } from "../fixtures/deadlines.ts";

/**
 * The installer half of the Windows template check: packages a generated project with
 * `bunaway package win-direct`, installs the Inno installer silently into a folder this run
 * owns, lets the caller start the installed EXE, and removes the installation again. Callers pass
 * the process runner and the launch check, so the deadlines, process-tree kill and probe
 * assertions stay in one place (`windows-templates.ts`).
 */

export type StepOutcome = {
  ok: boolean;
  output: string;
};

/** Runs a command to completion within a named deadline; see `execute` in `windows-templates.ts`. */
export type RunStep = (
  command: string[],
  cwd: string,
  limit: DeadlineName,
  scale?: number,
  env?: Record<string, string | undefined>,
) => Promise<StepOutcome>;

/** The installer is a small program that packs and compresses a whole compiled app. */
const PACKAGE_DEADLINE_SCALE = 3;
/** The Inno switches shared by installing and uninstalling without any window or reboot. */
const SILENT_SWITCHES = [
  "/VERYSILENT",
  "/SUPPRESSMSGBOXES",
  "/NORESTART",
];
/** Pause between checks while the uninstaller, which exits before it has finished, removes files. */
const UNINSTALL_POLL_MS = 100;
/** Setup's own file listing the installed files; present only while an installation exists. */
const UNINSTALLER_NAME = "unins000.exe";
/** How `execute` in `windows-templates.ts` begins the output of a command that hit its deadline. */
const TIMED_OUT_PREFIX = "timed out after";
const INSTALLER_ARTIFACT_PATTERN = /^Artifact: (.+) \(installer\)$/m;
const INNO_INSTALL_SCRIPT = resolve(
  import.meta.dir,
  "../../.github/actions/install-inno-setup/install.ps1",
);

/**
 * Makes sure Inno Setup's compiler exists. The CI job that runs the template check installs the
 * pinned version through the shared script; on a developer machine nothing is installed for the
 * user, because that install is machine-wide and needs administrator rights.
 */
async function ensureInnoCompiler(run: RunStep): Promise<void> {
  if ((await findIscc()) !== undefined) {
    return;
  }
  assert(
    process.env.CI === "true",
    "Inno Setup 6 is required to package the templates; install it before running this check.",
  );
  const installed = await run(
    [
      "pwsh",
      "-NoProfile",
      "-File",
      INNO_INSTALL_SCRIPT,
    ],
    resolve(import.meta.dir, "../.."),
    "packagedAudit",
  );
  assert(installed.ok, `installing Inno Setup failed:\n${installed.output}`);
  assert(
    (await findIscc()) !== undefined,
    "Inno Setup is not found after its installation",
  );
}

/**
 * Gives the project a random bundle identifier, which the Inno AppId and its uninstall registry
 * key derive from, so this installation cannot be taken for another one on the machine. The rest
 * of the template's packaging settings stay as generated.
 */
async function useUniqueIdentifier(app: string): Promise<string> {
  const settingsPath = resolve(app, "src-bunaway/bunaway.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
    bundle?: Record<string, unknown>;
  };
  assert(settings.bundle !== undefined, "the template has no bundle settings");
  const identifier = `test.bunaway.template-${crypto.randomUUID().slice(0, 8)}`;
  settings.bundle.identifier = identifier;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return identifier;
}

/** Runs the uninstaller and waits for it to finish, since its launcher exits first. */
async function uninstall(
  run: RunStep,
  installDirectory: string,
  cwd: string,
): Promise<StepOutcome> {
  const uninstaller = resolve(installDirectory, UNINSTALLER_NAME);
  if (!existsSync(uninstaller)) {
    return {
      ok: true,
      output: "",
    };
  }
  const removal = await run(
    [
      uninstaller,
      ...SILENT_SWITCHES,
    ],
    cwd,
    "build",
  );
  if (!removal.ok) {
    return removal;
  }
  try {
    // Setup deletes the uninstaller first and the folder after it, so both are awaited. A folder
    // that stays is reported with its contents by `assertNothingLeft`, not by this wait.
    await waitFor(() => !existsSync(uninstaller), {
      deadline: "build",
      what: "the uninstaller to remove the installation",
      intervalMs: UNINSTALL_POLL_MS,
    });
    await waitFor(() => !existsSync(installDirectory), {
      deadline: "childStep",
      what: "Setup to remove the install folder",
      intervalMs: UNINSTALL_POLL_MS,
    }).catch((error: unknown) => {
      console.log(error instanceof Error ? error.message : String(error));
    });
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
  return removal;
}

/** Fails when Setup left files or the registered uninstall entry behind after the removal. */
async function assertNothingLeft(
  run: RunStep,
  installDirectory: string,
  uninstallKey: string,
  cwd: string,
): Promise<void> {
  const leftover = existsSync(installDirectory)
    ? (
        await readdir(installDirectory, {
          recursive: true,
        })
      ).join(", ")
    : "";
  assert(
    !existsSync(installDirectory),
    `the install folder remains after uninstall: ${leftover}`,
  );
  const registration = await run(
    [
      "reg",
      "query",
      uninstallKey,
    ],
    cwd,
    "childExit",
  );
  // `reg query` exits 1 for a missing key; a command that timed out says nothing about the key.
  assert(
    !registration.ok && !registration.output.startsWith(TIMED_OUT_PREFIX),
    `the uninstall entry ${uninstallKey} remains or could not be queried:\n${registration.output}`,
  );
}

/**
 * Packages the project for `win-direct`, installs the result into `home`, starts the installed
 * EXE through `launch`, then uninstalls and checks that the install folder and the registered
 * uninstall entry are gone. The uninstall runs on every path, so a failed launch does not leave
 * the installation on the machine; a failure of the removal itself fails the step too.
 */
export async function packageAndInstall(options: {
  app: string;
  home: string;
  appId: string;
  run: RunStep;
  /** Starts the EXE and verifies the probe's result; `tag` keeps its data apart from other launches. */
  launch: (executable: string, tag: string) => Promise<StepOutcome>;
}): Promise<StepOutcome> {
  const { app, home, appId, run } = options;
  await ensureInnoCompiler(run);
  const identifier = await useUniqueIdentifier(app);
  const packaged = await run(
    [
      process.execPath,
      "run",
      "package",
      "win-direct",
    ],
    app,
    "packagedAudit",
    PACKAGE_DEADLINE_SCALE,
  );
  if (!packaged.ok) {
    return packaged;
  }
  const setup = INSTALLER_ARTIFACT_PATTERN.exec(packaged.output)?.[1];
  assert(
    setup !== undefined && existsSync(resolve(app, setup)),
    `bunaway package reported no installer:\n${packaged.output.slice(-1_000)}`,
  );
  const installDirectory = resolve(home, `install-${identifier}`);
  const uninstallKey = `HKCU\\${innoIdentity(identifier).previousDataKey}`;
  let outcome: StepOutcome;
  try {
    const installed = await run(
      [
        resolve(app, setup),
        "/SP-",
        ...SILENT_SWITCHES,
        `/LOG=${resolve(home, `install-${identifier}.log`)}`,
        `/DIR=${installDirectory}`,
      ],
      home,
      "packagedAudit",
    );
    assert(installed.ok, `the installer failed:\n${installed.output}`);
    const executable = resolve(installDirectory, `${appId}.exe`);
    assert(existsSync(executable), `${executable} is not installed`);
    const registration = await run(
      [
        "reg",
        "query",
        uninstallKey,
      ],
      home,
      "childExit",
    );
    assert(registration.ok, `no uninstall entry ${uninstallKey} after install`);
    outcome = await options.launch(executable, "installed");
  } catch (error) {
    outcome = {
      ok: false,
      output:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
  const removal = await uninstall(run, installDirectory, home);
  if (!removal.ok) {
    return {
      ok: false,
      output: `${outcome.output}\nuninstall failed:\n${removal.output}`,
    };
  }
  try {
    await assertNothingLeft(run, installDirectory, uninstallKey, home);
  } catch (error) {
    return {
      ok: false,
      output: `${outcome.output}\n${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return outcome;
}
