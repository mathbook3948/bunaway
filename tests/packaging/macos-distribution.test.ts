import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, resolve } from "node:path";
import { hash, writeJson } from "#cli/files";

const repository = resolve(import.meta.dir, "../..");
const driver = resolve(repository, "packages/packaging/scripts/macos.ts");
const COMMAND_TIMEOUT_MS = 120_000;
setDefaultTimeout(180_000);

/** Run real tools or the public distribution command with bounded lifetime and captured diagnostics. */
async function command(
  args: string[],
  env = process.env,
  expected = 0,
): Promise<string> {
  const child = Bun.spawn(args, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const diagnostics = env.BUNAWAY_DMG_DIAGNOSTICS_DIR;
  if (diagnostics && args[2] === driver && args[3] === "package") {
    for await (const path of new Bun.Glob("*/result.json").scan(diagnostics)) {
      const report: unknown = await Bun.file(resolve(diagnostics, path)).json();
      if (
        report &&
        typeof report === "object" &&
        Reflect.get(report, "temporary") === env.TMPDIR
      ) {
        console.info("DMG_DIAGNOSTICS", JSON.stringify(report));
      }
    }
  }
  expect(code, `${args[0]}\n${output}\n${errors}`).toBe(expected);
  return output;
}
async function plist(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await command([
      "/usr/bin/plutil",
      "-convert",
      "json",
      "-o",
      "-",
      path,
    ]),
  );
}
async function readManifest(app: string) {
  // Both the fixture and the native integration runner write this manifest shape.
  const manifest: {
    host?: {
      kind: string;
      sourceSha256?: string;
    };
    bun: {
      executableSha256: string;
    };
  } = await Bun.file(resolve(app, "Contents/Resources/manifest.json")).json();
  return manifest;
}

