import { expect, test } from "bun:test";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import createOperationsDefinition from "#plugins/opener/src/index";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

const RECENT_POLL_ATTEMPTS = 50;
const RECENT_POLL_INTERVAL_MS = 100;
const RECENT_DIAGNOSTIC_FILE_COUNT = 20;
// Below the opener's 5 second dispose wait for stuck helpers.
const DISPOSE_BOUND_MS = 3000;
// clearRecentDocuments empties the whole user's Shell Recent Items, so a developer's
// real list must not be touched. Machines opt in with BUNAWAY_OPENER_RECENT_MUTATE=1.
// GitHub-hosted runners are disposable and count as opted in, because this change does
// not modify ci.yml and so cannot set the variable there. Self-hosted runners may be a
// developer's machine and must opt in explicitly.
const mutatesShellRecentItems =
  process.env.BUNAWAY_OPENER_RECENT_MUTATE === "1" ||
  process.env.RUNNER_ENVIRONMENT === "github-hosted";
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
/** Reports CoGetApartmentType's HRESULT for a thread that never initialized COM. */
const APARTMENT_PROBE_SOURCE = `
import { dlopen, ptr } from "bun:ffi";
import { parentPort } from "node:worker_threads";
const ole = dlopen("ole32.dll", {
  CoGetApartmentType: { args: ["ptr", "ptr"], returns: "i32" },
});
const type = new Uint32Array(1);
const qualifier = new Uint32Array(1);
parentPort.postMessage(ole.symbols.CoGetApartmentType(ptr(type), ptr(qualifier)));
ole.close();
`;

/**
 * Probe a fresh thread. A negative HRESULT (CO_E_NOTINITIALIZED) means the process has
 * no live MTA; a live MTA would make this thread an implicit member and succeed.
 */
async function freshThreadApartmentResult(): Promise<number> {
  const url = URL.createObjectURL(
    new Blob([
      APARTMENT_PROBE_SOURCE,
    ]),
  );
  const worker = new Worker(url);
  try {
    return await new Promise<number>((resolveResult, reject) => {
      worker.onmessage = (event) => resolveResult(event.data as number);
      worker.onerror = (event) => reject(new Error(event.message));
    });
  } finally {
    void worker.terminate();
    URL.revokeObjectURL(url);
  }
}

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

/** Collect registry state and the newest Recent entries for a failed check. */
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

// Runs before windows-opener.test.ts in the shared `bun test ./tests` process, which
// requires fresh threads to start without COM. The Shell call therefore runs on an
// isolated STA thread, and this test verifies the process keeps no apartment afterwards.
test.skipIf(process.platform !== "win32")(
  "recent documents add and clear through an isolated STA and leave no COM apartment in the process",
  async () => {
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
    let adapter = createOperations({
      dataRoot: root,
      capabilities: [],
    });
    const call = async (operation: string, payload: Record<string, string>) =>
      await adapter.execute(operation, payload, "backend");
    try {
      expect(
        await freshThreadApartmentResult(),
        "precondition: no earlier test left a COM apartment in this process",
      ).toBeLessThan(0);
      await expect(
        call("opener.addRecentDocument", {
          path: `${target}.missing`,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          details: {
            reason: "FILE_NOT_FOUND",
          },
        }),
      );
      for (const path of [
        root,
        "relative.txt",
      ]) {
        await expect(
          call("opener.addRecentDocument", {
            path,
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      }

      if (mutatesShellRecentItems) {
        expect(
          await call("opener.addRecentDocument", {
            path: target,
          }),
        ).toBeNull();
        expect(
          await freshThreadApartmentResult(),
          "add must not leave a COM apartment in the process",
        ).toBeLessThan(0);
        const disabledReason = await recentHistoryDisabledReason();
        if (disabledReason) {
          // The Shell ignores adds when history is off, so no shortcut can appear or disappear.
          console.warn(
            `Recent shortcut checks skipped: ${disabledReason}. Neither the add nor the clear result is verified on this runner.`,
          );
        } else if (!(await waitForRecentShortcut(token, true))) {
          throw new Error(
            `No Recent shortcut appeared for ${name}.\n${await recentDiagnostics(token)}`,
          );
        }

        expect(await call("opener.clearRecentDocuments", {})).toBeNull();
        expect(
          await freshThreadApartmentResult(),
          "clear must not leave a COM apartment in the process",
        ).toBeLessThan(0);
        if (!disabledReason && !(await waitForRecentShortcut(token, false))) {
          throw new Error(
            `The Recent shortcut for ${name} survived clearRecentDocuments.\n${await recentDiagnostics(token)}`,
          );
        }
      } else {
        console.warn(
          "Recent add and clear were not run: set BUNAWAY_OPENER_RECENT_MUTATE=1 on a disposable machine, because clearing empties the user's whole Shell Recent Items.",
        );
      }

      // Helpers that finished or were removed from tracking must not delay dispose;
      // only a stuck helper makes it wait out its 5 second bound.
      const disposeStarted = performance.now();
      await adapter.dispose();
      expect(performance.now() - disposeStarted).toBeLessThan(DISPOSE_BOUND_MS);
      await adapter.dispose();
      await expect(call("opener.clearRecentDocuments", {})).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
      expect(
        await freshThreadApartmentResult(),
        "dispose must balance the adapter's COM initialization",
      ).toBeLessThan(0);

      // A new adapter initializes cleanly after disposal and still validates input.
      adapter = createOperations({
        dataRoot: root,
        capabilities: [],
      });
      await expect(
        call("opener.addRecentDocument", {
          path: "relative.txt",
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
    } finally {
      await adapter.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  60_000,
);
