import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { must, run, toolFailure } from "../../tools.ts";
import { type Channel, directory, plistStrings } from "./common.ts";

const DMG_CREATE_MAX_ATTEMPTS = 3;
/** Pause before each retry; one entry per retry, so its length is `DMG_CREATE_MAX_ATTEMPTS - 1`. */
const DMG_CREATE_RETRY_DELAYS_MS = [
  1_000,
  2_000,
];
const DMG_BUSY_MARKER = "Resource busy";

/**
 * Create a compressed DMG from `contents` at `artifact`, retrying only transient DiskImages
 * "Resource busy" failures seen on CI runners (at most {@link DMG_CREATE_MAX_ATTEMPTS} attempts,
 * waiting {@link DMG_CREATE_RETRY_DELAYS_MS} between them). Any other failure, or a busy failure
 * on the last attempt, throws immediately with the same error `must` would produce.
 *
 * `stage` receives the regular-file output capture and must be owned by the caller.
 */
async function createDmg(
  contents: string,
  volumeName: string,
  artifact: string,
  stage: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    // A busy failure may leave a partial image, which would make the next create fail with "file exists".
    await rm(artifact, {
      force: true,
    });
    const startedAt = performance.now();
    // Some DiskImages helpers stall when their inherited output is a pipe.
    // Regular-file capture also preserves failure diagnostics without waiting on helper pipe EOF.
    const result = await run(
      "hdiutil",
      [
        "create",
        "-srcfolder",
        contents,
        "-format",
        "UDZO",
        "-volname",
        volumeName,
        artifact,
      ],
      {
        captureDirectory: stage,
      },
    );
    if (result.code === 0) {
      return;
    }
    const isBusy = `${result.stderr}\n${result.stdout}`.includes(
      DMG_BUSY_MARKER,
    );
    const delayMs = DMG_CREATE_RETRY_DELAYS_MS[attempt - 1];
    if (
      !isBusy ||
      attempt >= DMG_CREATE_MAX_ATTEMPTS ||
      delayMs === undefined
    ) {
      throw toolFailure("hdiutil", result);
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    const summary = (result.stderr || result.stdout)
      .split("\n")[0]
      ?.slice(0, 200);
    console.log(
      `hdiutil create busy, retrying: attempt ${attempt}/${DMG_CREATE_MAX_ATTEMPTS} took ${elapsedMs} ms, waiting ${delayMs} ms (${summary})`,
    );
    await Bun.sleep(delayMs);
  }
}

/** Assemble a DMG or PKG in staging and preserve the previous artifact on tool failure. */
export async function packageApp(options: {
  channel: Channel;
  app: string;
  outDir: string;
  name?: string;
  installerIdentity?: string;
}): Promise<void> {
  const app = resolve(options.app);
  await directory(app);
  const info = await plistStrings(resolve(app, "Contents/Info.plist"), [
    "CFBundleName",
    "CFBundleShortVersionString",
    "CFBundleVersion",
  ]);
  const name = options.name ?? info.CFBundleName ?? basename(app, ".app");
  let version = info.CFBundleShortVersionString ?? "0";
  const build = info.CFBundleVersion;
  if (build && build !== version) {
    version += `-${build}`;
  }
  const filename = `${name}-${version}.${options.channel === "mac-direct" ? "dmg" : "pkg"}`;
  assert(
    !filename.includes("/") &&
      !filename.includes("\\") &&
      !filename.includes("\0"),
    "Artifact name and version must not contain path separators",
  );
  const output = resolve(options.outDir);
  await mkdir(output, {
    recursive: true,
  });
  const stage = await mkdtemp(resolve(tmpdir(), "bunaway-pkg."));
  try {
    const artifact = resolve(stage, filename);
    if (options.channel === "mac-direct") {
      const contents = resolve(stage, "dmg-root");
      await mkdir(contents);
      await must("ditto", [
        app,
        resolve(contents, basename(app)),
      ]);
      await symlink("/Applications", resolve(contents, "Applications"));
      await createDmg(contents, name, artifact, stage);
    } else {
      const args = [
        "--component",
        app,
        "/Applications",
      ];
      if (options.installerIdentity) {
        args.push("--sign", options.installerIdentity);
      } else {
        console.log(
          "No installer identity: unsigned PKG for local verification only.",
        );
      }
      await must("productbuild", [
        ...args,
        artifact,
      ]);
    }
    await must("mv", [
      artifact,
      resolve(output, filename),
    ]);
    console.log(`Artifact: ${resolve(output, filename)}`);
  } finally {
    await rm(stage, {
      recursive: true,
      force: true,
    });
  }
}
