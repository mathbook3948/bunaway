import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  artifactPaths,
  type BuildArtifact,
  type BuildTarget,
  CODES,
  isChannelId,
  loadManifest,
  loadPackaging,
  type PackageAdapter,
  type PackageManifest,
  type PackageReport,
  packagedDigest,
  packagingReportPath,
  parsePackaging,
  platformOf,
  resolvePackaging,
  runPackage,
  type StageContext,
  targetFor,
  verifyArtifact,
} from "../../packages/packaging/src/index.ts";

let home: string;
let root: string;
let artifactDir: string;

const runtimeAssets = [
  "assets/process.schema.json",
  "assets/message.schema.json",
  "assets/host-call.schema.json",
  "assets/host-operations.json",
  "assets/policy.schema.json",
] as const;

const appConfig = {
  appId: "app.test",
  title: "Test App",
  view: "main",
  home: "https://app.bunaway.local/index.html",
  window: { width: 800, height: 600 },
};

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await Bun.file(path).bytes())
    .digest("hex");

async function writeJson(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Builds a minimal valid dist/windows-x64 artifact: bunaway-host.exe,
// runtime/bun.exe, assets/, licenses/ and manifest.json matching every hash.
async function makeArtifact(
  projectRoot = root,
  target: BuildTarget = "windows-x64",
): Promise<PackageManifest> {
  const artifact = artifactPaths({ root: projectRoot, target, appId: "app.test" });
  const dir = artifact.packageDir;
  const windows = target === "windows-x64";
  const runtime = resolve(dir, windows ? "runtime/bun.exe" : "runtime/bun");
  if (projectRoot === root) artifactDir = dir;
  await mkdir(resolve(dir, "assets"), { recursive: true });
  await mkdir(resolve(dir, "runtime"), { recursive: true });
  await mkdir(resolve(dir, "licenses"), { recursive: true });
  await mkdir(resolve(artifact.executable, ".."), { recursive: true });
  await writeFile(artifact.executable, "fake host");
  if (!windows) {
    await chmod(artifact.executable, 0o755);
    await writeFile(
      resolve(artifact.dir, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bunaway-host</string>
<key>CFBundleIdentifier</key><string>app.test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
    );
  }
  await writeFile(runtime, "fake bun");
  if (!windows) await chmod(runtime, 0o755);
  const assets: Record<string, string> = {};
  await writeJson(resolve(dir, "assets/app.json"), appConfig);
  assets["assets/app.json"] = await sha256(resolve(dir, "assets/app.json"));
  for (const path of [
    "assets/web/index.html",
    "assets/policy.json",
    "assets/backend.js",
    "assets/bunfig.toml",
    "assets/tsconfig.json",
    ...runtimeAssets,
    "licenses/LICENSE.bun",
    "licenses/LICENSE.nlohmann-json",
    ...(windows ? ["licenses/License-WebView2.txt"] : []),
  ]) {
    await mkdir(resolve(dir, path, ".."), { recursive: true });
    await writeFile(resolve(dir, path), "{}");
    assets[path] = await sha256(resolve(dir, path));
  }
  const manifest: PackageManifest = {
    bun: {
      version: "1.4.2",
      sourceRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
      target: windows ? "windows-x64-baseline" : "darwin-aarch64",
      executableSha256: await sha256(runtime),
      licenseSha256: assets["licenses/LICENSE.bun"] ?? "",
    },
    assets,
    app: { id: "app.test", version: "0.1.0" },
    host: {
      target,
      sha256: await sha256(artifact.executable),
    },
  };
  await writeJson(resolve(dir, "manifest.json"), manifest);
  return manifest;
}

async function makeSignedMacArtifact(projectRoot: string) {
  const manifest = await makeArtifact(projectRoot, "macos-arm64");
  const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
  await copyFile("/bin/echo", artifact.executable);
  manifest.host = { target: "macos-arm64", sourceSha256: await sha256(artifact.executable) };
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  const signing = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", artifact.dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([signing.exited, new Response(signing.stderr).text()]);
  expect(exit, stderr).toBe(0);
  return { artifact, manifest };
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "bunaway-packaging-")));
  root = resolve(home, "project");
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(config: unknown) {
  await writeFile(resolve(root, "packaging.json"), JSON.stringify(config));
}

const resolveArgs = {
  appId: "app.test",
  title: "Test App",
  projectVersion: "0.1.0",
};

function stubAdapter(options: {
  channel?: PackageAdapter["channel"];
  requirement?: PackageAdapter["signingRequirement"];
  run?: (ctx: StageContext) => Promise<void>;
  stages?: PackageAdapter["stages"];
}): PackageAdapter {
  return {
    channel: options.channel ?? "win-direct",
    platform: platformOf(options.channel ?? "win-direct"),
    signingRequirement: options.requirement ?? "optional",
    stages:
      options.stages ??
      (() => [
        {
          id: "stub",
          title: "Stub stage",
          async run(ctx: StageContext) {
            await options.run?.(ctx);
          },
        },
      ]),
  };
}

function runAdapter(
  projectRoot: string,
  adapter: PackageAdapter,
  options: { target?: BuildTarget; artifact?: BuildArtifact } = {},
) {
  const target = options.target ?? "windows-x64";
  return runPackage({
    metadata: {
      root: projectRoot,
      name: "Test App",
      identifier: "app.test",
      publisher: { display: "Test" },
      version: { semver: "0.1.0", build: 0, msix: "0.1.0.0" },
      icons: {},
      targets:
        target === "windows-x64"
          ? [{ platform: "windows", arch: "x64" }]
          : [{ platform: "macos", arch: "arm64" }],
    },
    appId: "app.test",
    channel: adapter.channel,
    channelConfig: {},
    target,
    artifact: options.artifact ?? artifactPaths({ root: projectRoot, target, appId: "app.test" }),
    adapter,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the package lock excludes another Bun process and is released afterwards", async () => {
  const projectRoot = resolve(home, "cross-process-lock");
  await makeArtifact(projectRoot);
  const entrypoint = new URL("../../packages/packaging/src/index.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { runPackage, artifactPaths } from ${JSON.stringify(entrypoint)};
    const root = ${JSON.stringify(projectRoot)};
    const report = await runPackage({
      metadata: { root, name: "Test", identifier: "app.test", publisher: { display: "Test" },
        version: { semver: "0.1.0", build: 0, msix: "0.1.0.0" }, icons: {}, targets: [] },
      appId: "app.test", channel: "win-direct", channelConfig: {}, target: "windows-x64",
      artifact: artifactPaths({ root, target: "windows-x64", appId: "app.test" }),
      adapter: { channel: "win-direct", platform: "windows", signingRequirement: "optional",
        stages: () => [{ id: "assemble", title: "Assemble", run: async (ctx) => {
          await Bun.write(Bun.stdout, "ready\\n");
          await new Response(Bun.stdin).text();
          await Bun.write(ctx.staging + "/app.zip", "child");
          ctx.addArtifact("app.zip", "archive");
        } }] },
    });
    if (!report.ok) { console.error(JSON.stringify(report)); process.exitCode = 1; }
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    let ran = false;
    const blocked = await runAdapter(
      projectRoot,
      stubAdapter({
        run: async () => {
          ran = true;
        },
      }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics.some((d) => d.code === CODES.LOCK_FAILED)).toBe(true);
    expect(ran).toBe(false);
    expect(
      await Bun.file(packagingReportPath(projectRoot, "windows-x64", "win-direct")).exists(),
    ).toBe(false);
  } finally {
    child.stdin.end();
    await child.exited;
    reader.releaseLock();
  }
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const retry = await runAdapter(
    projectRoot,
    stubAdapter({
      run: async (ctx) => {
        await Bun.write(resolve(ctx.staging, "app.zip"), "retry");
        ctx.addArtifact("app.zip", "archive");
      },
    }),
  );
  expect(retry.ok).toBe(true);
}, 10000);

test("an active channel does not block a different channel", async () => {
  const projectRoot = resolve(home, "independent-channel-locks");
  await makeArtifact(projectRoot);
  const entered = deferred();
  const resume = deferred();
  const first = runAdapter(
    projectRoot,
    stubAdapter({
      run: async (ctx) => {
        entered.resolve();
        await resume.promise;
        await Bun.write(resolve(ctx.staging, "app.zip"), "first");
        ctx.addArtifact("app.zip", "archive");
      },
    }),
  );
  try {
    await entered.promise;
    const second = await runAdapter(
      projectRoot,
      stubAdapter({
        channel: "win-store-msix",
        run: async (ctx) => {
          await Bun.write(resolve(ctx.staging, "app.msix"), "second");
          ctx.addArtifact("app.msix", "msix", { signed: true });
        },
      }),
    );
    expect(second.ok).toBe(true);
  } finally {
    resume.resolve();
    await first;
  }
  expect((await first).ok).toBe(true);
});

test("an existing package lock is not removed or overwritten by a rejected run", async () => {
  const projectRoot = resolve(home, "existing-channel-lock");
  await makeArtifact(projectRoot);
  const lockPath = resolve(projectRoot, "dist/windows-x64/packaged/win-direct.lock");
  await Bun.write(lockPath, "another owner");
  const result = await runAdapter(projectRoot, stubAdapter({}));
  expect(result.ok).toBe(false);
  expect(await Bun.file(lockPath).text()).toBe("another owner");
  expect(
    await Bun.file(packagingReportPath(projectRoot, "windows-x64", "win-direct")).exists(),
  ).toBe(false);
});

test.each([false, true])(
  "concurrent publication is rejected without touching the active run (rollback=%s)",
  async (rollback) => {
    const projectRoot = resolve(home, `concurrent-${rollback}`);
    await makeArtifact(projectRoot);
    const adapter = (payload: string) =>
      stubAdapter({
        run: async (ctx) => {
          await Bun.write(resolve(ctx.staging, "app.zip"), payload);
          ctx.addArtifact("app.zip", "archive");
        },
      });
    await runAdapter(projectRoot, adapter("old"));
    const reportPath = packagingReportPath(projectRoot, "windows-x64", "win-direct");
    const previousReport = await Bun.file(reportPath).text();
    const entered = deferred();
    const resume = deferred();
    const fs = await import("node:fs/promises");
    const rename = fs.rename;
    let blocked = false;
    const publication = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === reportPath && !blocked) {
        blocked = true;
        entered.resolve();
        await resume.promise;
        if (rollback) throw new Error("Injected report failure.");
      }
      await rename(from, to);
    });
    const first = runAdapter(projectRoot, adapter("first"));
    try {
      await entered.promise;
      let ran = false;
      const second = await runAdapter(
        projectRoot,
        stubAdapter({
          run: async (ctx) => {
            ran = true;
            await Bun.write(resolve(ctx.staging, "app.zip"), "second");
            ctx.addArtifact("app.zip", "archive");
          },
        }),
      );
      expect(second.ok).toBe(false);
      expect(second.diagnostics.some((d) => d.code === CODES.LOCK_FAILED)).toBe(true);
      expect(ran).toBe(false);
      expect(await Bun.file(reportPath).text()).toBe(previousReport);
    } finally {
      resume.resolve();
      await first;
      publication.mockRestore();
    }
    const result = await first;
    expect(result.ok).toBe(!rollback);
    const output = resolve(projectRoot, "dist/windows-x64/packaged/win-direct/app.zip");
    expect(await Bun.file(output).text()).toBe(rollback ? "old" : "first");
    if (!rollback) {
      const published = (await Bun.file(reportPath).json()) as PackageReport;
      expect(published.artifacts[0]?.sha256).toBe(await sha256(output));
    }
    expect((await runAdapter(projectRoot, adapter("second"))).ok).toBe(true);
    expect(await Bun.file(output).text()).toBe("second");
    expect(
      (await readdir(resolve(projectRoot, "dist/windows-x64/packaged"))).some(
        (name) =>
          name.includes(".lock") || name.includes(".building-") || name.includes(".previous-"),
      ),
    ).toBe(false);
  },
);

