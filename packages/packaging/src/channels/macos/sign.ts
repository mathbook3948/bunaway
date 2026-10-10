import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { must } from "../../tools.ts";
import {
  type Channel,
  directory,
  exists,
  plist,
  plistStrings,
  record,
  setPlistString,
  string,
  writePlist,
} from "./common.ts";

/** Publish a signed copy on the destination filesystem; retain the previous app if rollback fails. */
async function publishApp(staged: string, output: string): Promise<void> {
  await mkdir(dirname(output), {
    recursive: true,
  });
  const publish = await mkdtemp(`${output}.publish.`);
  const previous = resolve(publish, "previous.app");
  const next = resolve(publish, "new.app");
  try {
    await must("mv", [
      staged,
      next,
    ]);
    if (await exists(output)) {
      assert(
        (await lstat(output)).isDirectory(),
        "Output must be a real app directory",
      );
      await must("mv", [
        output,
        previous,
      ]);
    }
    try {
      await must("mv", [
        next,
        output,
      ]);
    } catch (cause) {
      if (await exists(previous)) {
        try {
          await must("mv", [
            previous,
            output,
          ]);
        } catch (rollback) {
          throw new AggregateError(
            [
              cause,
              rollback,
            ],
            `Rollback failed; backup retained at ${previous}`,
          );
        }
      }
      throw cause;
    }
    await rm(previous, {
      recursive: true,
      force: true,
    });
  } finally {
    if (await exists(previous)) {
      console.error(`Previous app preserved at ${previous}`);
    } else {
      await rm(publish, {
        recursive: true,
        force: true,
      });
    }
  }
}

export interface SignOptions {
  channel: Channel;
  app: string;
  out: string;
  identity: string;
  teamId?: string;
  provisionprofile?: string;
  bundleId?: string;
  version?: string;
  buildNumber?: string;
  displayName?: string;
  icon?: string;
  minOs?: string;
}

/** Sign the compiled host or nested Bun, then seal and verify the bundle before publication. */
export async function signApp(options: SignOptions): Promise<void> {
  const { channel, identity, teamId, provisionprofile } = options;
  const app = resolve(options.app);
  const output = resolve(options.out);
  await directory(app);
  if (channel === "mac-store") {
    string(teamId, "mac-store --team-id");
  }
  const stage = await mkdtemp(resolve(tmpdir(), "bunaway-sign."));
  try {
    const staged = resolve(stage, basename(app));
    await must("ditto", [
      app,
      staged,
    ]);
    const resources = resolve(staged, "Contents/Resources");
    const plistPath = resolve(staged, "Contents/Info.plist");
    const info = await plistStrings(plistPath, [
      "CFBundleIdentifier",
    ]);
    for (const [key, value] of [
      [
        "CFBundleIdentifier",
        options.bundleId,
      ],
      [
        "CFBundleShortVersionString",
        options.version,
      ],
      [
        "CFBundleVersion",
        options.buildNumber,
      ],
      [
        "CFBundleName",
        options.displayName,
      ],
      [
        "CFBundleDisplayName",
        options.displayName,
      ],
      [
        "LSMinimumSystemVersion",
        options.minOs,
      ],
    ]) {
      if (key && value !== undefined) {
        await setPlistString(plistPath, key, value);
      }
    }
    if (options.icon) {
      await must("ditto", [
        resolve(options.icon),
        resolve(resources, "AppIcon.icns"),
      ]);
      await setPlistString(plistPath, "CFBundleIconFile", "AppIcon");
    }
    const bundleId = string(
      options.bundleId ?? info.CFBundleIdentifier,
      "CFBundleIdentifier",
    );
    const manifestPath = resolve(resources, "manifest.json");
    const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")));
    const compiled =
      manifest.host !== undefined &&
      record(manifest.host).kind === "bun-compiled";
    let bun = resolve(resources, "runtime/bun");
    if (!compiled && channel === "mac-store") {
      await mkdir(resolve(staged, "Contents/Helpers"), {
        recursive: true,
      });
      const relocated = resolve(staged, "Contents/Helpers/bun");
      await must("mv", [
        bun,
        relocated,
      ]);
      await rmdir(dirname(bun)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
          throw error;
        }
      });
      bun = relocated;
    }
    if (channel === "mac-store" && provisionprofile) {
      await must("ditto", [
        resolve(provisionprofile),
        resolve(staged, "Contents/embedded.provisionprofile"),
      ]);
    }
    for (const role of [
      "app",
      "child",
    ]) {
      const entitlements = await plist(
        resolve(import.meta.dir, "entitlements", `${channel}-${role}.plist`),
      );
      if (channel === "mac-store" && role === "app") {
        entitlements["com.apple.security.application-groups"] = [
          `${teamId}.${bundleId}`,
        ];
        if (provisionprofile) {
          entitlements["com.apple.application-identifier"] =
            `${teamId}.${bundleId}`;
          entitlements["com.apple.developer.team-identifier"] = teamId;
        } else {
          // Provisioned entitlements without a profile cause AMFI to reject local test apps.
          delete entitlements["com.apple.application-identifier"];
          delete entitlements["com.apple.developer.team-identifier"];
        }
      }
      if (compiled && role === "app") {
        // Bun JIT and FFI run in the app executable, without a nested runtime.
        entitlements["com.apple.security.cs.allow-jit"] = true;
        entitlements["com.apple.security.cs.allow-unsigned-executable-memory"] =
          true;
      }
      await writePlist(resolve(stage, `${role}.ent.plist`), entitlements);
    }
    const sign = (path: string, role: string) =>
      must("codesign", [
        "--force",
        "--sign",
        identity,
        "--options",
        "runtime",
        "--entitlements",
        resolve(stage, `${role}.ent.plist`),
        path,
      ]);
    if (!compiled) {
      await sign(bun, "child");
      // Signing changes executable bytes, so record the packaged digest only after signing Bun.
      const signedManifest = record(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      record(signedManifest.bun).packagedSha256 = createHash("sha256")
        .update(await readFile(bun))
        .digest("hex");
      await writeFile(
        manifestPath,
        `${JSON.stringify(signedManifest, null, 2)}\n`,
      );
    }
    let host = resolve(staged, "Contents/MacOS/bunaway-host");
    if (!(await exists(host))) {
      const executables = resolve(staged, "Contents/MacOS");
      let found: string | undefined;
      for await (const name of new Bun.Glob("**/*").scan(executables)) {
        const path = resolve(executables, name);
        const entry = await lstat(path);
        if (entry.isFile() && entry.mode & 0o111) {
          found = path;
          break;
        }
      }
      host = string(found, "host executable");
    }
    await sign(host, "app");
    await sign(staged, "app");
    await must("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      staged,
    ]);
    await publishApp(staged, output);
    console.log(`Signed app: ${output}`);
  } finally {
    await rm(stage, {
      recursive: true,
      force: true,
    });
  }
}
