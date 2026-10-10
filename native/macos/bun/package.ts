import assert from "node:assert/strict";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { run } from "#cli/processes";
import pin from "../../../runtime/build-manifests/darwin-aarch64.json";
import { macosApp } from "../../../tests/fixtures/desktop/host/macos-app.ts";

const root = resolve(import.meta.dir, "../../..");

/** Build the real WKWebView regression fixture using the pinned Bun, without a C compiler. */
export async function buildMacosFixture(): Promise<string> {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(await hash(process.execPath), pin.bun.executableSha256);
  const output = resolve(root, "build/macos-bun-package");
  await rm(output, {
    recursive: true,
    force: true,
  });
  const assets = resolve(output, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const fixture = resolve(root, "tests/fixtures/desktop/host");
  await cp(resolve(fixture, "web"), resolve(assets, "web"), {
    recursive: true,
  });
  await cp(
    resolve(root, "tests/fixtures/desktop/host/macos-web"),
    resolve(assets, "web"),
    {
      recursive: true,
    },
  );
  for (const name of [
    "app.js",
    "memo.js",
    "page2.js",
  ]) {
    await run(
      [
        process.execPath,
        "build",
        resolve(fixture, "web", name),
        "--target=browser",
        `--outfile=${resolve(assets, "web", name)}`,
      ],
      root,
    );
  }
  await run(
    [
      process.execPath,
      "build",
      resolve(root, "tests/fixtures/desktop/host/macos-web/security.js"),
      "--target=browser",
      `--outfile=${resolve(assets, "web/security.js")}`,
    ],
    root,
  );
  const app = await Bun.file(
    resolve(root, "tests/fixtures/desktop/host/macos-app.json"),
  ).json();
  const policy = await Bun.file(resolve(fixture, "policy.json")).json();
  policy.views = policy.views.filter(
    (view: { id: string }) => view.id === "main",
  );
  policy.views[0].commands = Object.keys(macosApp.commands).filter(
    (name) => name !== "test.notAllowed",
  );
  policy.views[0].host = {
    permissions: [],
  };
  policy.backend = {
    permissions: [],
  };
  await writeJson(resolve(assets, "app.json"), app);
  await writeJson(resolve(assets, "policy.json"), policy);
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app,
    policy,
    plugins: [],
    developmentSdk: {},
  });
  await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(fixture, "macos-entry.ts"),
  );
  await compileMacosApp(
    assets,
    process.execPath,
    resolve(output, "bunaway-host"),
  );
  const hashes: Record<string, string> = {};
  for (const file of await files(assets)) {
    hashes[relative(output, file)] = await hash(file);
  }
  await writeJson(resolve(output, "manifest.json"), {
    bun: pin.bun,
    assets: hashes,
    host: {
      kind: "bun-compiled",
      target: "macos-arm64",
    },
  });
  return output;
}

/** Copy the compiled fixture into an ad-hoc signed .app for launch and signing checks. */
async function buildSignedFixture(output: string): Promise<string> {
  const app = resolve(root, "build/Bunaway.app");
  await rm(app, {
    recursive: true,
    force: true,
  });
  await mkdir(resolve(app, "Contents/MacOS"), {
    recursive: true,
  });
  const resources = resolve(app, "Contents/Resources");
  await mkdir(resources, {
    recursive: true,
  });
  await cp(
    resolve(output, "bunaway-host"),
    resolve(app, "Contents/MacOS/bunaway-host"),
  );
  await cp(resolve(output, "assets"), resolve(resources, "assets"), {
    recursive: true,
  });
  await cp(
    resolve(output, "manifest.json"),
    resolve(resources, "manifest.json"),
  );
  await writeFile(
    resolve(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bunaway-host</string>
<key>CFBundleIdentifier</key><string>tests.bunaway.host</string>
<key>CFBundleName</key><string>Bunaway fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`,
  );
  await run(
    [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve(root, "native/macos/bun/entitlements.plist"),
      app,
    ],
    root,
  );
  return app;
}

if (import.meta.main) {
  const output = await buildMacosFixture();
  console.log(output);
  if (process.argv.includes("--app")) {
    console.log(await buildSignedFixture(output));
  }
}