async function expectRejectedInputs(
  projectRoot: string,
  code: string,
  options: { target?: BuildTarget; artifact?: BuildArtifact } = {},
) {
  const target = options.target ?? "windows-x64";
  const channel = target === "windows-x64" ? "win-direct" : "mac-direct";
  const previous = resolve(projectRoot, "dist", target, "packaged", channel, "setup.exe");
  await Bun.write(previous, "previous output");
  let ran = false;
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      channel,
      run: async (ctx) => {
        ran = true;
        await Bun.write(resolve(ctx.staging, "setup.exe"), "new output");
        ctx.addArtifact("setup.exe", "installer");
      },
    }),
    options,
  );
  expect(report.ok).toBe(false);
  expect(report.usable).toBe(false);
  expect(report.submittable).toBe(false);
  expect(report.diagnostics.some((d) => d.code === code && d.severity === "error")).toBe(true);
  expect(ran).toBe(false);
  expect(await Bun.file(previous).text()).toBe("previous output");
  return report;
}

test("packaging.json rejects malformed shapes before adapters run", async () => {
  const valid = { version: 1, channels: { "win-direct": {} } };
  for (const invalid of [
    { version: 2 },
    { version: 1, unknownField: true },
    { version: 1, name: "" },
    { version: 1, identifier: "no-dots" },
    { version: 1, identifier: "-bad.example.com" },
    { version: 1, publisher: { identity: "Example Inc." } },
    { version: 1, release: { version: "1.2" } },
    { version: 1, release: { build: -1 } },
    { version: 1, release: { build: 70000 } },
    { version: 1, icons: { windows: { square128: "x.png" } } },
    { version: 1, icons: { directory: "../escape" } },
    { version: 1, targets: [] },
    { version: 1, targets: [{ platform: "linux", arch: "x64" }] },
    {
      version: 1,
      targets: [
        { platform: "windows", arch: "x64" },
        { platform: "windows", arch: "x64" },
      ],
    },
    { version: 1, channels: { "linux-flatpak": {} } },
    { version: 1, channels: { "win-direct": { bogus: true } } },
    { version: 1, channels: { "win-store-unpackaged": { webView2: "bootstrap" } } },
    { version: 1, signing: {} },
    { version: 1, signing: { certificateFile: "cert.pfx", passwordEnv: "9BAD" } },
    { version: 1, channels: { "win-direct": { signing: { subject: "CN=X" } } } },
  ]) {
    expect(() => parsePackaging(JSON.stringify(invalid))).toThrow();
  }
  expect(() => parsePackaging(JSON.stringify(valid))).not.toThrow();
  expect(() => parsePackaging("{ not json")).toThrow();
});

test("resolve derives identity from app.json/package.json and selects the channel", async () => {
  await writeConfig({ version: 1, channels: { "win-direct": {}, "mac-direct": {} } });
  const config = await loadPackaging(root);
  const { metadata, channel } = await resolvePackaging({
    root,
    config,
    channel: "win-direct",
    ...resolveArgs,
  });
  expect(metadata.name).toBe("Test App");
  expect(metadata.identifier).toBe("app.test");
  expect(metadata.publisher.display).toBe("Test App");
  expect(metadata.version).toEqual({ semver: "0.1.0", build: 0, msix: "0.1.0.0" });
  expect(channel.channelConfig).toEqual({});
  await expect(
    resolvePackaging({ root, config, channel: "win-store-msix", ...resolveArgs }),
  ).rejects.toThrow("channels.win-store-msix");
  await writeConfig({
    version: 1,
    name: "Renamed",
    identifier: "com.example.app",
    publisher: { display: "Example", identity: "CN=Example" },
    release: { version: "1.2.3", build: 7 },
    signing: { certificateFile: "cert.pfx", passwordEnv: "CERT_PASSWORD" },
    channels: { "win-direct": { signing: { thumbprint: "abc123" } }, "win-store-msix": {} },
  });
  await expect(
    resolvePackaging({
      root,
      config: {
        targets: [{ platform: "windows", arch: "arm64" }],
        channels: { "win-direct": {} },
      },
      channel: "win-direct",
      ...resolveArgs,
    }),
  ).rejects.toThrow();
  const overridden = await resolvePackaging({
    root,
    config: await loadPackaging(root),
    channel: "win-direct",
    ...resolveArgs,
  });
  expect(overridden.metadata.identifier).toBe("com.example.app");
  expect(overridden.metadata.version.msix).toBe("1.2.3.7");
  expect(overridden.channel.signing?.thumbprint).toBe("abc123");
  const inherited = await resolvePackaging({
    root,
    config: await loadPackaging(root),
    channel: "win-store-msix",
    ...resolveArgs,
  });
  expect(inherited.channel.signing?.certificateFile).toBe("cert.pfx");
});

test("verify stage rejects missing and tampered build inputs", async () => {
  const manifest = await makeArtifact();
  const artifact = artifactPaths({ root, target: "windows-x64", appId: "app.test" });
  expect(await verifyArtifact({ artifact, manifest, channel: "win-direct" })).toEqual([]);
  await writeFile(artifact.executable, "tampered host");
  let diagnostics = await verifyArtifact({ artifact, manifest, channel: "win-direct" });
  expect(diagnostics).toContainEqual({
    stage: "verify",
    code: CODES.INPUT_TAMPERED,
    severity: "error",
    message: "Host executable hash mismatch.",
    path: artifact.executable,
  });
  await writeFile(artifact.executable, "fake host");
  await writeFile(resolve(artifactDir, "assets/app.json"), "tampered");
  diagnostics = await verifyArtifact({ artifact, manifest, channel: "win-direct" });
  expect(diagnostics.map((d) => d.code)).toContain(CODES.INPUT_TAMPERED);
  await writeJson(resolve(artifactDir, "assets/app.json"), appConfig);
  expect(await verifyArtifact({ artifact, manifest, channel: "win-direct" })).toEqual([]);
  await rm(resolve(artifactDir, "runtime/bun.exe"));
  diagnostics = await verifyArtifact({ artifact, manifest, channel: "win-direct" });
  expect(diagnostics.map((d) => d.code)).toContain(CODES.INPUT_MISSING);
  await writeFile(resolve(artifactDir, "runtime/bun.exe"), "fake bun");
});

