import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attemptAllAsync } from "@bunaway/plugin";
import safeStorage from "@bunaway/plugin-safe-storage/native/windows";
import {
  type DeadlineName,
  deadline,
  killAfter,
  waitFor,
} from "../fixtures/deadlines.ts";

// Account setup, the second user's first logon (bounded by LAUNCH_WAIT) and cleanup run in order,
// so the test limit covers all of them with their own limits.
setDefaultTimeout(deadline("packagedAudit") + deadline("nativeFixture"));

const FIXTURE = join(import.meta.dir, "fixtures/windows-dpapi-other-user.ts");
const FIRST_USER_TEXT = "first user 한글🙂";
/** How long the second user's process may run before it is killed; includes profile creation. */
const LAUNCH_WAIT: DeadlineName = "build";
/** Exit code the launcher script reports when it had to kill a second-user process that hung. */
const LAUNCH_TIMED_OUT = 124;
const MIN_BLOB_BYTES = 16;

type Finished = {
  code: number;
  output: string;
  errors: string;
};

/**
 * The environment for a Windows tool. PowerShell 7 exports a `PSModulePath` that Windows
 * PowerShell 5.1 cannot load modules from, so the variable is dropped and 5.1 derives its own.
 */
function childEnvironment(extra: Record<string, string>) {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    ...extra,
  };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") {
      delete environment[key];
    }
  }
  return environment;
}

/**
 * Runs a Windows tool and collects its output. A failure message carries the output, never the
 * arguments, because `net user` receives the temporary account password as an argument.
 */
