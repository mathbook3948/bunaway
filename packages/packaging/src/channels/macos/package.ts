import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { must } from "../../tools.ts";
import { type Channel, directory, plist } from "./common.ts";

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
  const info = await plist(resolve(app, "Contents/Info.plist"));
  const name =
    options.name ??
    (typeof info.CFBundleName === "string"
      ? info.CFBundleName
      : basename(app, ".app"));
  let version =
    typeof info.CFBundleShortVersionString === "string"
      ? info.CFBundleShortVersionString
      : "0";
  const build = info.CFBundleVersion;
  if (typeof build === "string" && build && build !== version) {
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
      await must("hdiutil", [
        "create",
        "-srcfolder",
        contents,
        "-format",
        "UDZO",
        "-volname",
        name,
        artifact,
      ]);
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
