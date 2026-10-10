// Run the public Android pipeline with fixture tools in an isolated process.
// Native Gradle/APK behavior stays covered by the emulator and artifact checks.

import { mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireBuildOutputLock } from "@bunaway/packaging";
import * as assets from "#cli/assets";
import type { Project } from "#cli/config";
import { hash, writeJson } from "#cli/files";

const root = process.argv[2];
const mode = process.argv[3];
assert(root && mode);
const framework = resolve(root, "framework");
const appId = "dev.bunaway.fixture.debug";
const project: Project = {
  root,
  frameworkRoot: framework,
  appEntry: resolve(root, "app.ts"),
  frontend: resolve(root, "web"),
  app: {
    appId: "dev.bunaway.fixture",
    title: "Test",
    view: "main",
    home: "https://app.bunaway.local/index.html",
    window: {
      width: 800,
      height: 600,
    },
  },
  policy: {
    version: 1,
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [],
        events: [],
        host: {
          permissions: [],
        },
      },
    ],
    backend: {
      permissions: [],
    },
  },
};
await mkdir(resolve(framework, "native/android/host/src"), {
  recursive: true,
});
for (const name of [
  "native/android/host/build.gradle",
  "native/android/app.gradle",
  "native/android/host-settings.gradle",
  "native/android/bridge.js",
  "FRAMEWORK-LICENSE.txt",
  "THIRD-PARTY-NOTICES.txt",
  "licenses/LICENSE.apache-2.0.txt",
  "native/host-api/generated/process.schema.json",
  "native/host-api/generated/message.schema.json",
  "native/host-api/generated/policy.schema.json",
  "build/cache/android-bun/x64/LICENSE.bun",
]) {
  await Bun.write(resolve(framework, name), "fixture input");
}
for (const target of [
  "x64",
  "arm64",
]) {
  const executable = resolve(
    framework,
    `build/cache/android-bun/${target}/bun-fixture/bun`,
  );
  await Bun.write(executable, "fixture runtime");
  await Bun.write(
    resolve(framework, `runtime/build-manifests/android-${target}.json`),
    JSON.stringify({
      bun: {
        version: Bun.version,
        target: "fixture",
        executableSha256: await hash(executable),
      },
    }),
  );
}
await Bun.write(resolve(root, "android/bunaway-project.json"), '{"format":1}');
process.env.ANDROID_HOME = resolve(root, "sdk");
process.env.JAVA_HOME = resolve(root, "jdk");
mock.module(import.meta.resolve("#cli/config"), () => ({
  readProjectMetadata: async () => project,
  validateProject: async () => project,
}));
mock.module(import.meta.resolve("#cli/frontend-build"), () => ({
  buildFrontend: async () => {},
}));
mock.module(import.meta.resolve("#cli/processes"), () => ({
  runWorker: async (module: string, method: string) => {
    assert.equal(module, "assets.ts");
    assert.equal(
      typeof Reflect.get(assets, method),
      "function",
      "Android Worker export must exist",
    );
    return "";
  },
}));
mock.module(import.meta.resolve("#cli/managed-command"), () => ({
  runManagedCommand: async (args: string[]) => {
    if (!args.includes(":app:assembleDebug")) {
      assert.deepEqual(args, [
        process.execPath,
        "--no-env-file",
        resolve(framework, "packages/cli/src/native-build.ts"),
        "--target",
        "android",
      ]);
      return;
    }
    const output = args
      .find((argument) => argument.startsWith("-PbunawayBuildDirectory="))
      ?.split("=")
      .slice(1)
      .join("=");
    assert(output);
    await Bun.write(
      resolve(output, "outputs/apk/debug/app-debug.apk"),
      "fixture APK",
    );
    await writeJson(resolve(output, "outputs/apk/debug/output-metadata.json"), {
      applicationId: appId,
    });
  },
}));
const spawn = Bun.spawn;
const children: Bun.Subprocess[] = [];
spyOn(Bun, "spawn").mockImplementation((...args) => {
  if (
    Array.isArray(args[0]) &&
    args[0][0] === resolve(root, "sdk/platform-tools/adb.exe")
  ) {
    const child = Reflect.apply(spawn, Bun, [
      [
        process.execPath,
        resolve(import.meta.dir, "android-adb.fixture.ts"),
        root,
        mode,
        ...args[0].slice(1),
      ],
      args[1],
    ]);
    children.push(child);
    return child;
  }
  return Reflect.apply(spawn, Bun, args);
});
const cancellation = (async () => {
  if (mode !== "cancel") {
    return;
  }
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(resolve(root, "adb-ready")).exists())) {
    assert(Date.now() < deadline, "ADB fixture did not start");
    await Bun.sleep(10);
  }
  process.emit("SIGINT", "SIGINT");
})();
const { runAndroidProject } = await import("#cli/android");
if (mode === "success") {
  await runAndroidProject(root, "emulator-5554");
} else {
  await assert.rejects(
    runAndroidProject(root, "emulator-5554"),
    mode === "cancel" ? /cancelled/ : /fixture failure/,
  );
}
await cancellation;
assert(children.length > 0);
assert(
  children.every(
    (child) => child.exitCode !== null || child.signalCode !== null,
  ),
  "ADB client survived output lock release",
);
for (const child of children) {
  assert.throws(() => process.kill(child.pid, 0), "ADB client is still alive");
}
const release = await acquireBuildOutputLock(root, "android");
await release();
const manifest = await Bun.file(
  resolve(root, "dist/android/manifest.json"),
).json();
assert.equal(manifest.appId, appId);
assert.equal(
  manifest.sha256,
  await hash(resolve(root, "dist/android/app-debug.apk")),
);
console.log("PASS: final APK identity and owned ADB lifecycle");