async function run(
  command: string[],
  env: Record<string, string> = {},
  limit: DeadlineName = "childStep",
): Promise<Finished> {
  const child = Bun.spawn(command, {
    env: childEnvironment(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = killAfter(child, limit);
  try {
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      output,
      errors,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runOrThrow(what: string, command: string[]): Promise<Finished> {
  const finished = await run(command);
  if (finished.code !== 0) {
    throw new Error(
      `${what} failed with ${finished.code}: ${finished.output}${finished.errors}`,
    );
  }
  return finished;
}

/** Runs a PowerShell command in Windows PowerShell 5.1, which every runner has. */
function powershell(command: string, env: Record<string, string> = {}) {
  return run(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ],
    env,
  );
}

/** `net user` asks for confirmation (and fails without a console) above this many characters. */
const NET_USER_PASSWORD_LIMIT = 14;

/** A random password that satisfies the default complexity policy and never reaches a log. */
function temporaryPassword(): string {
  const prefix = "Aa1!";
  return (
    prefix +
    crypto
      .randomUUID()
      .replaceAll("-", "")
      .slice(0, NET_USER_PASSWORD_LIMIT - prefix.length)
  );
}

/**
 * Starts `bun` as the second user with `Start-Process -Credential`, which logs the account on and
 * loads its profile so DPAPI can create that user's master key. The password is read once and
 * removed from the environment before the child starts, so the second user's process never sees
 * it. A child still running after `XUSER_WAIT_MS` is killed with its tree, because it runs as
 * another user and would otherwise keep the profile and the shared folder open.
 */
const LAUNCH_AS_USER = `
$ErrorActionPreference = 'Stop'
$secret = ConvertTo-SecureString $env:XUSER_PASSWORD -AsPlainText -Force
Remove-Item Env:XUSER_PASSWORD
$credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\\$env:XUSER_NAME", $secret)
$process = Start-Process -FilePath $env:XUSER_BUN -ArgumentList @('--no-env-file', $env:XUSER_SCRIPT, $env:XUSER_FOREIGN, $env:XUSER_OWN, $env:XUSER_RESULT) -Credential $credential -LoadUserProfile -WorkingDirectory $env:XUSER_DIR -RedirectStandardOutput $env:XUSER_STDOUT -RedirectStandardError $env:XUSER_STDERR -PassThru
if (-not $process.WaitForExit([int]$env:XUSER_WAIT_MS)) {
  taskkill /F /T /PID $process.Id | Out-Null
  exit ${LAUNCH_TIMED_OUT}
}
exit $process.ExitCode
`;

/**
 * Creates and deletes a local account, so it runs only in its own process
 * (`BUNAWAY_CROSS_USER_TEST=1`, set by `tests/lifecycle/run-native.ts`), never inside the shared
 * full-suite process where account and profile changes disturbed the window-capture tests.
 */
const enabled =
  process.platform === "win32" && process.env.BUNAWAY_CROSS_USER_TEST === "1";

test.skipIf(!enabled)(
  "a blob protected by one local user cannot be unprotected by another local user, in either direction",
  async () => {
    const create = safeStorage._definition.nativePlatforms.windows?.create;
    if (!create) {
      throw new Error("Windows data protection adapter is missing.");
    }
    const adapter = create({
      dataRoot: "unused",
      capabilities: [],
    });
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    // SAM account names stop at 20 characters.
    const name = `bwx${suffix}`;
    const password = temporaryPassword();
    // C:\Users\Public is readable by every local account; the repository checkout may not be.
    const shared = join(
      process.env.PUBLIC ?? "C:\\Users\\Public",
      `bunaway-xuser-${suffix}`,
    );
    const file = (leaf: string) => join(shared, leaf);
    // Set before `net user /add` runs: a command killed at its limit may still have created the
    // account, so cleanup asks Windows whether the account exists instead of trusting the exit code.
    let accountAttempted = false;
    let sid: string | undefined;
    try {
      await mkdir(shared, {
        recursive: true,
      });
      accountAttempted = true;
      await runOrThrow("creating the temporary account", [
        "net",
        "user",
        name,
        password,
        "/add",
        "/expires:never",
      ]);
      sid = (
        await runOrThrow("reading the account SID", [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-LocalUser -Name '${name}').SID.Value`,
        ])
      ).output.trim();
      await runOrThrow("granting the account access to the shared folder", [
        "icacls",
        shared,
        "/grant",
        `*${sid}:(OI)(CI)M`,
      ]);
      // The second user cannot read the first user's tool cache or the checkout, so it runs a copy
      // of Bun on a single bundled file.
      await copyFile(process.execPath, file("bun.exe"));
      const built = await Bun.build({
        entrypoints: [
          FIXTURE,
        ],
        target: "bun",
        outdir: shared,
      });
      expect(built.success, built.logs.join("\n")).toBe(true);

      const firstBlob = await adapter.execute(
        "safe-storage.encryptString",
        {
          text: FIRST_USER_TEXT,
        },
        "backend",
      );
      if (typeof firstBlob !== "string") {
        throw new Error("Ciphertext must be base64.");
      }
      await writeFile(file("first.blob"), firstBlob);

      const launched = await run(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          LAUNCH_AS_USER,
        ],
        {
          XUSER_NAME: name,
          XUSER_PASSWORD: password,
          XUSER_BUN: file("bun.exe"),
          XUSER_SCRIPT: file("windows-dpapi-other-user.js"),
          XUSER_FOREIGN: file("first.blob"),
          XUSER_OWN: file("second.blob"),
          XUSER_RESULT: file("result.json"),
          XUSER_DIR: shared,
          XUSER_STDOUT: file("stdout.log"),
          XUSER_STDERR: file("stderr.log"),
          XUSER_WAIT_MS: String(deadline(LAUNCH_WAIT)),
        },
        // Backstop for the launcher itself; the script kills a hung child sooner.
        "nativeFixture",
      );
      const diagnostics = async () =>
        `${launched.output}${launched.errors}${await readFile(file("stderr.log"), "utf8").catch(() => "")}`;
      expect(launched.code, await diagnostics()).toBe(0);

      const result = JSON.parse(await readFile(file("result.json"), "utf8"));
      // The fixture reports the account of its process token, so a run that stayed on the first
      // user's account cannot pass.
      expect(String(result.user).toLowerCase()).toBe(name.toLowerCase());
      // The second user's own DPAPI works, so its refusal below comes from the user boundary.
      expect(result.ownRoundTrip).toBe(true);
      expect(result.foreign).toEqual({
        decrypted: false,
        code: "INTERNAL",
      });

      const secondBlob = await readFile(file("second.blob"), "utf8");
      // A well-formed blob, so the refusal below is not an artifact of an empty or damaged file.
      expect(Buffer.from(secondBlob, "base64").length).toBeGreaterThan(
        MIN_BLOB_BYTES,
      );
      await expect(
        adapter.execute(
          "safe-storage.decryptString",
          {
            ciphertext: secondBlob,
          },
          "backend",
        ),
      ).rejects.toMatchObject({
        code: "INTERNAL",
      });
      // The first user still reads its own blob after the second user touched DPAPI.
      expect(
        await adapter.execute(
          "safe-storage.decryptString",
          {
            ciphertext: firstBlob,
          },
          "backend",
        ),
      ).toBe(FIRST_USER_TEXT);
    } finally {
      await attemptAllAsync(
        [
          () => adapter.dispose(),
          // A process of the second user left by a failed run would keep its profile loaded.
          async () => {
            if (accountAttempted) {
              await run([
                "taskkill",
                "/F",
                "/T",
                "/FI",
                `USERNAME eq ${process.env.COMPUTERNAME}\\${name}`,
              ]);
            }
          },
          async () => {
            const exists =
              accountAttempted &&
              (
                await run([
                  "net",
                  "user",
                  name,
                ])
              ).code === 0;
            if (exists) {
              await runOrThrow("deleting the temporary account", [
                "net",
                "user",
                name,
                "/delete",
              ]);
            }
          },
          // Logging the account on created a profile folder and registry entry that outlive it.
          // Windows releases the profile hive a moment after the last process ends, so removal
          // is retried until it succeeds or the deadline names the failure.
          async () => {
            if (!sid) {
              return;
            }
            const removeProfile = `Get-CimInstance Win32_UserProfile -Filter "SID='${sid}'" | Remove-CimInstance -ErrorAction Stop`;
            await waitFor(
              async () => (await powershell(removeProfile)).code === 0,
              {
                deadline: "childStep",
                what: "removal of the temporary user profile",
                intervalMs: 500,
              },
            );
          },
          () =>
            rm(shared, {
              recursive: true,
              force: true,
            }),
        ],
        "Cleaning up the cross-user DPAPI test failed.",
      );
    }
  },
);
