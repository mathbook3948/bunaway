import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { notarize } from "../src/channels/macos/notarize.ts";
import { packageApp } from "../src/channels/macos/package.ts";
import { signApp } from "../src/channels/macos/sign.ts";

// This contributor tool preserves the standalone macOS workflow; package channel registration is separate.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    channel: {
      type: "string",
    },
    app: {
      type: "string",
    },
    out: {
      type: "string",
    },
    identity: {
      type: "string",
    },
    "team-id": {
      type: "string",
    },
    provisionprofile: {
      type: "string",
    },
    "bundle-id": {
      type: "string",
    },
    version: {
      type: "string",
    },
    "build-number": {
      type: "string",
    },
    "display-name": {
      type: "string",
    },
    icon: {
      type: "string",
    },
    "min-os": {
      type: "string",
    },
    "out-dir": {
      type: "string",
    },
    name: {
      type: "string",
    },
    "installer-identity": {
      type: "string",
    },
    artifact: {
      type: "string",
    },
    profile: {
      type: "string",
    },
    help: {
      type: "boolean",
      short: "h",
    },
  },
});
function required(value: string | undefined, name: string): string {
  assert(value, `Missing --${name}`);
  return value;
}
try {
  if (values.help) {
    console.log(
      "macos.ts sign --channel mac-direct|mac-store --app input.app --out signed.app --identity name [--team-id id] [--provisionprofile path]\nmacos.ts package --channel mac-direct|mac-store --app signed.app --out-dir directory [--name name] [--installer-identity name]\nmacos.ts notarize --artifact file.dmg|file.zip --profile keychain-name [--app signed.app]",
    );
  } else {
    assert(positionals.length === 1, "Expected sign, package or notarize");
    const command = positionals[0];
    if (command === "notarize") {
      const artifact = required(values.artifact, "artifact");
      if (!values.profile) {
        assert(
          [
            ".dmg",
            ".zip",
          ].includes(extname(artifact)),
          "Artifact must be a .dmg or .zip",
        );
        assert(
          (await stat(artifact)).isFile(),
          `Artifact not found: ${artifact}`,
        );
        if (values.app) {
          assert(
            (await stat(values.app)).isDirectory(),
            `App not found: ${values.app}`,
          );
        }

        console.error(
          "Notarization unverified: provide --profile with an existing xcrun notarytool keychain profile.",
        );
        process.exitCode = 2;
      } else {
        await notarize({
          artifact,
          profile: values.profile,
          ...(values.app
            ? {
                app: values.app,
              }
            : {}),
        });
      }
    } else {
      assert(
        values.channel === "mac-direct" || values.channel === "mac-store",
        "--channel must be mac-direct or mac-store",
      );
      const app = required(values.app, "app");
      if (command === "sign") {
        await signApp({
          channel: values.channel,
          app,
          out: required(values.out, "out"),
          identity: required(values.identity, "identity"),
          ...(values["team-id"]
            ? {
                teamId: values["team-id"],
              }
            : {}),
          ...(values.provisionprofile
            ? {
                provisionprofile: values.provisionprofile,
              }
            : {}),
          ...(values["bundle-id"]
            ? {
                bundleId: values["bundle-id"],
              }
            : {}),
          ...(values.version
            ? {
                version: values.version,
              }
            : {}),
          ...(values["build-number"]
            ? {
                buildNumber: values["build-number"],
              }
            : {}),
          ...(values["display-name"]
            ? {
                displayName: values["display-name"],
              }
            : {}),
          ...(values.icon
            ? {
                icon: values.icon,
              }
            : {}),
          ...(values["min-os"]
            ? {
                minOs: values["min-os"],
              }
            : {}),
        });
      } else {
        assert(command === "package", "Expected sign, package or notarize");
        await packageApp({
          channel: values.channel,
          app,
          outDir: required(values["out-dir"], "out-dir"),
          ...(values.name
            ? {
                name: values.name,
              }
            : {}),
          ...(values["installer-identity"]
            ? {
                installerIdentity: values["installer-identity"],
              }
            : {}),
        });
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
