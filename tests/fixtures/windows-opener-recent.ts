import assert from "node:assert/strict";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import createOperationsDefinition from "#plugins/opener/src/index";
import { nativeFactory as createOperationsFactory } from "./native-platform.ts";

/**
 * Runs the Windows Recent Items checks in their own process. SHAddToRecentDocs
 * leaves Shell state behind (most likely a Shell worker thread that keeps a COM
 * multithreaded apartment alive), which makes every other thread of the process an
 * implicit MTA member. Tests that expect an uninitialized COM thread must therefore
 * not share a process with it.
 */
const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

const RECENT_POLL_ATTEMPTS = 50;
const RECENT_POLL_INTERVAL_MS = 100;
const RECENT_DIAGNOSTIC_FILE_COUNT = 20;
// clearRecentDocuments empties the whole user's Shell Recent Items, so a developer's
// real list must not be touched. Only disposable CI runners execute add and clear;
// elsewhere only the side-effect-free validation and disposal paths run.
const mutatesShellRecentItems = Boolean(
  process.env.CI || process.env.GITHUB_ACTIONS,
);
const RECENT_POLICY_VALUES = [
  [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
    "Start_TrackDocs",
  ],
  [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer",
    "NoRecentDocsHistory",
  ],
  [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer",
    "NoRecentDocsHistory",
  ],
  [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer",
    "ClearRecentDocsOnExit",
  ],
  [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer",
    "ClearRecentDocsOnExit",
  ],
] as const;

function recentFolder(): string {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error(
      "APPDATA is required to inspect the Windows Recent folder.",
    );
  }
  return join(appData, "Microsoft", "Windows", "Recent");
}

/** Read one DWORD with reg.exe; undefined means the value is not set. */
async function readRegistryDword(
  key: string,
  value: string,
): Promise<number | undefined> {
  const child = Bun.spawn(
    [
      "reg",
      "query",
      key,
      "/v",
      value,
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const output = await new Response(child.stdout).text();
  await child.exited;
  const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
  return match?.[1] ? Number.parseInt(match[1], 16) : undefined;
}

/** Describe why the Shell would not record documents, or undefined when recording is allowed. */
async function recentHistoryDisabledReason(): Promise<string | undefined> {
  const [trackDocs, hkcuPolicy, hklmPolicy] = await Promise.all(
    RECENT_POLICY_VALUES.slice(0, 3).map(([key, value]) =>
      readRegistryDword(key, value),
    ),
  );
  if (trackDocs === 0) {
    return "Explorer\\Advanced\\Start_TrackDocs is 0";
  }
  if (hkcuPolicy === 1 || hklmPolicy === 1) {
    return "Policies\\Explorer\\NoRecentDocsHistory is 1";
  }
  return undefined;
}

/** Collect registry state and the newest Recent entries for a failed add. */
async function recentDiagnostics(token: string): Promise<string> {
  const lines = [
    `target token: ${token}`,
  ];
  for (const [key, value] of RECENT_POLICY_VALUES) {
    lines.push(`${key}\\${value} = ${await readRegistryDword(key, value)}`);
  }
  const recent = recentFolder();
  const entries = await Promise.all(
    (await readdir(recent)).map(async (entry) => ({
      entry,
      modified: (await stat(join(recent, entry))).mtimeMs,
    })),
  );
  entries.sort((left, right) => right.modified - left.modified);
  lines.push(
    `newest ${RECENT_DIAGNOSTIC_FILE_COUNT} Recent entries of ${entries.length}:`,
    ...entries
      .slice(0, RECENT_DIAGNOSTIC_FILE_COUNT)
      .map(
        ({ entry, modified }) =>
          `  ${new Date(modified).toISOString()} ${entry}`,
      ),
  );
  return lines.join("\n");
}

/**
 * Poll the user's Recent folder, since the Shell writes the shortcut asynchronously.
 * The shortcut is matched by a unique token in the target name rather than the exact
 * file name, because the Shell may omit the extension from the shortcut name.
 */
async function waitForRecentShortcut(
  token: string,
  expected: boolean,
): Promise<boolean> {
  const recent = recentFolder();
  for (let attempt = 0; attempt < RECENT_POLL_ATTEMPTS; attempt++) {
    const present = (await readdir(recent)).some(
      (entry) => entry.endsWith(".lnk") && entry.includes(token),
    );
    if (present === expected) {
      return true;
    }
    await Bun.sleep(RECENT_POLL_INTERVAL_MS);
  }
  return false;
}

async function main(): Promise<void> {
  const root = resolve(
    import.meta.dir,
    `../../build/windows-opener-recent-${crypto.randomUUID()}`,
  );
  await mkdir(root, {
    recursive: true,
  });
  const token = crypto.randomUUID();
  const name = `최근 문서 ${token}.txt`;
  const target = join(root, name);
  await Bun.write(target, "recent document");
  const adapter = createOperations({
    dataRoot: root,
    capabilities: [],
  });
  const call = async (operation: string, payload: Record<string, string>) =>
    await adapter.execute(operation, payload, "backend");
  try {
    await assert.rejects(
      () =>
        call("opener.addRecentDocument", {
          path: `${target}.missing`,
        }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_ARGUMENT" &&
        "details" in error &&
        JSON.stringify(error.details) ===
          JSON.stringify({
            reason: "FILE_NOT_FOUND",
          }),
    );
    for (const path of [
      root,
      "relative.txt",
    ]) {
      await assert.rejects(
        () =>
          call("opener.addRecentDocument", {
            path,
          }),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "INVALID_ARGUMENT",
      );
    }

    if (mutatesShellRecentItems) {
      assert.equal(
        await call("opener.addRecentDocument", {
          path: target,
        }),
        null,
      );
      const disabledReason = await recentHistoryDisabledReason();
      if (disabledReason) {
        // The Shell ignores adds when history is off, so only the request path is covered.
        console.warn(
          `Recent shortcut check skipped: ${disabledReason}. The add path is not verified on this runner.`,
        );
      } else if (!(await waitForRecentShortcut(token, true))) {
        throw new Error(
          `No Recent shortcut appeared for ${name}.\n${await recentDiagnostics(token)}`,
        );
      }

      assert.equal(await call("opener.clearRecentDocuments", {}), null);
      assert(await waitForRecentShortcut(token, false));
    }

    await adapter.dispose();
    await adapter.dispose();
    await assert.rejects(
      () => call("opener.clearRecentDocuments", {}),
      (error) =>
        error instanceof Error && "code" in error && error.code === "CANCELLED",
    );
  } finally {
    await adapter.dispose();
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
}