test("runner produces a report, records diagnostics and labels unsigned output", async () => {
  await writeConfig({ version: 1, channels: { "win-direct": {} } });
  const config = await loadPackaging(root);
  const { metadata, channel } = await resolvePackaging({
    root,
    config,
    channel: "win-direct",
    ...resolveArgs,
  });
  await makeArtifact();
  const adapter = stubAdapter({
    async run(ctx) {
      await Bun.write(resolve(ctx.staging, "app-setup.exe"), "installer bytes");
      ctx.addArtifact("app-setup.exe", "installer");
      ctx.report({ code: "PKG_DEMO", severity: "info", message: "stage ran" });
    },
  });
  const report = await runPackage({
    metadata,
    appId: "app.test",
    channel: "win-direct",
    channelConfig: channel.channelConfig,
    target: "windows-x64",
    artifact: artifactPaths({ root, target: "windows-x64", appId: "app.test" }),
    adapter,
  });
  expect(report.ok).toBe(true);
  expect(report.usable).toBe(true);
  expect(report.submittable).toBe(false);
  expect(report.signing.configured).toBe(false);
  expect(report.diagnostics.map((d) => d.code)).toContain(CODES.SIGNING_MISSING);
  const artifactEntry = report.artifacts[0];
  expect(artifactEntry?.path).toBe(
    resolve(root, "dist/windows-x64/packaged/win-direct/app-setup.exe"),
  );
  expect(artifactEntry?.sha256).toHaveLength(64);
  expect(await Bun.file(packagingReportPath(root, "windows-x64", "win-direct")).exists()).toBe(
    true,
  );
});

test("failed adapter stages keep the previous packaged output intact", async () => {
  await writeConfig({ version: 1, channels: { "win-direct": {} } });
  const config = await loadPackaging(root);
  const { metadata, channel } = await resolvePackaging({
    root,
    config,
    channel: "win-direct",
    ...resolveArgs,
  });
  const artifact = artifactPaths({ root, target: "windows-x64", appId: "app.test" });
  const previous = resolve(root, "dist/windows-x64/packaged/win-direct/app-setup.exe");
  expect(await Bun.file(previous).exists()).toBe(true); // from the passing run above
  const failing = stubAdapter({
    run: async () => {
      throw new Error("tool exploded");
    },
  });
  const report = await runPackage({
    metadata,
    appId: "app.test",
    channel: "win-direct",
    channelConfig: channel.channelConfig,
    target: "windows-x64",
    artifact,
    adapter: failing,
  });
  expect(report.ok).toBe(false);
  expect(report.usable).toBe(false);
  expect(report.submittable).toBe(false);
  expect(report.stages.find((s) => s.id === "stub")?.status).toBe("failed");
  expect(report.diagnostics.map((d) => d.code)).toContain(CODES.STAGE_FAILED);
  expect(await Bun.file(previous).exists()).toBe(true);
});

test("required-to-run channels mark unsigned output unusable", async () => {
  const adapter = stubAdapter({
    channel: "win-store-msix",
    requirement: "required-to-run",
    run: async (ctx) => {
      await Bun.write(resolve(ctx.staging, "app.msix"), "msix bytes");
      ctx.addArtifact("app.msix", "msix");
    },
  });
  await makeArtifact();
  const report = await runPackage({
    metadata: {
      root,
      name: "Test App",
      identifier: "app.test",
      publisher: { display: "Test" },
      version: { semver: "0.1.0", build: 0, msix: "0.1.0.0" },
      icons: {},
      targets: [{ platform: "windows", arch: "x64" }],
    },
    appId: "app.test",
    channel: "win-store-msix",
    channelConfig: {},
    target: "windows-x64",
    artifact: artifactPaths({ root, target: "windows-x64", appId: "app.test" }),
    adapter,
  });
  expect(report.ok).toBe(true);
  expect(report.usable).toBe(false);
  expect(report.submittable).toBe(false);
  expect(
    report.diagnostics.some((d) => d.code === CODES.SIGNING_MISSING && d.severity === "warning"),
  ).toBe(true);
});

test.each(["optional", "required-to-run", "required-to-submit"] as const)(
  "%s channels cannot use a signed helper to cover an unsigned distribution artifact",
  async (requirement) => {
    const projectRoot = await mkdtemp(join(home, "mixed-signing-"));
    await makeArtifact(projectRoot);
    const report = await runAdapter(
      projectRoot,
      stubAdapter({
        channel: "win-store-msix",
        requirement,
        run: async (ctx) => {
          await Bun.write(resolve(ctx.staging, "app.msix"), "unsigned package");
          ctx.addArtifact("app.msix", "msix");
          await Bun.write(resolve(ctx.staging, "helper.exe"), "signed helper");
          ctx.addArtifact("helper.exe", "helper", { signed: true });
        },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.signing.performed).toBe(true);
    expect(report.usable).toBe(requirement !== "required-to-run");
    expect(report.submittable).toBe(false);
    expect(report.artifacts.find((a) => a.kind === "msix")?.signed).toBe(false);
  },
);

test("unsigned sidecars do not invalidate signed distribution artifacts", async () => {
  const projectRoot = await mkdtemp(join(home, "signed-sidecar-"));
  await makeArtifact(projectRoot);
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      channel: "win-store-msix",
      requirement: "required-to-run",
      run: async (ctx) => {
        await Bun.write(resolve(ctx.staging, "app.msix"), "signed package");
        ctx.addArtifact("app.msix", "msix", { signed: true });
        await Bun.write(resolve(ctx.staging, "checksums.txt"), "checksums");
        ctx.addArtifact("checksums.txt", "checksum", { signingRequired: false });
      },
    }),
  );
  expect(report.ok).toBe(true);
  expect(report.usable).toBe(true);
  expect(report.submittable).toBe(true);
  expect(report.diagnostics.some((d) => d.code === CODES.SIGNING_MISSING)).toBe(false);
  expect(report.artifacts.find((a) => a.kind === "checksum")?.signingRequired).toBe(false);
});

test("signed sidecars alone do not make a channel submittable", async () => {
  const projectRoot = await mkdtemp(join(home, "only-sidecar-"));
  await makeArtifact(projectRoot);
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      channel: "win-store-msix",
      requirement: "required-to-run",
      run: async (ctx) => {
        await Bun.write(resolve(ctx.staging, "checksums.txt"), "signed checksums");
        ctx.addArtifact("checksums.txt", "checksum", { signed: true, signingRequired: false });
      },
    }),
  );
  expect(report.ok).toBe(true);
  expect(report.usable).toBe(false);
  expect(report.submittable).toBe(false);
});

test("tampered inputs abort before adapter stages run", async () => {
  await writeFile(resolve(artifactDir, "assets/app.json"), "tampered");
  let ran = false;
  const adapter = stubAdapter({
    run: async () => {
      ran = true;
    },
  });
  const report = await runPackage({
    metadata: {
      root,
      name: "Test App",
      identifier: "app.test",
      publisher: { display: "Test" },
      version: { semver: "0.1.0", build: 0, msix: "0.1.0.0" },
      icons: {},
      targets: [{ platform: "windows", arch: "x64" }],
    },
    appId: "app.test",
    channel: "win-direct",
    channelConfig: {},
    target: "windows-x64",
    artifact: artifactPaths({ root, target: "windows-x64", appId: "app.test" }),
    adapter,
  });
  expect(report.ok).toBe(false);
  expect(ran).toBe(false);
  expect(report.stages.find((s) => s.id === "verify")?.status).toBe("failed");
  await writeFile(resolve(artifactDir, "assets/app.json"), "{}");
});

test("packagedSha256 is preferred over the upstream digest", () => {
  expect(packagedDigest({ executableSha256: "upstream", packagedSha256: "signed" })).toBe("signed");
  expect(packagedDigest({ executableSha256: "upstream" })).toBe("upstream");
  expect(
    packagedDigest({ executableSha256: "upstream", sha256: "signed", sourceSha256: "signed" }),
  ).toBe("upstream");
  expect(packagedDigest({ sourceSha256: "pre", sha256: "final" })).toBe("final");
  expect(packagedDigest({})).toBeUndefined();
});

test("channel helpers stay consistent", () => {
  expect(platformOf("win-direct")).toBe("windows");
  expect(platformOf("mac-store")).toBe("macos");
  expect(targetFor("windows", "x64")).toBe("windows-x64");
  expect(targetFor("macos", "arm64")).toBe("macos-arm64");
  expect(() => targetFor("windows", "arm64")).toThrow();
  expect(isChannelId("win-direct")).toBe(true);
  expect(isChannelId("exe")).toBe(false);
});

