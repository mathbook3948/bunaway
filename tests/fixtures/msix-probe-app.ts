import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeEnvironment } from "@bunaway/plugin";
import { localAppData } from "#native/windows/bun/config";
import { openRequest } from "#native/windows/bun/desktop";
import { parseLaunchArguments } from "#native/windows/bun/instance";
import { initialize as initializeUpdater } from "#plugins/updater/src/platforms/windows";
import { createPackageQueries } from "#plugins/updater/src/platforms/windows-package-identity";

/**
 * Compiled with `define` values from tests/packaging/windows-msix-probe.test.ts. It has no window:
 * it measures what a process started by Windows (shell activation, protocol, file) sees, with
 * the same functions the framework uses at startup, and writes one JSON report per launch kind.
 */
declare const PROBE_OUTPUT: string;
declare const PROBE_APP_ID: string;
declare const PROBE_SCHEME: string;

/** The report for a launch is named after how the process was started. */
function launchKind(args: readonly string[]): string {
  if (args.length === 0) {
    return "plain";
  }
  return args[0]?.toLowerCase().startsWith(`${PROBE_SCHEME}:`)
    ? "protocol"
    : "file";
}

/** Writes a marker file under `root` and reads it back, reporting where it was written. */
function mark(root: string | undefined) {
  if (!root) {
    return {
      error: "root variable is not set",
    };
  }
  try {
    const folder = join(root, "bunaway", PROBE_APP_ID);
    mkdirSync(folder, {
      recursive: true,
    });
    const path = join(folder, "probe.txt");
    writeFileSync(path, "probe");
    return {
      path,
      readBack: readFileSync(path, "utf8"),
    };
  } catch (error) {
    return {
      error: String(error),
    };
  }
}

/** What updater.check does here: the install-owner check runs before any request is made. */
async function updateCheck() {
  const environment: NativeEnvironment = {
    dataRoot: join(PROBE_OUTPUT, "data"),
    capabilities: [],
    app: {
      id: PROBE_APP_ID,
      version: "1.0.0",
      pluginSettings: {
        updater: {
          endpoint: "https://127.0.0.1:1/{{target}}/{{channel}}",
        },
      },
      launch: {
        mode: "packaged",
        executablePath: process.execPath,
        args: [],
      },
    },
  };
  const updater = initializeUpdater(environment);
  try {
    await updater.check();
    return {
      outcome: "resolved",
    };
  } catch (error) {
    const failure = error as {
      code?: string;
      details?: {
        reason?: string;
      };
    };
    return {
      outcome: "rejected",
      code: failure.code,
      reason: failure.details?.reason,
    };
  } finally {
    await updater.dispose();
  }
}

function launchRequest(args: string[]) {
  try {
    const parsed = openRequest(
      {
        argv: args,
        cwd: process.cwd(),
      },
      "initial",
    );
    return {
      urls: [
        ...parsed.urls,
      ],
      files: [
        ...parsed.files,
      ],
    };
  } catch (error) {
    return {
      error: String(error),
    };
  }
}

function launchValidity(args: string[]): string {
  try {
    parseLaunchArguments({
      argv: args,
      cwd: process.cwd(),
    });
    return "valid";
  } catch (error) {
    return String(error);
  }
}

const args = process.argv.slice(2);
const packagePath = createPackageQueries(process.execPath).packagePath();
const packaged = packagePath !== null;
const report = {
  packaged,
  packagePath,
  execPath: process.execPath,
  cwd: process.cwd(),
  argv: process.argv,
  environment: {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
  },
  localAppData: localAppData(),
  launchArguments: launchValidity(args),
  request: launchRequest(args),
  update: await updateCheck(),
  localMarker: mark(localAppData()),
  roamingMarker: mark(process.env.APPDATA),
};
mkdirSync(PROBE_OUTPUT, {
  recursive: true,
});
const target = join(
  PROBE_OUTPUT,
  `${packaged ? "packaged" : "direct"}-${launchKind(args)}.json`,
);
// Renamed into place so the test never reads a half-written report.
writeFileSync(`${target}.tmp`, JSON.stringify(report, null, 2));
renameSync(`${target}.tmp`, target);
