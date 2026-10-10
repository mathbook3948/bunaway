import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentTarget, prepareNative } from "#cli/build";
import { run } from "#cli/processes";

const root = resolve(import.meta.dir, "../..");
const { values } = parseArgs({
  options: {
    target: {
      type: "string",
    },
    "skip-tests": {
      type: "boolean",
      default: false,
    },
    app: {
      type: "boolean",
      default: false,
    },
  },
});
const target = currentTarget();
assert(
  values.target === undefined || values.target === target,
  `Native tests require ${values.target}; current target is ${target}`,
);
const inputs = await prepareNative(target);
const test = (
  name: string,
  args: string[] = [],
  env: Record<string, string> = {},
) =>
  run(
    [
      inputs.bun,
      "--no-env-file",
      resolve(import.meta.dir, name),
      ...args,
    ],
    root,
    env,
  );
if (target === "windows-x64") {
  const { buildHostFixture } = await import("#native/windows/bun/package");
  const output = await buildHostFixture();
  if (!values["skip-tests"]) {
    for (const scenario of [
      [],
      [
        "--modal",
      ],
      [
        "--early-close",
      ],
      [
        "--creation-failure",
      ],
    ]) {
      await test("windows-bun.ts", scenario);
    }
    await test("windows-bun-window-api.ts");
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        ...[
          "tests/lifecycle/desktop.test.ts",
          "tests/lifecycle/windows-bun-instance.test.ts",
          "tests/cli/windows-assets.test.ts",
          "tests/cli/windows-compile.test.ts",
        ].map((name) => resolve(root, name)),
      ],
      root,
    );
    for (const scenario of [
      "hide",
      "veto",
      "dev-veto",
      "dev-hide",
      "dev-pending",
    ]) {
      await test("windows-desktop.ts", [
        scenario,
      ]);
    }
    for (const name of [
      "windows-bun-storage.ts",
      "windows-storage-metadata.ts",
      "windows-bun-cli.ts",
      "windows-app-reload.ts",
    ]) {
      await test(name);
    }
    await test("windows-host.ts", [
      "--package",
      output,
    ]);
  }
} else {
  const { buildHostFixture } = await import("#native/macos/host/package");
  const output = await buildHostFixture(values.app);
  if (!values["skip-tests"]) {
    const nativeTests = resolve(root, "build/macos-host/host-native-tests");
    await run(
      [
        "clang++",
        "-std=c++20",
        "-O2",
        "-Wall",
        "-Wextra",
        "-fobjc-arc",
        `-I${resolve(root, "build/cache/nlohmann-json")}`,
        resolve(import.meta.dir, "macos-host-native.mm"),
        "-framework",
        "Cocoa",
        "-framework",
        "WebKit",
        "-o",
        nativeTests,
      ],
      root,
    );
    await test("macos-host.ts", [
      "--package",
      output,
    ]);
    if (values.app) {
      const app = resolve(root, "build/Bunaway.app");
      await test(
        "macos-host.ts",
        [
          "--package",
          resolve(app, "Contents/Resources"),
        ],
        {
          BUNAWAY_PACKAGE_IN_PLACE: "1",
          BUNAWAY_HOST_EXEC: resolve(app, "Contents/MacOS/bunaway-host"),
          BUNAWAY_TEST_WORKSPACE: resolve(root, "build/macos-host-in-place"),
          BUNAWAY_NATIVE_TEST_EXEC: nativeTests,
          BUNAWAY_TEST_SIGN_IDENTITY: "-",
        },
      );
      await run(
        [
          process.execPath,
          "--no-env-file",
          "test",
          resolve(root, "tests/packaging/macos-distribution.test.ts"),
        ],
        root,
        {
          BUNAWAY_DISTRIBUTION_APP: app,
        },
      );
    }
  }
}