test.each([
  {
    channel: "win-direct",
    adapterChannel: "win-store-msix",
    platform: "windows",
    target: "windows-x64",
  },
  { channel: "win-direct", adapterChannel: "mac-direct", platform: "macos", target: "windows-x64" },
  { channel: "win-direct", adapterChannel: "win-direct", platform: "macos", target: "windows-x64" },
  {
    channel: "win-direct",
    adapterChannel: "win-direct",
    platform: "windows",
    target: "macos-arm64",
  },
  { channel: "mac-direct", adapterChannel: "mac-direct", platform: "macos", target: "windows-x64" },
] as const)(
  "runner rejects mismatched channel/adapter/target: %j",
  async ({ channel, adapterChannel, platform, target }) => {
    const projectRoot = await mkdtemp(join(home, "platform-"));
    await makeArtifact(projectRoot);
    const previous = resolve(projectRoot, "dist", target, "packaged", channel, "previous.txt");
    await Bun.write(previous, "previous output");
    let resolved = false;
    const adapter: PackageAdapter = {
      ...stubAdapter({ channel: adapterChannel }),
      platform,
      stages: () => {
        resolved = true;
        return [];
      },
    };
    const report = await runPackage({
      metadata: {
        root: projectRoot,
        name: "Test App",
        identifier: "app.test",
        publisher: { display: "Test" },
        version: { semver: "0.1.0", build: 0, msix: "0.1.0.0" },
        icons: {},
        targets: [],
      },
      appId: "app.test",
      channel,
      channelConfig: {},
      target,
      artifact: artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" }),
      adapter,
    });
    expect(resolved).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.usable).toBe(false);
    expect(report.submittable).toBe(false);
    expect(report.artifacts).toEqual([]);
    expect(report.diagnostics.filter((d) => d.severity === "error")).toEqual([
      expect.objectContaining({ stage: "resolve", code: CODES.CONFIG_INVALID }),
    ]);
    expect(await Bun.file(previous).text()).toBe("previous output");
    const saved = await Bun.file(packagingReportPath(projectRoot, target, channel)).json();
    expect(saved.ok).toBe(false);
  },
);

test("host digests require final Windows hashes and reject tampering before adapters run", async () => {
  const projectRoot = await mkdtemp(join(home, "host-"));
  const manifest = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  const original = await sha256(artifact.executable);
  manifest.host = { target: "windows-x64", sourceSha256: original };
  expect(
    (await verifyArtifact({ artifact, manifest, channel: "win-direct" })).map((d) => d.code),
  ).toContain(CODES.INPUT_MISSING);
  manifest.host.packagedSha256 = original;
  manifest.host.sha256 = "upstream";
  expect(await verifyArtifact({ artifact, manifest, channel: "win-direct" })).toEqual([]);
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  await writeFile(artifact.executable, "tampered host");
  let ran = false;
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      run: async () => {
        ran = true;
      },
    }),
  );
  expect(report.ok).toBe(false);
  expect(report.diagnostics.map((d) => d.code)).toContain(CODES.INPUT_TAMPERED);
  expect(ran).toBe(false);
});

test("missing, partial, empty and non-file outputs fail before replacing previous artifacts", async () => {
  for (const mode of ["missing", "partial", "empty", "directory"]) {
    const projectRoot = await mkdtemp(join(home, `${mode}-`));
    await makeArtifact(projectRoot);
    const packaged = resolve(projectRoot, "dist/windows-x64/packaged");
    const previous = resolve(packaged, "win-direct/setup.exe");
    await Bun.write(previous, "last good installer");
    const report = await runAdapter(
      projectRoot,
      stubAdapter({
        async run(ctx) {
          if (mode === "empty") return;
          if (mode === "partial") {
            await Bun.write(resolve(ctx.staging, "setup.exe"), "new installer");
            ctx.addArtifact("setup.exe", "installer", { signed: true });
          }
          if (mode === "directory") await mkdir(resolve(ctx.staging, "missing.exe"));
          ctx.addArtifact("missing.exe", "installer", { signed: true });
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.usable).toBe(false);
    expect(report.submittable).toBe(false);
    expect(report.signing.performed).toBe(false);
    expect(report.artifacts).toEqual([]);
    expect(
      report.diagnostics.some((d) => d.code === CODES.VERIFY_FAILED && d.severity === "error"),
    ).toBe(true);
    expect(report.stages.find((s) => s.id === "verify-artifact")?.status).toBe("failed");
    expect(await Bun.file(previous).text()).toBe("last good installer");
    expect(
      (await readdir(packaged)).some(
        (name) => name.includes(".building-") || name.includes(".previous-"),
      ),
    ).toBe(false);
    const saved = await Bun.file(
      packagingReportPath(projectRoot, "windows-x64", "win-direct"),
    ).json();
    expect(saved.ok).toBe(false);
    expect(saved.submittable).toBe(false);
    expect(saved.artifacts).toEqual([]);
  }
});

test("signed output is submittable only after its file has been verified and published", async () => {
  const projectRoot = await mkdtemp(join(home, "signed-"));
  await makeArtifact(projectRoot);
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      channel: "win-store-msix",
      requirement: "required-to-run",
      async run(ctx) {
        const path = resolve(ctx.staging, "app.msix");
        await Bun.write(path, "signed artifact");
        ctx.addArtifact(path, "msix", { signed: true });
      },
    }),
  );
  expect(report.ok).toBe(true);
  expect(report.usable).toBe(true);
  expect(report.submittable).toBe(true);
  expect(report.signing.performed).toBe(true);
  expect(report.artifacts[0]?.path).toBe(
    resolve(projectRoot, "dist/windows-x64/packaged/win-store-msix/app.msix"),
  );
  expect(report.artifacts[0]?.sha256).toBe(await sha256(report.artifacts[0]?.path ?? ""));
});

test("publication errors restore previous output and write a failed report", async () => {
  const projectRoot = await mkdtemp(join(home, "publish-"));
  await makeArtifact(projectRoot);
  const previous = resolve(projectRoot, "dist/windows-x64/packaged/win-direct/setup.exe");
  await Bun.write(previous, "last good installer");
  const fs = await import("node:fs/promises");
  const rename = fs.rename;
  let staging = "";
  const publication = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === staging) throw new Error("Output publication failed.");
    await rename(from, to);
  });
  let report: PackageReport;
  try {
    report = await runAdapter(
      projectRoot,
      stubAdapter({
        async run(ctx) {
          staging = ctx.staging;
          await Bun.write(resolve(ctx.staging, "setup.exe"), "new installer");
          ctx.addArtifact("setup.exe", "installer", { signed: true });
        },
      }),
    );
  } finally {
    publication.mockRestore();
  }
  expect(report.ok).toBe(false);
  expect(report.usable).toBe(false);
  expect(report.submittable).toBe(false);
  expect(report.signing.performed).toBe(false);
  expect(report.artifacts).toEqual([]);
  expect(
    report.diagnostics.some((d) => d.stage === "report" && d.code === CODES.STAGE_FAILED),
  ).toBe(true);
  expect(await Bun.file(previous).text()).toBe("last good installer");
  expect(
    (await Bun.file(packagingReportPath(projectRoot, "windows-x64", "win-direct")).json()).ok,
  ).toBe(false);
});

test.each(
  (["write", "rename"] as const).flatMap((failure) =>
    [false, true].map((previous) => ({ failure, previous })),
  ),
)(
  "report $failure failure preserves publication state (previous=$previous)",
  async ({ failure, previous }) => {
    const projectRoot = await mkdtemp(join(home, "report-publication-"));
    await makeArtifact(projectRoot);
    const packaged = resolve(projectRoot, "dist/windows-x64/packaged");
    const output = resolve(packaged, "win-direct/setup.exe");
    const reportPath = packagingReportPath(projectRoot, "windows-x64", "win-direct");
    if (previous) await Bun.write(output, "last good installer");
    await writeJson(reportPath, { previous: true });
    const fs = await import("node:fs/promises");
    const rename = fs.rename;
    const write = Bun.write;
    const publication = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (failure === "rename" && to === reportPath) throw new Error("Report rename failed.");
      await rename(from, to);
    });
    const writing = spyOn(Bun, "write").mockImplementation(async (...args) => {
      if (failure === "write" && typeof args[0] === "string" && args[0].startsWith(reportPath)) {
        await write(args[0], '{"partial":');
        throw new Error("Report write failed.");
      }
      return await Reflect.apply(write, Bun, args);
    });
    let report: PackageReport;
    try {
      report = await runAdapter(
        projectRoot,
        stubAdapter({
          async run(ctx) {
            await Bun.write(resolve(ctx.staging, "setup.exe"), "new installer");
            ctx.addArtifact("setup.exe", "installer", { signed: true });
          },
        }),
      );
    } finally {
      publication.mockRestore();
      writing.mockRestore();
    }
    expect(report.ok).toBe(false);
    expect(report.usable).toBe(false);
    expect(report.submittable).toBe(false);
    expect(report.signing.performed).toBe(false);
    expect(report.artifacts).toEqual([]);
    expect(
      report.diagnostics.some((d) => d.stage === "report" && d.code === CODES.STAGE_FAILED),
    ).toBe(true);
    if (previous) expect(await Bun.file(output).text()).toBe("last good installer");
    else expect(await Bun.file(output).exists()).toBe(false);
    expect(await Bun.file(reportPath).json()).toEqual({ previous: true });
    expect(
      (await readdir(packaged)).some(
        (name) => name.includes(".building-") || name.includes(".previous-"),
      ),
    ).toBe(false);
  },
);

