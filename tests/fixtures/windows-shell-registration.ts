import { realpathSync } from "node:fs";
import { attemptAllAsync } from "@bunaway/plugin";

/**
 * Registry and shell helpers for tests that make the real Windows shell start a registered
 * command. Every key lives under `HKCU\Software\Classes` with a random name, so a test never
 * touches a registration it did not create and cleanup deletes only those keys.
 */

const CLASSES_KEY = "HKCU\\Software\\Classes";

/** A `bwtest-` name unused by any app, so cleanup touches only this test's own keys. */
export function newShellTestName(): string {
  return `bwtest-${crypto.randomUUID().slice(0, 8)}`;
}

/** Runs a Windows tool that reads or writes the registry independently of the code under test. */
async function runTool(command: string[], env?: Record<string, string>) {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
    },
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

async function regAdd(key: string, name: string | null, data: string) {
  const result = await runTool([
    "reg",
    "add",
    key,
    ...(name === null
      ? [
          "/ve",
        ]
      : [
          "/v",
          name,
        ]),
    "/d",
    data,
    "/f",
  ]);
  if (result.code !== 0) {
    throw new Error(`reg add ${key} failed: ${result.stderr}`);
  }
}

/**
 * Deletes a key tree this test created. Absence is checked with `reg query`'s exit code rather
 * than the localized message of `reg delete`; an absent key is clean, and any other delete failure
 * (access denied, a lock) leaves a registration behind and is reported.
 */
async function regDelete(key: string) {
  const present = await runTool([
    "reg",
    "query",
    key,
  ]);
  if (present.code !== 0) {
    return;
  }
  const result = await runTool([
    "reg",
    "delete",
    key,
    "/f",
  ]);
  if (result.code !== 0) {
    throw new Error(`reg delete ${key} failed: ${result.stderr}`);
  }
}

/** Removes the scheme key `registerShellScheme` made; safe to call for a scheme never registered. */
export function deleteShellScheme(scheme: string): Promise<void> {
  return regDelete(`${CLASSES_KEY}\\${scheme}`);
}

/** Removes the extension and ProgId keys `registerShellExtension` made; safe to repeat. */
export function deleteShellExtension(extension: string): Promise<void> {
  return attemptAllAsync(
    [
      () => regDelete(`${CLASSES_KEY}\\${extension}`),
      () => regDelete(`${CLASSES_KEY}\\${extension.slice(1)}-file`),
    ],
    `Could not remove the ${extension} registration`,
  );
}

/** Rethrows `error` after running `cleanup`; a cleanup failure is reported together with it. */
async function failAfterCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [
        error,
        cleanupError,
      ],
      "A registration failed and its partial keys could not be removed",
    );
  }
  throw error;
}

/**
 * The command a registration runs: the executable, fixed arguments, then the shell's `%1`.
 * It has the shape of the commands the installer and `opener.registerUrlScheme` write.
 */
export function shellCommand(executable: string, ...fixed: string[]): string {
  return [
    executable,
    ...fixed,
    "%1",
  ]
    .map((part) => (part === "%1" ? '"%1"' : `"${part}"`))
    .join(" ");
}

/**
 * Registers `scheme` as a URL protocol whose open command is `command`; returns its cleanup.
 * A failure part way removes what was already written before it is thrown.
 */
export async function registerShellScheme(
  scheme: string,
  command: string,
): Promise<() => Promise<void>> {
  const key = `${CLASSES_KEY}\\${scheme}`;
  try {
    await regAdd(key, null, `URL:${scheme}`);
    await regAdd(key, "URL Protocol", "");
    await regAdd(`${key}\\shell\\open\\command`, null, command);
  } catch (error) {
    return failAfterCleanup(error, () => deleteShellScheme(scheme));
  }
  return () => deleteShellScheme(scheme);
}

/**
 * Associates `extension` (with its dot) with a ProgId whose open command is `command`, the way
 * the installer does. A random extension has no UserChoice, so the HKCU association applies.
 * Returns the cleanup that removes both keys; a failure part way removes what was written.
 */
export async function registerShellExtension(
  extension: string,
  command: string,
): Promise<() => Promise<void>> {
  const progId = `${extension.slice(1)}-file`;
  try {
    await regAdd(`${CLASSES_KEY}\\${extension}`, null, progId);
    await regAdd(
      `${CLASSES_KEY}\\${progId}\\shell\\open\\command`,
      null,
      command,
    );
  } catch (error) {
    return failAfterCleanup(error, () => deleteShellExtension(extension));
  }
  return () => deleteShellExtension(extension);
}

/**
 * Asks the shell to open `target` through `ShellExecuteEx`, as a double click or a link does.
 * The target and the working directory travel in environment variables, so no quoting layer of
 * PowerShell or `cmd` can change them before the shell sees them. Resolves when the shell call
 * returns, not when the started program finishes.
 */
export async function shellOpen(target: string, cwd: string): Promise<void> {
  const result = await runTool(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:BW_SHELL_TARGET -WorkingDirectory $env:BW_SHELL_CWD",
    ],
    {
      BW_SHELL_TARGET: target,
      BW_SHELL_CWD: cwd,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `Start-Process failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  }
}

/** Resolves 8.3 and case differences so two spellings of one path compare equal. */
export function canonicalPath(path: string): string {
  return realpathSync.native(path);
}
