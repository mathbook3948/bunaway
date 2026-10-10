import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { must } from "../../tools.ts";
import { directory, record } from "./common.ts";

/** Submit using a keychain profile, then staple a staged artifact; ZIPs require re-archiving the stapled app. */
export async function notarize(options: {
  artifact: string;
  profile: string;
  app?: string;
}): Promise<void> {
  const artifact = resolve(options.artifact);
  assert(
    [
      ".zip",
      ".dmg",
    ].includes(extname(artifact)),
    "Artifact must be a .dmg or .zip",
  );
  assert((await lstat(artifact)).isFile(), `Artifact not found: ${artifact}`);
  if (options.app) {
    await directory(resolve(options.app));
  }
  const stage = await mkdtemp(resolve(dirname(artifact), ".bunaway-notary."));
  const staple = async (path: string) => {
    await must("xcrun", [
      "stapler",
      "staple",
      path,
    ]);
    await must("xcrun", [
      "stapler",
      "validate",
      path,
    ]);
  };
  try {
    const result = await must("xcrun", [
      "notarytool",
      "submit",
      artifact,
      "--keychain-profile",
      options.profile,
      "--wait",
      "--output-format",
      "json",
    ]);
    assert(
      record(JSON.parse(result.stdout)).status === "Accepted",
      "Notarization was not accepted",
    );
    let replacement: string;
    if (extname(artifact) === ".zip") {
      const unpacked = resolve(stage, "unpacked");
      await must("ditto", [
        "-x",
        "-k",
        artifact,
        unpacked,
      ]);
      const apps = (
        await readdir(unpacked, {
          withFileTypes: true,
        })
      ).filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
      assert(
        apps.length === 1 && apps[0],
        "ZIP must contain exactly one top-level .app",
      );
      await staple(resolve(unpacked, apps[0].name));
      replacement = resolve(stage, "notarized.zip");
      await must("ditto", [
        "-c",
        "-k",
        unpacked,
        replacement,
      ]);
    } else {
      replacement = resolve(stage, "notarized.dmg");
      await must("ditto", [
        artifact,
        replacement,
      ]);
      await staple(replacement);
    }
    await must("mv", [
      replacement,
      artifact,
    ]);
    if (options.app) {
      await staple(resolve(options.app));
    }
  } finally {
    await rm(stage, {
      recursive: true,
      force: true,
    });
  }
}