test("an unwritable report destination preserves previous output", async () => {
  const projectRoot = await mkdtemp(join(home, "report-directory-"));
  await makeArtifact(projectRoot);
  const output = resolve(projectRoot, "dist/windows-x64/packaged/win-direct/setup.exe");
  await Bun.write(output, "last good installer");
  const reportPath = packagingReportPath(projectRoot, "windows-x64", "win-direct");
  await mkdir(reportPath);
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      async run(ctx) {
        await Bun.write(resolve(ctx.staging, "setup.exe"), "new installer");
        ctx.addArtifact("setup.exe", "installer", { signed: true });
      },
    }),
  );
  expect(report.ok).toBe(false);
  expect(report.artifacts).toEqual([]);
  expect(await Bun.file(output).text()).toBe("last good installer");
});

test("backup cleanup warnings are persisted without failing a committed package", async () => {
  const projectRoot = await mkdtemp(join(home, "backup-cleanup-"));
  await makeArtifact(projectRoot);
  const output = resolve(projectRoot, "dist/windows-x64/packaged/win-direct/setup.exe");
  await Bun.write(output, "last good installer");
  const fs = await import("node:fs/promises");
  const rm = fs.rm;
  const cleanup = spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (String(path).includes(".previous-")) throw new Error("Backup cleanup failed.");
    await rm(path, options);
  });
  let report: PackageReport;
  try {
    report = await runAdapter(
      projectRoot,
      stubAdapter({
        async run(ctx) {
          await Bun.write(resolve(ctx.staging, "setup.exe"), "new installer");
          ctx.addArtifact("setup.exe", "installer", { signed: true });
        },
      }),
    );
  } finally {
    cleanup.mockRestore();
  }
  expect(report.ok).toBe(true);
  expect(report.submittable).toBe(true);
  expect(report.diagnostics.some((d) => d.stage === "report" && d.severity === "warning")).toBe(
    true,
  );
  expect(await Bun.file(output).text()).toBe("new installer");
  expect(
    await Bun.file(packagingReportPath(projectRoot, "windows-x64", "win-direct")).json(),
  ).toEqual(report);
});

test("reported stage errors mark the stage failed and preserve the previous output", async () => {
  const projectRoot = await mkdtemp(join(home, "diagnostic-"));
  await makeArtifact(projectRoot);
  const previous = resolve(projectRoot, "dist/windows-x64/packaged/win-direct/setup.exe");
  await Bun.write(previous, "last good installer");
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      async run(ctx) {
        ctx.report({ code: CODES.TOOL_FAILED, severity: "error", message: "Assembly failed." });
      },
    }),
  );
  expect(report.ok).toBe(false);
  expect(report.stages.find((s) => s.id === "stub")?.status).toBe("failed");
  expect(report.stages.find((s) => s.id === "verify-artifact")?.status).toBe("skipped");
  expect(await Bun.file(previous).text()).toBe("last good installer");
});

test("artifacts outside staging are rejected before replacing previous output", async () => {
  for (const mode of ["previous-output", "relative-escape"]) {
    const projectRoot = await mkdtemp(join(home, "outside-"));
    await makeArtifact(projectRoot);
    const output = resolve(projectRoot, "dist/windows-x64/packaged/win-direct");
    const previous = resolve(output, "setup.exe");
    await Bun.write(previous, "last good installer");
    const report = await runAdapter(
      projectRoot,
      stubAdapter({
        async run(ctx) {
          await Bun.write(resolve(ctx.staging, "other.txt"), "new contents");
          ctx.addArtifact(
            mode === "previous-output" ? previous : "../win-direct/setup.exe",
            "installer",
            { signed: true },
          );
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.usable).toBe(false);
    expect(report.submittable).toBe(false);
    expect(report.artifacts).toEqual([]);
    expect(report.diagnostics.some((d) => d.code === CODES.VERIFY_FAILED)).toBe(true);
    expect(await Bun.file(previous).text()).toBe("last good installer");
  }
});

test("artifact directory links cannot escape staging", async () => {
  const projectRoot = await mkdtemp(join(home, "artifact-link-"));
  await makeArtifact(projectRoot);
  const external = resolve(projectRoot, "external");
  await Bun.write(resolve(external, "setup.exe"), "external installer");
  const previous = resolve(projectRoot, "dist/windows-x64/packaged/win-direct/setup.exe");
  await Bun.write(previous, "last good installer");
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      async run(ctx) {
        await symlink(external, resolve(ctx.staging, "linked"), "junction");
        ctx.addArtifact("linked/setup.exe", "installer", { signed: true });
      },
    }),
  );
  expect(report.ok).toBe(false);
  expect(report.artifacts).toEqual([]);
  expect(report.diagnostics.some((d) => d.code === CODES.VERIFY_FAILED)).toBe(true);
  expect(await Bun.file(previous).text()).toBe("last good installer");
  expect(await Bun.file(resolve(external, "setup.exe")).text()).toBe("external installer");
});

test("artifacts reached through internal directory links remain valid after publication", async () => {
  const projectRoot = await mkdtemp(join(home, "internal-link-"));
  await makeArtifact(projectRoot);
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      async run(ctx) {
        const payload = resolve(ctx.staging, "payload");
        await Bun.write(resolve(payload, "setup.exe"), "installer");
        await symlink(payload, resolve(ctx.staging, "linked"), "junction");
        ctx.addArtifact("linked/setup.exe", "installer");
      },
    }),
  );
  expect(report.ok).toBe(true);
  expect(report.artifacts[0]?.path).toBe(
    resolve(projectRoot, "dist/windows-x64/packaged/win-direct/payload/setup.exe"),
  );
  expect(await Bun.file(report.artifacts[0]?.path ?? "").text()).toBe("installer");
  expect(report.artifacts[0]?.sha256).toBe(await sha256(report.artifacts[0]?.path ?? ""));
});

test.each(
  (["windows-x64", "macos-arm64"] as const).flatMap((target) =>
    (["version", "sourceRevision"] as const).flatMap((field) =>
      [undefined, null, "", "   ", 123].map((value) => ({ target, field, value })),
    ),
  ),
)(
  "Bun identity $field rejects $value on $target before adapters run",
  async ({ target, field, value }) => {
    const projectRoot = await mkdtemp(join(home, "runtime-identity-"));
    const manifest = await makeArtifact(projectRoot, target);
    const artifact = artifactPaths({ root: projectRoot, target, appId: "app.test" });
    const invalid = { ...manifest, bun: { ...manifest.bun, [field]: value } };
    await writeJson(resolve(artifact.packageDir, "manifest.json"), invalid);
    await expect(loadManifest(artifact)).rejects.toThrow("Package manifest");
    expect(
      (
        await verifyArtifact({
          artifact,
          manifest: invalid as PackageManifest,
          channel: target === "windows-x64" ? "win-direct" : "mac-direct",
        })
      ).some((d) => d.code === CODES.INPUT_MISSING),
    ).toBe(true);
    await expectRejectedInputs(projectRoot, CODES.INPUT_MISSING, { target });
  },
);

test.each(
  (["windows-x64", "macos-arm64"] as const).flatMap((target) =>
    (["manifest", "file", "both", "tampered", "directory"] as const).map((mode) => ({
      target,
      mode,
    })),
  ),
)("initial home document rejects $mode on $target", async ({ target, mode }) => {
  const projectRoot = await mkdtemp(join(home, "home-document-"));
  const manifest = await makeArtifact(projectRoot, target);
  const artifact = artifactPaths({ root: projectRoot, target, appId: "app.test" });
  const path = "assets/web/index.html";
  const file = resolve(artifact.packageDir, path);
  if (mode === "manifest" || mode === "both") delete manifest.assets[path];
  if (mode === "file" || mode === "both" || mode === "directory") await rm(file);
  if (mode === "directory") await mkdir(file);
  if (mode === "tampered") await writeFile(file, "modified home");
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  await expectRejectedInputs(
    projectRoot,
    mode === "tampered" ? CODES.INPUT_TAMPERED : CODES.INPUT_MISSING,
    { target },
  );
});

test.each(
  (["windows-x64", "macos-arm64"] as const).flatMap((target) =>
    [
      { url: "https://app.bunaway.local/", asset: "assets/web/index.html" },
      { url: "https://app.bunaway.local/index.html?theme=dark", asset: "assets/web/index.html" },
      {
        url: "https://app.bunaway.local/pages/welcome%20page.html?theme=dark",
        asset: "assets/web/pages/welcome page.html",
      },
    ].map((entry) => ({ target, ...entry })),
  ),
)("home URL $url resolves its manifest asset on $target", async ({ target, url, asset }) => {
  const projectRoot = await mkdtemp(join(home, "home-url-"));
  const manifest = await makeArtifact(projectRoot, target);
  const artifact = artifactPaths({ root: projectRoot, target, appId: "app.test" });
  const appPath = resolve(artifact.packageDir, "assets/app.json");
  await writeJson(appPath, { ...appConfig, home: url });
  manifest.assets["assets/app.json"] = await sha256(appPath);
  if (asset !== "assets/web/index.html") {
    await rm(resolve(artifact.packageDir, "assets/web/index.html"));
    delete manifest.assets["assets/web/index.html"];
    await Bun.write(resolve(artifact.packageDir, asset), "home document");
    manifest.assets[asset] = await sha256(resolve(artifact.packageDir, asset));
  }
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      channel: target === "windows-x64" ? "win-direct" : "mac-direct",
      async run(ctx) {
        await Bun.write(resolve(ctx.staging, "setup.exe"), "installer");
        ctx.addArtifact("setup.exe", "installer");
      },
    }),
    { target },
  );
  expect(report.ok).toBe(true);
  expect(report.usable).toBe(true);
});