// Every test owns its child environment and scratch directory; tool failures never affect other suites.
describe
  .skipIf(process.platform !== "darwin")
  .serial("macOS distribution", () => {
    let templateRoot = "";
    let template: string;
    let upstream: string;
    let root = "";
    let app: string;
    let out: string;
    let stage: string;
    let bin: string;
    let env: NodeJS.ProcessEnv;

    beforeAll(async () => {
      templateRoot = await mkdtemp(
        resolve(tmpdir(), "bunaway-distribution-template-"),
      );
      template = resolve(templateRoot, "Fixture.app");
      const resources = resolve(template, "Contents/Resources");
      await mkdir(resources, {
        recursive: true,
      });
      const host = resolve(template, "Contents/MacOS/bunaway-host");
      await mkdir(dirname(host));
      const source = resolve(templateRoot, "main.ts");
      await writeFile(source, "process.exit(0);\n");
      await command([
        process.execPath,
        "--no-env-file",
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--no-compile-autoload-package-json",
        source,
        "--outfile",
        host,
      ]);
      const info = resolve(template, "Contents/Info.plist");
      await writeJson(info, {
        CFBundleExecutable: "bunaway-host",
        CFBundleIdentifier: "ai.bunaway.distribution-test",
        CFBundleName: "Fixture",
        CFBundlePackageType: "APPL",
        CFBundleShortVersionString: "1.2.3",
        CFBundleVersion: "4",
      });
      await command([
        "/usr/bin/plutil",
        "-convert",
        "binary1",
        info,
      ]);
      await command([
        "/usr/bin/plutil",
        "-insert",
        "Extra",
        "-xml",
        "<dict><key>date</key><date>2026-10-05T23:13:00Z</date><key>data</key><data>YQ==</data><key>values</key><array><string>  padded &amp; text  </string><integer>42</integer></array></dict>",
        info,
      ]);
      upstream = await hash(process.execPath);
      await writeJson(resolve(resources, "manifest.json"), {
        host: {
          kind: "bun-compiled",
          sourceSha256: await hash(host),
        },
        bun: {
          executableSha256: upstream,
        },
      });
    }, COMMAND_TIMEOUT_MS);
    afterAll(async () => {
      if (templateRoot) {
        await rm(templateRoot, {
          recursive: true,
          force: true,
        });
      }
    });
    beforeEach(async () => {
      root = await mkdtemp(resolve(tmpdir(), "bunaway distribution test "));
      app = resolve(root, "Input.app");
      await cp(template, app, {
        recursive: true,
      });
      out = resolve(root, "Signed.app");
      stage = resolve(root, "scratch");
      bin = resolve(root, "bin");
      await mkdir(stage);
      await mkdir(bin);
      await symlink(process.execPath, resolve(bin, "bun"));
      env = {
        ...process.env,
        TMPDIR: stage,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      };
      if (process.env.BUNAWAY_DMG_DIAGNOSTICS === "1") {
        await cp(
          resolve(import.meta.dir, "macos-dmg-diagnostics.fixture.ts"),
          resolve(bin, "macos-dmg-diagnostics.fixture.ts"),
        );
        env.BUNAWAY_DMG_DIAGNOSTICS_DIR = resolve(
          repository,
          "build/macos-packaging-diagnostics",
        );
        await mkdir(env.BUNAWAY_DMG_DIAGNOSTICS_DIR, {
          recursive: true,
        });
        await replaceTool("hdiutil", "diagnostic");
      }
    });
    afterEach(async () => {
      if (root) {
        await rm(root, {
          recursive: true,
          force: true,
        });
        root = "";
      }
    });

    const run = (name: string, args: string[], expected = 0) =>
      command(
        [
          process.execPath,
          "--no-env-file",
          driver,
          name,
          ...args,
        ],
        env,
        expected,
      );
    const matches = (pattern: string) =>
      Array.fromAsync(
        new Bun.Glob(pattern).scan({
          cwd: root,
          dot: true,
          onlyFiles: false,
        }),
      );
    async function replaceTool(name: string, failure?: string): Promise<void> {
      const path = resolve(bin, name);
      await cp(
        resolve(import.meta.dir, "macos-distribution-tool.fixture.ts"),
        path,
      );
      await chmod(path, 0o755);
      if (failure) {
        env.BUNAWAY_TEST_TOOL_FAILURE = failure;
      }
      // Tool state sits beside the fixtures, not in the scratch directory that must end empty.
      env.BUNAWAY_TEST_TOOL_STATE = resolve(bin, "hdiutil-calls");
    }
    const packageDmg = (artifacts: string, expected: number) =>
      run(
        "package",
        [
          "--channel",
          "mac-direct",
          "--app",
          app,
          "--out-dir",
          artifacts,
        ],
        expected,
      );
    /** Number of hdiutil invocations recorded by the fixture (one byte each). */
    async function hdiutilCalls(): Promise<number> {
      return (await Bun.file(env.BUNAWAY_TEST_TOOL_STATE ?? "").text()).length;
    }
    function sign(
      channel = "mac-direct",
      extra: string[] = [],
      expected = 0,
      input = app,
      output = out,
    ) {
      return run(
        "sign",
        [
          "--channel",
          channel,
          "--app",
          input,
          "--out",
          output,
          "--identity",
          "-",
          ...extra,
        ],
        expected,
      );
    }
    async function previousOutput(): Promise<void> {
      await mkdir(out);
      await writeFile(resolve(out, "previous-marker"), "last-good");
    }
    async function assertPrevious(): Promise<void> {
      expect(await Bun.file(resolve(out, "previous-marker")).text()).toBe(
        "last-good",
      );
      expect(await matches("Signed.app.publish.*")).toEqual([]);
      expect(await readdir(stage)).toEqual([]);
    }
    async function assertSigned(
      signedApp: string,
      originalDigest = upstream,
    ): Promise<void> {
      await command([
        "codesign",
        "--verify",
        "--deep",
        "--strict",
        signedApp,
      ]);
      const manifest = await readManifest(signedApp);
      expect(manifest.bun.executableSha256).toBe(originalDigest);
      expect(manifest.host?.kind).toBe("bun-compiled");
      for (const path of [
        "Contents/Resources/runtime/bun",
        "Contents/Helpers/bun",
      ]) {
        expect(await Bun.file(resolve(signedApp, path)).exists()).toBe(false);
      }
      const entitlementsFile = resolve(root, "compiled-entitlements.plist");
      await writeFile(
        entitlementsFile,
        await command([
          "codesign",
          "-d",
          "--entitlements",
          ":-",
          signedApp,
        ]),
      );
      expect(await plist(entitlementsFile)).toMatchObject({
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
      });
    }
    // A hardened compiled app must complete real WebView work before graceful termination.
    async function assertHardenedApp(signedApp: string): Promise<void> {
      const home = resolve(root, "hardened-home");
      await mkdir(home);
      const report = resolve(
        home,
        "Library/Application Support/bunaway/tests.bunaway.host/temp/report3.json",
      );
      const child = Bun.spawn(
        [
          resolve(signedApp, "Contents/MacOS/bunaway-host"),
        ],
        {
          env: {
            HOME: home,
            PATH: "/usr/bin:/bin",
          },
          stdout: "ignore",
          stderr: "pipe",
          timeout: COMMAND_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
      const errors = new Response(child.stderr).text();
      try {
        const deadline = Date.now() + 15_000;
        while (
          !(await Bun.file(report).exists()) &&
          child.exitCode === null &&
          Date.now() < deadline
        ) {
          await Bun.sleep(100);
        }
        expect(
          await Bun.file(report).exists(),
          "Hardened Bun FFI app did not complete its WKWebView report",
        ).toBe(true);
        child.kill("SIGTERM");
        expect(await child.exited, await errors).toBe(0);
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
        await errors;
      }
    }
    async function assertFixtureMetadata(signedApp: string): Promise<void> {
      const metadata = (path: string) =>
        command([
          "/usr/bin/plutil",
          "-extract",
          "Extra",
          "xml1",
          "-o",
          "-",
          resolve(path, "Contents/Info.plist"),
        ]);
      expect(await metadata(signedApp)).toBe(await metadata(template));
    }
    async function notaryMock(): Promise<void> {
      env.NOTARY_LOG = resolve(root, "notary.log");
      await replaceTool("xcrun");
    }
    async function notaryCalls(): Promise<string[][]> {
      return (await Bun.file(resolve(root, "notary.log")).text())
        .trim()
        .split("\n")
        .map((line): string[] => JSON.parse(line));
    }
    async function makeZip(): Promise<string> {
      const contents = resolve(root, "zip-input");
      await mkdir(contents);
      await cp(app, resolve(contents, "Input.app"), {
        recursive: true,
      });
      await writeFile(resolve(contents, "README.txt"), "keep this");
      const archive = resolve(root, "App.zip");
      await command([
        "ditto",
        "-c",
        "-k",
        contents,
        archive,
      ]);
      return archive;
    }

    test("direct signing preserves provenance, updates metadata and cleans staging", async () => {
      await previousOutput();
      await sign("mac-direct", [
        "--display-name",
        "  New Display 이름  ",
        "--bundle-id",
        "ai.bunaway.changed",
        "--version",
        "2.0.0",
        "--build-number",
        "5",
        "--min-os",
        "14.0",
      ]);
      await assertSigned(out);
      await assertFixtureMetadata(out);
      for (const [key, value] of [
        [
          "CFBundleDisplayName",
          "  New Display 이름  ",
        ],
        [
          "CFBundleIdentifier",
          "ai.bunaway.changed",
        ],
        [
          "CFBundleShortVersionString",
          "2.0.0",
        ],
        [
          "CFBundleVersion",
          "5",
        ],
        [
          "LSMinimumSystemVersion",
          "14.0",
        ],
      ] as const) {
        expect(
          await command([
            "/usr/bin/plutil",
            "-extract",
            key,
            "raw",
            "-expect",
            "string",
            "-n",
            resolve(out, "Contents/Info.plist"),
          ]),
        ).toBe(value);
      }
      expect(await Bun.file(resolve(out, "previous-marker")).exists()).toBe(
        false,
      );
      expect(await readdir(stage)).toEqual([]);
      expect(await matches("Signed.app.publish.*")).toEqual([]);
      expect((await readManifest(app)).host?.sourceSha256).toBe(
        await hash(resolve(app, "Contents/MacOS/bunaway-host")),
      );
    });
    test("store layout and entitlements", async () => {
      await sign("mac-store", [
        "--team-id",
        "ABCD1234EF",
      ]);
      await assertSigned(out);
      await assertFixtureMetadata(out);
      expect(
        await Bun.file(resolve(out, "Contents/Resources/runtime/bun")).exists(),
      ).toBe(false);
      const entitlementsFile = resolve(root, "entitlements.plist");
      await writeFile(
        entitlementsFile,
        await command([
          "codesign",
          "-d",
          "--entitlements",
          ":-",
          out,
        ]),
      );
      const entitlements = await plist(entitlementsFile);
      expect(entitlements).toMatchObject({
        "com.apple.security.app-sandbox": true,
      });
      expect(
        Object.hasOwn(entitlements, "com.apple.application-identifier"),
      ).toBe(false);
      expect(
        Object.hasOwn(entitlements, "com.apple.developer.team-identifier"),
      ).toBe(false);
      expect(await readdir(stage)).toEqual([]);
    });
    test("compiled app signing preserves its layout and grants JIT and FFI entitlements in both channels", async () => {
      const manifest = await readManifest(app);
      for (const channel of [
        "mac-direct",
        "mac-store",
      ]) {
        const output = resolve(root, `${channel}.app`);
        await sign(
          channel,
          channel === "mac-store"
            ? [
                "--team-id",
                "ABCD1234EF",
              ]
            : [],
          0,
          app,
          output,
        );
        await assertSigned(output);
        await assertFixtureMetadata(output);
        expect(await readManifest(output)).toEqual(manifest);
      }
      expect(await readdir(stage)).toEqual([]);
    });
    for (const content of [
      "invalid plist",
      '<plist version="1.0"><array/></plist>',
    ]) {
      test(`invalid bundle metadata preserves previous output (${content})`, async () => {
        await previousOutput();
        await writeFile(resolve(app, "Contents/Info.plist"), content);
        await sign("mac-direct", [], 1);
        await assertPrevious();
        await run(
          "package",
          [
            "--channel",
            "mac-direct",
            "--app",
            app,
            "--out-dir",
            resolve(root, "artifacts"),
          ],
          1,
        );
        expect(await Bun.file(resolve(root, "artifacts")).exists()).toBe(false);
      });
    }
    for (const manifest of [
      "invalid",
      JSON.stringify({
        host: {
          kind: "native-host",
        },
      }),
    ]) {
      test(`unsupported manifest preserves previous output (${manifest})`, async () => {
        await previousOutput();
        await writeFile(
          resolve(app, "Contents/Resources/manifest.json"),
          manifest,
        );
        await sign("mac-direct", [], 1);
        await assertPrevious();
        expect(await readdir(stage)).toEqual([]);
      });
    }
    for (const [name, tool, failure] of [
      [
        "verification failure preserves previous output",
        "codesign",
        "verification",
      ],
      [
        "final rename failure restores previous output",
        "mv",
        "final-rename",
      ],
      [
        "backup rename failure leaves previous output",
        "mv",
        "backup-rename",
      ],
    ] as const) {
      test(name, async () => {
        await previousOutput();
        await replaceTool(tool, failure);
        await sign("mac-direct", [], 1);
        await assertPrevious();
      });
    }
    test("failed rollback retains a recoverable backup", async () => {
      await previousOutput();
      await replaceTool("mv", "rollback");
      await sign("mac-direct", [], 1);
      const backups = await matches(
        "Signed.app.publish.*/previous.app/previous-marker",
      );
      expect(backups).toHaveLength(1);
      expect(
        await Bun.file(resolve(root, backups[0] ?? "missing")).text(),
      ).toBe("last-good");
    });
    test("DMG and store PKG are real artifacts and leave no scratch files", async () => {
      for (const channel of [
        "mac-direct",
        "mac-store",
      ]) {
        await sign(
          channel,
          channel === "mac-store"
            ? [
                "--team-id",
                "ABCD1234EF",
              ]
            : [],
        );
        const artifacts = resolve(root, "artifacts");
        await run("package", [
          "--channel",
          channel,
          "--app",
          out,
          "--out-dir",
          artifacts,
        ]);
        const artifact = resolve(
          artifacts,
          `Fixture-1.2.3-4.${channel === "mac-direct" ? "dmg" : "pkg"}`,
        );
        expect(await Bun.file(artifact).exists()).toBe(true);
        if (channel === "mac-direct") {
          await command([
            "hdiutil",
            "verify",
            artifact,
          ]);
          const mount = resolve(root, "mount");
          await mkdir(mount);
          await command([
            "hdiutil",
            "attach",
            "-readonly",
            "-nobrowse",
            "-mountpoint",
            mount,
            artifact,
          ]);
          try {
            await assertSigned(resolve(mount, "Signed.app"));
            await assertFixtureMetadata(resolve(mount, "Signed.app"));
            expect(await readlink(resolve(mount, "Applications"))).toBe(
              "/Applications",
            );
          } finally {
            await command([
              "hdiutil",
              "detach",
              mount,
            ]);
          }
        } else {
          const expanded = resolve(root, "expanded");
          await command([
            "pkgutil",
            "--expand",
            artifact,
            expanded,
          ]);
          expect(
            (
              await Array.fromAsync(
                new Bun.Glob("**/PackageInfo").scan(expanded),
              )
            ).length,
          ).toBeGreaterThan(0);
        }
        expect(await readdir(stage)).toEqual([]);
      }
    });
    test("failed DMG build preserves the existing artifact and cleans staging", async () => {
      const artifacts = resolve(root, "artifacts");
      await mkdir(artifacts);
      const dmg = resolve(artifacts, "Fixture-1.2.3-4.dmg");
      await writeFile(dmg, "last-good");
      await replaceTool("hdiutil", "dmg");
      await packageDmg(artifacts, 1);
      expect(await Bun.file(dmg).text()).toBe("last-good");
      expect(await readdir(stage)).toEqual([]);
      // A non-busy failure must not be retried.
      expect(await hdiutilCalls()).toBe(1);
    });
    test("DMG build retries a transient busy failure and replaces the partial image", async () => {
      const artifacts = resolve(root, "artifacts");
      await mkdir(artifacts);
      await replaceTool("hdiutil", "dmg-busy-once");
      const output = await packageDmg(artifacts, 0);
      expect(output).toContain("attempt 1/3");
      expect(await hdiutilCalls()).toBe(2);
      expect(
        await Bun.file(resolve(artifacts, "Fixture-1.2.3-4.dmg")).text(),
      ).toBe("fixture-dmg");
      expect(await readdir(stage)).toEqual([]);
    });
    test("DMG build stops retrying a persistent busy failure after three attempts", async () => {
      const artifacts = resolve(root, "artifacts");
      await mkdir(artifacts);
      const dmg = resolve(artifacts, "Fixture-1.2.3-4.dmg");
      await writeFile(dmg, "last-good");
      await replaceTool("hdiutil", "dmg-busy-always");
      await packageDmg(artifacts, 1);
      expect(await hdiutilCalls()).toBe(3);
      expect(await Bun.file(dmg).text()).toBe("last-good");
      expect(await readdir(stage)).toEqual([]);
    });
    test("ZIP staples the archived app and rebuilds the archive", async () => {
      const archive = await makeZip();
      await notaryMock();
      await run("notarize", [
        "--artifact",
        archive,
        "--profile",
        "test",
        "--app",
        app,
      ]);
      const unpacked = resolve(root, "result");
      await command([
        "ditto",
        "-x",
        "-k",
        archive,
        unpacked,
      ]);
      expect(
        await Bun.file(
          resolve(unpacked, "Input.app/Contents/Resources/test-ticket"),
        ).exists(),
      ).toBe(true);
      expect(await Bun.file(resolve(unpacked, "README.txt")).text()).toBe(
        "keep this",
      );
      expect(
        (await notaryCalls()).some(
          (call) =>
            call[0] === "stapler" &&
            call[1] === "staple" &&
            call[2]?.endsWith(".zip"),
        ),
      ).toBe(false);
      expect(await matches(".bunaway-notary.*")).toEqual([]);
    });
    test("failed ZIP stapling preserves the original archive", async () => {
      const archive = await makeZip();
      const original = await hash(archive);
      await notaryMock();
      env.FAIL_STAPLE = "1";
      await run(
        "notarize",
        [
          "--artifact",
          archive,
          "--profile",
          "test",
        ],
        1,
      );
      expect(await hash(archive)).toBe(original);
      expect(await matches(".bunaway-notary.*")).toEqual([]);
    });
    test("DMG and optional app are stapled and validated", async () => {
      const dmg = resolve(root, "App.dmg");
      await writeFile(dmg, "mock-dmg");
      await notaryMock();
      await run("notarize", [
        "--artifact",
        dmg,
        "--profile",
        "test",
        "--app",
        app,
      ]);
      const calls = await notaryCalls();
      const staged = calls[1]?.[2] ?? "missing";
      expect(calls.slice(1)).toEqual([
        [
          "stapler",
          "staple",
          staged,
        ],
        [
          "stapler",
          "validate",
          staged,
        ],
        [
          "stapler",
          "staple",
          app,
        ],
        [
          "stapler",
          "validate",
          app,
        ],
      ]);
      expect(basename(staged)).toBe("notarized.dmg");
      expect(basename(dirname(staged)).startsWith(".bunaway-notary.")).toBe(
        true,
      );
      expect(dirname(dirname(staged))).toBe(root);
      expect(await Bun.file(dmg).text()).toBe("mock-dmgticket");
      expect(await matches(".bunaway-notary.*")).toEqual([]);
    });
    test("failed DMG validation preserves the original artifact", async () => {
      const dmg = resolve(root, "App.dmg");
      await writeFile(dmg, "last-good");
      await notaryMock();
      env.FAIL_VALIDATE = "1";
      await run(
        "notarize",
        [
          "--artifact",
          dmg,
          "--profile",
          "test",
        ],
        1,
      );
      const calls = await notaryCalls();
      expect(calls.slice(1).map((call) => call.slice(0, 2))).toEqual([
        [
          "stapler",
          "staple",
        ],
        [
          "stapler",
          "validate",
        ],
      ]);
      expect(calls[1]?.[2]).toBe(calls[2]?.[2]);
      expect(calls[1]?.[2]).not.toBe(dmg);
      expect(await Bun.file(dmg).text()).toBe("last-good");
      expect(await matches(".bunaway-notary.*")).toEqual([]);
    });
    test("invalid notary status is not treated as accepted", async () => {
      const archive = await makeZip();
      const original = await hash(archive);
      await notaryMock();
      env.NOTARY_STATUS = "Invalid";
      await run(
        "notarize",
        [
          "--artifact",
          archive,
          "--profile",
          "test",
        ],
        1,
      );
      expect(await hash(archive)).toBe(original);
      expect(await notaryCalls()).toHaveLength(1);
    });
    test("missing notary profile returns unverified without submission", async () => {
      const archive = await makeZip();
      await notaryMock();
      await run(
        "notarize",
        [
          "--artifact",
          archive,
        ],
        2,
      );
      expect(await Bun.file(resolve(root, "notary.log")).exists()).toBe(false);
    });
    const source = process.env.BUNAWAY_DISTRIBUTION_APP;
    test.skipIf(!source)("real Bunaway bundle in both channels", async () => {
      const input = resolve(source ?? "");
      const manifest = await readManifest(input);
      for (const channel of [
        "mac-direct",
        "mac-store",
      ]) {
        const output = resolve(root, `${channel}.app`);
        await sign(
          channel,
          channel === "mac-store"
            ? [
                "--team-id",
                "ABCD1234EF",
              ]
            : [],
          0,
          input,
          output,
        );
        await assertSigned(output, manifest.bun.executableSha256);
        if (
          manifest.host?.kind === "bun-compiled" &&
          channel === "mac-direct"
        ) {
          await assertHardenedApp(output);
        }
      }
    });
  });
