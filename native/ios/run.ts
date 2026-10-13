import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkRoot } from "#cli/files";
import { isIosSimulatorId } from "#cli/ios";
import { run } from "#cli/processes";
import { iosFixture } from "../../tests/cli/ios-fixture.ts";
import { BURST_EVENT_COUNT } from "../../tests/fixtures/ios/limits.ts";

const device = process.argv[2];
assert(
  device && isIosSimulatorId(device),
  "Pass the UUID of a booted arm64 iOS Simulator.",
);
const root = resolve(frameworkRoot, "build/ios-host/app");
await rm(root, {
  recursive: true,
  force: true,
});
await mkdir(resolve(frameworkRoot, "build/ios-host"), {
  recursive: true,
});
await iosFixture(root);
const cache = resolve(root, "node_modules/@bunaway/cli/build/cache/ios-bun");
await mkdir(cache, {
  recursive: true,
});
const cachedRuntime = resolve(
  frameworkRoot,
  "build/cache/ios-bun/bun-ios-aarch64.zip",
);
if (await Bun.file(cachedRuntime).exists()) {
  await cp(cachedRuntime, resolve(cache, "bun-ios-aarch64.zip"));
}
const cli = resolve(root, "node_modules/@bunaway/cli/packages/cli/src/main.ts");
await run(
  [
    process.execPath,
    cli,
    "ios",
    "sync",
    root,
  ],
  root,
);
const host: unknown = JSON.parse(
  await readFile(
    resolve(root, "ios/.bunaway/assets/bunaway-assets/host.json"),
    "utf8",
  ),
);
assert(host && typeof host === "object" && "home" in host);
assert.equal(host.home, "https://app.bunaway.local/index.html?probe=1");
// The fixture owns its Swift subclass and deliberately overrides the Xcode bundle identifier.
await cp(
  resolve(frameworkRoot, "tests/fixtures/ios/AppDelegate.swift"),
  resolve(root, "ios/AppDelegate.swift"),
);
const nativeProject = resolve(root, "ios/Bunaway.xcodeproj/project.pbxproj");
const contents = await readFile(nativeProject, "utf8");
assert(contents.includes("PRODUCT_NAME = Bunaway;"));
const appId = "dev.bunaway.ios.fixture.native";
await writeFile(
  nativeProject,
  contents.replace(
    "PRODUCT_NAME = Bunaway;",
    `PRODUCT_NAME = Bunaway;\nPRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
  ),
);
const previous = Bun.spawnSync([
  "xcrun",
  "simctl",
  "get_app_container",
  device,
  appId,
  "data",
]);
if (previous.exitCode === 0) {
  // This dedicated fixture owns its test app and persistent report, including earlier failed runs.
  await run(
    [
      "xcrun",
      "simctl",
      "uninstall",
      device,
      appId,
    ],
    root,
  );
}
try {
  // The generic destination must build arm64 only, even when Xcode also advertises x86_64.
  await run(
    [
      process.execPath,
      cli,
      "ios",
      "build",
      root,
    ],
    root,
  );
  // Check the final Xcode artifact so a missing resource copy cannot pass on sync alone.
  for (const [name, source] of Object.entries({
    "LICENSE.md": "ios/.bunaway/runtime/LICENSE.md",
    "LICENSE-libffi": "ios/.bunaway/runtime/LICENSE-libffi",
    "FRAMEWORK-LICENSE.txt": "node_modules/@bunaway/cli/FRAMEWORK-LICENSE.txt",
    "THIRD-PARTY-NOTICES.txt":
      "node_modules/@bunaway/cli/THIRD-PARTY-NOTICES.txt",
  })) {
    assert.deepEqual(
      await readFile(
        resolve(root, "dist/ios/Bunaway.app/bunaway-assets/licenses", name),
      ),
      await readFile(resolve(root, source)),
      `Packaged iOS notice must preserve ${name} in full.`,
    );
  }
  await run(
    [
      process.execPath,
      resolve(frameworkRoot, "tests/cli/ios-build-cancel.fixture.ts"),
      root,
    ],
    frameworkRoot,
  );
  const transports = [];
  for (const fallback of [
    false,
    true,
  ]) {
    if (fallback) {
      await run(
        [
          "xcrun",
          "simctl",
          "launch",
          "--terminate-running-process",
          device,
          appId,
          "--fallback",
        ],
        root,
      );
    } else {
      await run(
        [
          process.execPath,
          cli,
          "ios",
          "run",
          root,
          "--device",
          device,
        ],
        root,
      );
    }
    const container: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync([
      "xcrun",
      "simctl",
      "get_app_container",
      device,
      appId,
      "data",
    ]);
    assert.equal(container.exitCode, 0, container.stderr.toString());
    const report = resolve(
      container.stdout.toString().trim(),
      "Documents/ios-results.jsonl",
    );
    const deadline = Date.now() + 50000;
    let lines: string[] = [];
    while (Date.now() < deadline) {
      const contents = await readFile(report, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
          return "";
        },
      );
      lines = contents.trim().split("\n").filter(Boolean);
      if (lines.length >= 3) {
        break;
      }
      await Bun.sleep(250);
    }
    assert.equal(
      lines.length,
      3,
      "Expected successful SDK checks in three backend Worker generations.",
    );
    for (const line of lines) {
      assert.deepEqual(JSON.parse(line), {
        ok: true,
        echoBytes: 229376,
        count: 1,
        hashNavigation: true,
        eventBurst: BURST_EVENT_COUNT,
      });
    }
    const regressions = JSON.parse(
      await readFile(
        resolve(
          container.stdout.toString().trim(),
          "Documents/ios-host-regressions.json",
        ),
        "utf8",
      ),
    );
    assert.equal(regressions.directConnected, !fallback);
    assert.equal(regressions.fallbackConnected, fallback);
    assert.equal(regressions.nativeDataMessages > 0, fallback);
    const {
      directConnected,
      fallbackConnected,
      nativeDataMessages,
      ...lifecycle
    } = regressions;
    assert.deepEqual(lifecycle, {
      documentFailure: true,
      staleMessages: true,
      rootNavigation: true,
      cancelledNavigation: true,
      staleNavigation: true,
      navigationRecovery: true,
      cacheRestored: true,
      inputQueueClosed: true,
      invalidMessagesClosed: true,
      replacementNavigationPreserved: true,
    });
    await run(
      [
        "xcrun",
        "simctl",
        "terminate",
        device,
        appId,
      ],
      root,
    );
    transports.push({
      transport: fallback ? "native-fallback" : "websocket",
      regressions,
      backendGenerations: lines.length,
      results: lines.map((line) => JSON.parse(line)),
    });
    await rm(report);
  }
  // Alter only this unsigned test artifact's configuration to exercise a missing home.
  const app = resolve(root, "dist/ios/Bunaway.app");
  const hostFile = resolve(app, "bunaway-assets/host.json");
  const host = JSON.parse(await readFile(hostFile, "utf8"));
  host.home = "https://app.bunaway.local/missing-home.html";
  await writeFile(hostFile, JSON.stringify(host));
  await run(
    [
      "xcrun",
      "simctl",
      "install",
      device,
      app,
    ],
    root,
  );
  await run(
    [
      "xcrun",
      "simctl",
      "launch",
      "--terminate-running-process",
      device,
      appId,
      "--home-failure",
    ],
    root,
  );
  // Reinstall can move the existing data container even though its contents are preserved.
  const retryContainer = Bun.spawnSync([
    "xcrun",
    "simctl",
    "get_app_container",
    device,
    appId,
    "data",
  ]);
  assert.equal(retryContainer.exitCode, 0, retryContainer.stderr.toString());
  const homeReport = resolve(
    retryContainer.stdout.toString().trim(),
    "Documents/ios-home-failure.json",
  );
  const retryDeadline = Date.now() + 10000;
  while (!(await Bun.file(homeReport).exists()) && Date.now() < retryDeadline) {
    await Bun.sleep(250);
  }
  const homeFailure = JSON.parse(await readFile(homeReport, "utf8"));
  assert.deepEqual(homeFailure, {
    failures: 4,
    retry: true,
  });
  await writeFile(
    resolve(frameworkRoot, "build/ios-host/results.json"),
    `${JSON.stringify(
      {
        device,
        appId,
        homeFailure,
        transports,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  // A crashed or never-started fixture has no process left to terminate.
  Bun.spawnSync([
    "xcrun",
    "simctl",
    "terminate",
    device,
    appId,
  ]);
}
console.log(
  "iOS Simulator passed: direct WebSocket and native fallback, SDK, navigation recovery, bounded traffic and two Worker restarts per transport.",
);