test.each([
  { value: undefined, code: CODES.INPUT_MISSING },
  { value: null, code: CODES.INPUT_MISSING },
  { value: 123, code: CODES.INPUT_MISSING },
  { value: "", code: CODES.INPUT_MISSING },
  { value: "not-a-url", code: CODES.INPUT_UNEXPECTED },
  { value: "https://example.com/index.html", code: CODES.INPUT_UNEXPECTED },
  { value: "https://user@app.bunaway.local/index.html", code: CODES.INPUT_UNEXPECTED },
  { value: "https://app.bunaway.local/index.html#fragment", code: CODES.INPUT_UNEXPECTED },
  { value: "https://app.bunaway.local/%ZZ", code: CODES.INPUT_UNEXPECTED },
  { value: "https://app.bunaway.local/..%2fbackend.js", code: CODES.INPUT_UNEXPECTED },
  { value: "https://app.bunaway.local/..%5cbackend.js", code: CODES.INPUT_UNEXPECTED },
  { value: "https://app.bunaway.local/%00.html", code: CODES.INPUT_UNEXPECTED },
])("invalid built home URL $value fails before adapters run", async ({ value, code }) => {
  const projectRoot = await mkdtemp(join(home, "invalid-home-"));
  const manifest = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  const appPath = resolve(artifact.packageDir, "assets/app.json");
  await writeJson(appPath, { ...appConfig, home: value });
  manifest.assets["assets/app.json"] = await sha256(appPath);
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  await expectRejectedInputs(projectRoot, code);
});

test.each(["package", "web"] as const)(
  "home directory links cannot escape the %s root",
  async (boundary) => {
    const projectRoot = await mkdtemp(join(home, "home-link-"));
    const manifest = await makeArtifact(projectRoot);
    const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
    const destination = resolve(
      boundary === "package" ? projectRoot : artifact.packageDir,
      "outside-web",
    );
    await Bun.write(resolve(destination, "index.html"), "outside home");
    await symlink(destination, resolve(artifact.packageDir, "assets/web/linked"), "junction");
    const appPath = resolve(artifact.packageDir, "assets/app.json");
    await writeJson(appPath, { ...appConfig, home: "https://app.bunaway.local/linked/index.html" });
    manifest.assets["assets/app.json"] = await sha256(appPath);
    manifest.assets["assets/web/linked/index.html"] = await sha256(
      resolve(destination, "index.html"),
    );
    await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
    await expectRejectedInputs(projectRoot, CODES.INPUT_UNEXPECTED);
  },
);

test("invalid Bun digests fail closed even when the runtime has been changed", async () => {
  const projectRoot = await mkdtemp(join(home, "digest-"));
  const original = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  await writeFile(resolve(artifact.packageDir, "runtime/bun.exe"), "changed runtime");
  for (const key of ["executableSha256", "packagedSha256", "sha256", "sourceSha256"]) {
    for (const invalid of ["", "not-a-digest", "a".repeat(63), "g".repeat(64), null, 123]) {
      const manifest = { ...original, bun: { ...original.bun, [key]: invalid } };
      await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
      await expect(loadManifest(artifact)).rejects.toThrow("Package manifest");
    }
  }
  const malformed = { ...original, bun: { ...original.bun, packagedSha256: "" } };
  expect(
    (await verifyArtifact({ artifact, manifest: malformed, channel: "win-direct" })).some(
      (d) => d.code === CODES.INPUT_MISSING && d.severity === "error",
    ),
  ).toBe(true);
  await writeJson(resolve(artifact.packageDir, "manifest.json"), malformed);
  let ran = false;
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      run: async () => {
        ran = true;
      },
    }),
  );
  expect(report.ok).toBe(false);
  expect(ran).toBe(false);
});

test.each([
  { target: "windows-x64", alias: "sha256" },
  { target: "windows-x64", alias: "sourceSha256" },
  { target: "macos-arm64", alias: "sha256" },
  { target: "macos-arm64", alias: "sourceSha256" },
] as const)("Bun ignores $alias as a final digest on $target", async ({ target, alias }) => {
  const projectRoot = await mkdtemp(join(home, "bun-fallback-"));
  const manifest = await makeArtifact(projectRoot, target);
  const artifact = artifactPaths({ root: projectRoot, target, appId: "app.test" });
  const runtime = resolve(
    artifact.packageDir,
    target === "windows-x64" ? "runtime/bun.exe" : "runtime/bun",
  );
  const channel = target === "windows-x64" ? "win-direct" : "mac-direct";
  await Bun.write(runtime, "re-signed runtime bytes");
  const finalDigest = await sha256(runtime);
  manifest.bun[alias] = finalDigest;
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  const report = await expectRejectedInputs(projectRoot, CODES.INPUT_TAMPERED, { target });
  expect(
    report.diagnostics.some((d) => d.code === CODES.INPUT_TAMPERED && d.path === runtime),
  ).toBe(true);

  manifest.bun.packagedSha256 = finalDigest;
  expect(await verifyArtifact({ artifact, manifest, channel })).toEqual([]);
  manifest.bun.packagedSha256 = manifest.bun.executableSha256;
  expect(
    (await verifyArtifact({ artifact, manifest, channel })).some(
      (d) => d.code === CODES.INPUT_TAMPERED && d.path === runtime,
    ),
  ).toBe(true);
});

test.each([
  "assets/app.json",
  "assets/policy.json",
  "assets/backend.js",
  "assets/bunfig.toml",
  "assets/tsconfig.json",
  "licenses/LICENSE.bun",
  "licenses/LICENSE.nlohmann-json",
  "licenses/License-WebView2.txt",
])("required build input %s cannot be omitted from the manifest", async (path) => {
  const projectRoot = await mkdtemp(join(home, "missing-required-"));
  const manifest = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  delete manifest.assets[path];
  await rm(resolve(artifact.packageDir, path));
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  const report = await expectRejectedInputs(projectRoot, CODES.INPUT_MISSING);
  expect(report.diagnostics.some((d) => d.path === resolve(artifact.packageDir, path))).toBe(true);
});

test.each(
  (["windows-x64", "macos-arm64"] as const).flatMap((target) =>
    runtimeAssets.flatMap((path) =>
      (["manifest", "file", "both", "tampered"] as const).map((mode) => ({
        target,
        path,
        mode,
      })),
    ),
  ),
)("required runtime input $path rejects $mode on $target", async ({ target, path, mode }) => {
  const projectRoot = await mkdtemp(join(home, "runtime-input-"));
  const manifest = await makeArtifact(projectRoot, target);
  const artifact = artifactPaths({ root: projectRoot, target, appId: "app.test" });
  const asset = resolve(artifact.packageDir, path);
  if (mode === "manifest" || mode === "both") delete manifest.assets[path];
  if (mode === "file" || mode === "both") await rm(asset);
  if (mode === "tampered") await writeFile(asset, "changed runtime asset");
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  const code = mode === "tampered" ? CODES.INPUT_TAMPERED : CODES.INPUT_MISSING;
  const report = await expectRejectedInputs(projectRoot, code, { target });
  expect(
    report.diagnostics.some((d) => d.stage === "verify" && d.code === code && d.path === asset),
  ).toBe(true);
});

test("empty assets with no app or licenses are rejected before adapters run", async () => {
  const projectRoot = await mkdtemp(join(home, "empty-assets-"));
  const manifest = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  manifest.assets = {};
  await rm(resolve(artifact.packageDir, "assets"), { recursive: true });
  await rm(resolve(artifact.packageDir, "licenses"), { recursive: true });
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  await expectRejectedInputs(projectRoot, CODES.INPUT_MISSING);
});

test.each(
  [[], null, "assets", 1, true, { "assets/app.json": 1 }, { "assets/app.json": "bad" }].map(
    (assets) => ({ assets }),
  ),
)("malformed manifest assets %j fail closed", async ({ assets }) => {
  const projectRoot = await mkdtemp(join(home, "invalid-assets-"));
  const manifest = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  const invalid = { ...manifest, assets };
  await writeJson(resolve(artifact.packageDir, "manifest.json"), invalid);
  await expect(loadManifest(artifact)).rejects.toThrow();
  expect(
    (
      await verifyArtifact({
        artifact,
        manifest: invalid as PackageManifest,
        channel: "win-direct",
      })
    ).some((d) => d.code === CODES.INPUT_MISSING),
  ).toBe(true);
  await expectRejectedInputs(projectRoot, CODES.INPUT_MISSING);
});

test.each([
  "../outside.txt",
  "assets/../../outside.txt",
  "/outside.txt",
  "C:/outside.txt",
  "C:outside.txt",
  "\\\\server\\share\\outside.txt",
  "assets\\..\\outside.txt",
])("manifest asset path %s cannot escape the package", async (path) => {
  const projectRoot = await mkdtemp(join(home, "asset-path-"));
  const manifest = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  manifest.assets[path] = manifest.bun.executableSha256;
  await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
  await expectRejectedInputs(projectRoot, CODES.INPUT_UNEXPECTED);
});

