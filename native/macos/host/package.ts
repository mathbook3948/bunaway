import assert from "node:assert/strict";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { files, hash, writeJson } from "#cli/files";
import { run } from "#cli/processes";
import pin from "../../../runtime/build-manifests/darwin-aarch64.json";
import { macosApp } from "../../../tests/fixtures/desktop/host/macos-app.ts";
import policy from "../../../tests/fixtures/desktop/host/policy.json";

const root = resolve(import.meta.dir, "../../..");

/** Package the already-built macOS host with real regression fixtures and optional signed app. */
export async function buildHostFixture(makeApp = false): Promise<string> {
  const output = resolve(root, "build/macos-host-package");
  const assets = resolve(output, "assets");
  const fixture = resolve(root, "tests/fixtures/desktop/host");
  await rm(output, {
    recursive: true,
    force: true,
  });
  for (const directory of [
    "assets/web",
    "assets/tmp",
    "licenses",
    "runtime",
  ]) {
    await mkdir(resolve(output, directory), {
      recursive: true,
    });
  }
  await cp(
    resolve(root, "build/macos-host/bunaway-host"),
    resolve(output, "bunaway-host"),
  );
  await cp(
    resolve(root, "build/cache/bun/bun-darwin-aarch64/bun"),
    resolve(output, "runtime/bun"),
  );
  for (const [source, name] of [
    [
      "bun/LICENSE.bun",
      "LICENSE.bun",
    ],
    [
      "nlohmann-json/LICENSE.nlohmann-json",
      "LICENSE.nlohmann-json",
    ],
  ] as const) {
    await cp(
      resolve(root, "build/cache", source),
      resolve(output, "licenses", name),
    );
  }
  for (const name of [
    "bunfig.toml",
    "tsconfig.json",
  ]) {
    await cp(resolve(fixture, name), resolve(assets, name));
  }
  await cp(
    resolve(import.meta.dir, "test/app.json"),
    resolve(assets, "app.json"),
  );
  const main = policy.views.find((view) => view.id === "main");
  assert(main);
  await writeJson(resolve(assets, "policy.json"), {
    ...policy,
    views: [
      {
        ...main,
        commands: Object.keys(macosApp.commands).filter(
          (name) => name !== "test.notAllowed",
        ),
        host: {
          permissions: [],
        },
      },
    ],
    backend: {
      permissions: [],
    },
  });
  for (const name of [
    "process",
    "message",
    "policy",
    "host-call",
  ]) {
    await cp(
      resolve(root, `native/host-api/generated/${name}.schema.json`),
      resolve(assets, `${name}.schema.json`),
    );
  }
  await cp(resolve(fixture, "web"), resolve(assets, "web"), {
    recursive: true,
  });
  await cp(
    resolve(import.meta.dir, "test/web/security.html"),
    resolve(assets, "web/security.html"),
  );
  for (const [source, destination, target] of [
    ...[
      "app.js",
      "page2.js",
      "memo.js",
    ].map(
      (name) =>
        [
          resolve(fixture, "web", name),
          `web/${name}`,
          "browser",
        ] as const,
    ),
    [
      resolve(import.meta.dir, "test/web/security.js"),
      "web/security.js",
      "browser",
    ],
    [
      resolve(fixture, "macos-backend.ts"),
      "backend.js",
      "bun",
    ],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [
        source,
      ],
      target,
    });
    assert(
      result.success && result.outputs[0],
      `Fixture bundle failed: ${source}\n${result.logs.join("\n")}`,
    );
    await writeFile(
      resolve(assets, destination),
      new Uint8Array(await result.outputs[0].arrayBuffer()),
    );
  }
  const hashes: Record<string, string> = {};
  for (const directory of [
    "assets",
    "licenses",
  ]) {
    for (const file of await files(resolve(output, directory))) {
      hashes[relative(output, file)] = await hash(file);
    }
  }
  await writeJson(resolve(output, "manifest.json"), {
    ...pin,
    assets: hashes,
  });
  if (makeApp) {
    const app = resolve(root, "build/Bunaway.app");
    await rm(app, {
      recursive: true,
      force: true,
    });
    await mkdir(resolve(app, "Contents/MacOS"), {
      recursive: true,
    });
    await mkdir(resolve(app, "Contents/Resources"), {
      recursive: true,
    });
    await cp(
      resolve(output, "bunaway-host"),
      resolve(app, "Contents/MacOS/bunaway-host"),
    );
    for (const name of [
      "runtime",
      "assets",
      "licenses",
      "manifest.json",
    ]) {
      await cp(
        resolve(output, name),
        resolve(app, "Contents/Resources", name),
        {
          recursive: true,
        },
      );
    }
    const plist = resolve(app, "Contents/Info.plist");
    await writeJson(plist, {
      CFBundleExecutable: "bunaway-host",
      CFBundleIdentifier: "ai.bunaway.app",
      CFBundleName: "bunaway",
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: "0.0.0",
      CFBundleVersion: "0",
      LSMinimumSystemVersion: "14.0",
      NSPrincipalClass: "NSApplication",
      // Native regressions load loopback development pages, as the CLI dev bundle does.
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
    });
    await run(
      [
        "/usr/bin/plutil",
        "-convert",
        "binary1",
        plist,
      ],
      root,
    );
    await run(
      [
        "/usr/bin/codesign",
        "--force",
        "--deep",
        "--sign",
        "-",
        app,
      ],
      root,
    );
  }
  return output;
}
