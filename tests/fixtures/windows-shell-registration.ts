import { realpathSync } from "node:fs";

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

/** Deletes a key tree this test created; a missing key is already clean. */
async function regDelete(key: string) {
  await runTool([
    "reg",
    "delete",
    key,
    "/f",
  ]);
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

/** Registers `scheme` as a URL protocol whose open command is `command`; returns its cleanup. */
export async function registerShellScheme(
  scheme: string,
  command: string,
): Promise<() => Promise<void>> {
  const key = `${CLASSES_KEY}\\${scheme}`;
  await regAdd(key, null, `URL:${scheme}`);
  await regAdd(key, "URL Protocol", "");
  await regAdd(`${key}\\shell\\open\\command`, null, command);
  return () => regDelete(key);
}

/**
 * Associates `extension` (with its dot) with a ProgId whose open command is `command`, the way
 * the installer does. A random extension has no UserChoice, so the HKCU association applies.
 * Returns the cleanup that removes both keys.
 */
export async function registerShellExtension(
  extension: string,
  command: string,
): Promise<() => Promise<void>> {
  const progId = `${extension.slice(1)}-file`;
  const progIdKey = `${CLASSES_KEY}\\${progId}`;
  await regAdd(`${CLASSES_KEY}\\${extension}`, null, progId);
  await regAdd(`${progIdKey}\\shell\\open\\command`, null, command);
  return async () => {
    await regDelete(`${CLASSES_KEY}\\${extension}`);
    await regDelete(progIdKey);
  };
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