test.each(["runtime", "assets", "licenses"])(
  "input directory %s cannot link outside the package",
  async (directory) => {
    const projectRoot = await mkdtemp(join(home, "input-link-"));
    await makeArtifact(projectRoot);
    const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
    const path = resolve(artifact.packageDir, directory);
    const external = resolve(projectRoot, "external-input");
    await rename(path, external);
    await symlink(external, path, "junction");
    const report = await expectRejectedInputs(projectRoot, CODES.INPUT_UNEXPECTED);
    expect(report.diagnostics.some((d) => d.path?.startsWith(path))).toBe(true);
  },
);

test.each(["Contents/MacOS", "Contents/Resources"])(
  "macOS input directory %s cannot link outside the app bundle",
  async (directory) => {
    const projectRoot = await mkdtemp(join(home, "mac-input-link-"));
    await makeArtifact(projectRoot, "macos-arm64");
    const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
    const path = resolve(artifact.dir, directory);
    const external = resolve(projectRoot, "external-input");
    await rename(path, external);
    await symlink(external, path, "junction");
    await expectRejectedInputs(projectRoot, CODES.INPUT_UNEXPECTED, { target: "macos-arm64" });
  },
);

test.each(["missing", "directory", "symlink"] as const)(
  "macOS Info.plist must be a regular bundle input (%s)",
  async (kind) => {
    const projectRoot = await mkdtemp(join(home, "plist-input-"));
    const manifest = await makeArtifact(projectRoot, "macos-arm64");
    const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
    const plist = resolve(artifact.dir, "Contents/Info.plist");
    const outside = resolve(projectRoot, "outside.plist");
    await rename(plist, outside);
    if (kind === "directory") await mkdir(plist);
    if (kind === "symlink") await symlink(outside, plist);
    const diagnostics = await verifyArtifact({ artifact, manifest, channel: "mac-direct" });
    expect(diagnostics.some((d) => d.path === plist && d.code === CODES.INPUT_MISSING)).toBe(true);
    await expectRejectedInputs(projectRoot, CODES.INPUT_MISSING, { target: "macos-arm64" });
  },
);

test.each([
  { name: "malformed XML", dict: "<key>CFBundleExecutable</key><string>bunaway-host" },
  { name: "missing executable", dict: "" },
  { name: "wrong executable", dict: "<key>CFBundleExecutable</key><string>other-host</string>" },
  {
    name: "escaping executable",
    dict: "<key>CFBundleExecutable</key><string>../Resources/assets/backend.js</string>",
  },
  {
    name: "non-string executable",
    dict: "<key>CFBundleExecutable</key><array><string>bunaway-host</string></array>",
  },
  {
    name: "nested executable",
    dict: "<key>Nested</key><dict><key>CFBundleExecutable</key><string>bunaway-host</string></dict>",
  },
  {
    name: "duplicate executable",
    dict: "<key>CFBundleExecutable</key><string>other-host</string><key>CFBundleExecutable</key><string>bunaway-host</string>",
  },
  {
    name: "wrong identifier",
    dict: "<key>CFBundleExecutable</key><string>bunaway-host</string>",
    identifier: "other.app",
  },
  {
    name: "wrong package type",
    dict: "<key>CFBundleExecutable</key><string>bunaway-host</string>",
    packageType: "BNDL",
  },
  { name: "missing value", dict: "<key>CFBundleExecutable</key>" },
])(
  "macOS Info.plist rejects $name before adapter execution",
  async ({ dict, identifier, packageType }) => {
    const projectRoot = await mkdtemp(join(home, "plist-metadata-"));
    await makeArtifact(projectRoot, "macos-arm64");
    const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
    await writeFile(
      resolve(artifact.dir, "Contents/Info.plist"),
      `<plist version="1.0"><dict>${dict}
<key>CFBundleIdentifier</key><string>${identifier ?? "app.test"}</string>
<key>CFBundlePackageType</key><string>${packageType ?? "APPL"}</string></dict></plist>`,
    );
    await expectRejectedInputs(projectRoot, CODES.INPUT_TAMPERED, { target: "macos-arm64" });
  },
);

test.each(["<dict/>", "<plist><array/></plist>", "<plist><dict/></plist><plist><dict/></plist>"])(
  "macOS Info.plist rejects a non-bundle root: %s",
  async (xml) => {
    const projectRoot = await mkdtemp(join(home, "plist-root-"));
    await makeArtifact(projectRoot, "macos-arm64");
    const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
    await writeFile(resolve(artifact.dir, "Contents/Info.plist"), xml);
    await expectRejectedInputs(projectRoot, CODES.INPUT_TAMPERED, { target: "macos-arm64" });
  },
);

test("macOS Info.plist accepts XML entities and unrelated bundle metadata", async () => {
  const projectRoot = await mkdtemp(join(home, "plist-valid-"));
  const manifest = await makeArtifact(projectRoot, "macos-arm64");
  const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
  await writeFile(
    resolve(artifact.dir, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict>
<!-- Key order and unrelated metadata do not change bundle identity. -->
<key>CFBundleName</key><string>Test &amp; App</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIdentifier</key><string>app&#x2e;test</string>
<key>CFBundleExecutable</key><string>bunaway-host</string>
<key>LSUIElement</key><true/>
<key>Extra</key><dict><key>values</key><array>
<string/><string>  padded text  </string><string>&amp;nbsp;</string>
<string><![CDATA[a & b]]></string><integer>-42</integer><integer>0x2a</integer>
<real>1.5e-2</real><date>2026-10-05T23:13:00Z</date><data>YQ==</data>
<false/><array/><dict/></array></dict></dict></plist>`,
  );
  expect(await verifyArtifact({ artifact, manifest, channel: "mac-direct" })).toEqual([]);
});

test.each([
  ["HTML entity", "<string>Test&nbsp;App</string>"],
  ["invalid character reference", "<string>&#0;</string>"],
  ["invalid integer", "<integer>not-an-integer</integer>"],
  ["empty integer", "<integer/>"],
  ["invalid boolean", "<true>oops</true>"],
  ["nested boolean content", "<false><string/></false>"],
  ["orphan nested key", "<dict><key>orphan</key></dict>"],
  ["duplicate nested key", "<dict><key>a</key><string/><key>a</key><string/></dict>"],
  ["unknown array value", "<array><unknown/></array>"],
  ["nested integer", "<array><dict><key>n</key><integer>1oops</integer></dict></array>"],
  ["nested string markup", "<string><string>text</string></string>"],
  ["invalid real", "<real>not-a-real</real>"],
  ["invalid date", "<date>not-a-date</date>"],
  ["invalid data", "<data>!not-base64!</data>"],
])("macOS Info.plist rejects %s in unrelated metadata", async (_name, value) => {
  const projectRoot = await mkdtemp(join(home, "plist-values-"));
  await makeArtifact(projectRoot, "macos-arm64");
  const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
  const path = resolve(artifact.dir, "Contents/Info.plist");
  const valid = await Bun.file(path).text();
  const invalid = valid.replace("</dict>", `<key>Extra</key>${value}</dict>`);
  await writeFile(path, invalid);
  await expectRejectedInputs(projectRoot, CODES.INPUT_TAMPERED, { target: "macos-arm64" });
});

test.skipIf(process.platform !== "darwin")(
  "macOS also validates plist with Apple's parser",
  async () => {
    const projectRoot = await mkdtemp(join(home, "plist-native-"));
    await makeArtifact(projectRoot, "macos-arm64");
    const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
    const path = resolve(artifact.dir, "Contents/Info.plist");
    await writeFile(
      path,
      (await Bun.file(path).text()).replace("</dict>", "<key>Extra</key><data/></dict>"),
    );
    const manifest = await loadManifest(artifact);
    const diagnostics = await verifyArtifact({ artifact, manifest, channel: "mac-direct" });
    expect(diagnostics.some((d) => d.message.includes("Invalid Apple plist"))).toBe(true);
    await expectRejectedInputs(projectRoot, CODES.INPUT_TAMPERED, { target: "macos-arm64" });
  },
);

test.each([false, true])(
  "macOS Info.plist requires Contents to remain inside the bundle (external=%s)",
  async (external) => {
    const projectRoot = await mkdtemp(join(home, "plist-contents-link-"));
    const manifest = await makeArtifact(projectRoot, "macos-arm64");
    const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
    const contents = resolve(artifact.dir, "Contents");
    const destination = external
      ? resolve(projectRoot, "external-contents")
      : resolve(artifact.dir, "original-contents");
    await rename(contents, destination);
    await symlink(destination, contents, "junction");
    if (external) {
      await expectRejectedInputs(projectRoot, CODES.INPUT_UNEXPECTED, { target: "macos-arm64" });
    } else {
      expect(await verifyArtifact({ artifact, manifest, channel: "mac-direct" })).toEqual([]);
    }
  },
);

test("input directory links inside the package remain valid", async () => {
  const projectRoot = await mkdtemp(join(home, "internal-input-link-"));
  const manifest = await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  const runtime = resolve(artifact.packageDir, "runtime");
  const internal = resolve(artifact.packageDir, "original-runtime");
  await rename(runtime, internal);
  await symlink(internal, runtime, "junction");
  expect(await verifyArtifact({ artifact, manifest, channel: "win-direct" })).toEqual([]);
});

test("macOS inputs with a final host digest do not require WebView2", async () => {
  const projectRoot = await mkdtemp(join(home, "mac-inputs-"));
  const manifest = await makeArtifact(projectRoot, "macos-arm64");
  const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
  expect(await loadManifest(artifact)).toEqual(manifest);
  expect(await verifyArtifact({ artifact, manifest, channel: "mac-direct" })).toEqual([]);
  const report = await runAdapter(
    projectRoot,
    stubAdapter({
      channel: "mac-direct",
      run: async (ctx) => {
        await Bun.write(resolve(ctx.staging, "app.zip"), "package");
        ctx.addArtifact("app.zip", "archive");
      },
    }),
    { target: "macos-arm64" },
  );
  expect(report.ok).toBe(true);
});

for (const channel of ["mac-direct", "mac-store"] as const) {
  for (const executable of ["host", "bun"] as const) {
    test.skipIf(process.platform === "win32")(
      `${channel} rejects non-executable ${executable} with a valid final digest`,
      async () => {
        const projectRoot = await mkdtemp(join(home, "mac-executable-"));
        const manifest = await makeArtifact(projectRoot, "macos-arm64");
        const artifact = artifactPaths({
          root: projectRoot,
          target: "macos-arm64",
          appId: "app.test",
        });
        const path =
          executable === "host" ? artifact.executable : resolve(artifact.packageDir, "runtime/bun");
        const digest = await sha256(path);
        await chmod(path, 0o555);
        expect(await verifyArtifact({ artifact, manifest, channel })).toEqual([]);
        await chmod(path, 0o644);
        expect(await sha256(path)).toBe(digest);
        expect(await verifyArtifact({ artifact, manifest, channel })).toEqual([
          expect.objectContaining({
            stage: "verify",
            code: CODES.INPUT_TAMPERED,
            severity: "error",
            message: expect.stringContaining("not executable"),
            path,
          }),
        ]);
        let resolved = false;
        const report = await runAdapter(
          projectRoot,
          stubAdapter({
            channel,
            stages: () => {
              resolved = true;
              return [];
            },
          }),
          { target: "macos-arm64" },
        );
        expect(report.ok).toBe(false);
        expect(report.usable).toBe(false);
        expect(report.submittable).toBe(false);
        expect(report.stages.find((s) => s.id === "verify")?.status).toBe("failed");
        expect(resolved).toBe(false);
      },
    );
  }
  test.skipIf(process.platform !== "darwin")(
    `${channel} accepts an ad-hoc signed bundle with only host provenance`,
    async () => {
      const projectRoot = await mkdtemp(join(home, "mac-signed-"));
      const { artifact, manifest } = await makeSignedMacArtifact(projectRoot);
      expect(manifest.host?.sourceSha256).not.toBe(await sha256(artifact.executable));
      expect(await verifyArtifact({ artifact, manifest, channel })).toEqual([]);
      const report = await runAdapter(
        projectRoot,
        stubAdapter({
          channel,
          run: async (ctx) => {
            await Bun.write(resolve(ctx.staging, "app.zip"), "package");
            ctx.addArtifact("app.zip", "archive");
          },
        }),
        { target: "macos-arm64" },
      );
      expect(report.ok).toBe(true);
      expect(report.usable).toBe(true);
      expect(report.submittable).toBe(false);
    },
  );
  for (const change of [
    "host",
    "plist",
    "resources",
    "signature",
    "host-mode",
    "bun-mode",
  ] as const) {
    test.skipIf(process.platform !== "darwin")(
      `${channel} rejects signed bundle ${change} tampering before adapter execution`,
      async () => {
        const projectRoot = await mkdtemp(join(home, "mac-tampered-"));
        const { artifact, manifest } = await makeSignedMacArtifact(projectRoot);
        expect(await verifyArtifact({ artifact, manifest, channel })).toEqual([]);
        if (change === "host") {
          const bytes = await Bun.file(artifact.executable).bytes();
          bytes[4096] = (bytes[4096] ?? 0) ^ 1;
          await writeFile(artifact.executable, bytes);
        } else if (change === "plist") {
          const plist = resolve(artifact.dir, "Contents/Info.plist");
          await writeFile(
            plist,
            (await Bun.file(plist).text()).replace(
              "</dict>",
              "<key>CFBundleName</key><string>Changed name</string></dict>",
            ),
          );
        } else if (change === "resources") {
          const asset = "assets/backend.js";
          await writeFile(resolve(artifact.packageDir, asset), "changed backend");
          manifest.assets[asset] = await sha256(resolve(artifact.packageDir, asset));
          await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
        } else if (change === "signature") {
          await rm(resolve(artifact.dir, "Contents/_CodeSignature"), { recursive: true });
        } else {
          const path =
            change === "host-mode"
              ? artifact.executable
              : resolve(artifact.packageDir, "runtime/bun");
          const digest = await sha256(path);
          await chmod(path, 0o644);
          expect(await sha256(path)).toBe(digest);
          const validation = Bun.spawn(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", artifact.dir],
            { stdout: "pipe", stderr: "pipe" },
          );
          const [exit, stderr] = await Promise.all([
            validation.exited,
            new Response(validation.stderr).text(),
          ]);
          expect(exit, stderr).toBe(0);
        }
        const previous = resolve(projectRoot, `dist/macos-arm64/packaged/${channel}/app.zip`);
        await Bun.write(previous, "previous package");
        let ran = false;
        const report = await runAdapter(
          projectRoot,
          stubAdapter({
            channel,
            run: async () => {
              ran = true;
            },
          }),
          { target: "macos-arm64" },
        );
        expect(report.diagnostics).toContainEqual(
          expect.objectContaining({ stage: "verify", code: CODES.INPUT_TAMPERED }),
        );
        expect(report.ok).toBe(false);
        expect(report.usable).toBe(false);
        expect(ran).toBe(false);
        expect(await Bun.file(previous).text()).toBe("previous package");
      },
    );
  }
}

test.skipIf(process.platform !== "darwin")(
  "macOS signature verification fails closed if codesign cannot run",
  async () => {
    const projectRoot = await mkdtemp(join(home, "mac-codesign-unavailable-"));
    const { artifact, manifest } = await makeSignedMacArtifact(projectRoot);
    const spawn = Bun.spawn;
    const unavailable = spyOn(Bun, "spawn").mockImplementation((...args) => {
      if (Array.isArray(args[0]) && args[0][0] === "/usr/bin/codesign") {
        throw new Error("codesign unavailable");
      }
      return Reflect.apply(spawn, Bun, args);
    });
    try {
      const diagnostics = await verifyArtifact({ artifact, manifest, channel: "mac-direct" });
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: CODES.INPUT_TAMPERED,
          message: expect.stringContaining("codesign unavailable"),
        }),
      );
    } finally {
      unavailable.mockRestore();
    }
  },
);

test.skipIf(process.platform === "darwin")(
  "macOS provenance alone cannot skip integrity verification on another OS",
  async () => {
    const projectRoot = await mkdtemp(join(home, "mac-provenance-"));
    const manifest = await makeArtifact(projectRoot, "macos-arm64");
    const artifact = artifactPaths({ root: projectRoot, target: "macos-arm64", appId: "app.test" });
    manifest.host = { target: "macos-arm64", sourceSha256: await sha256(artifact.executable) };
    await writeJson(resolve(artifact.packageDir, "manifest.json"), manifest);
    await expectRejectedInputs(projectRoot, CODES.INPUT_MISSING, { target: "macos-arm64" });
  },
);

test("a manifest outside the artifact is rejected before it is read", async () => {
  const projectRoot = await mkdtemp(join(home, "outside-manifest-"));
  await makeArtifact(projectRoot);
  const artifact = artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" });
  artifact.packageDir = resolve(projectRoot, "external");
  await expectRejectedInputs(projectRoot, CODES.INPUT_UNEXPECTED, { artifact });
});

test("icon directory links cannot resolve outside the project", async () => {
  const projectRoot = await mkdtemp(join(home, "icons-"));
  const external = resolve(home, "external-icons");
  await Bun.write(resolve(external, "logo.ico"), "external icon");
  await symlink(external, resolve(projectRoot, "icons"), "junction");
  const config = parsePackaging(
    JSON.stringify({
      version: 1,
      channels: { "win-direct": {} },
      icons: { directory: "icons", windows: { installer: "logo.ico" } },
    }),
  );
  await expect(
    resolvePackaging({ root: projectRoot, config, channel: "win-direct", ...resolveArgs }),
  ).rejects.toThrow("icon path escapes the project");
  await rm(resolve(projectRoot, "icons"));
  await Bun.write(resolve(projectRoot, "icons/logo.ico"), "project icon");
  const { metadata } = await resolvePackaging({
    root: projectRoot,
    config,
    channel: "win-direct",
    ...resolveArgs,
  });
  expect(metadata.icons["windows.installer"]).toBe(
    await realpath(resolve(projectRoot, "icons/logo.ico")),
  );
});
