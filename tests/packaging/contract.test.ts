import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
  await writeFile(runtime, "fake bun");
  const assets: Record<string, string> = {};
  for (const path of [
    "assets/app.json",
    "assets/policy.json",
    "assets/backend.js",
    "assets/bunfig.toml",
    "assets/tsconfig.json",
    ...runtimeAssets,
    "licenses/LICENSE.bun",
    "licenses/LICENSE.nlohmann-json",
    ...(windows ? ["licenses/License-WebView2.txt"] : []),
  ]) {
    await writeFile(resolve(dir, path), "{}");
    assets[path] = await sha256(resolve(dir, path));
  }
  const manifest: PackageManifest = {
    bun: {
      version: "1.4.2",
      target: windows ? "windows-x64-baseline" : "darwin-aarch64",
      executableSha256: await sha256(runtime),
      licenseSha256: assets["licenses/LICENSE.bun"] ?? "",
    },
    assets,
    app: { id: "app.test", version: "0.1.0" },
    host: {
      target,
      ...(windows
        ? { sha256: await sha256(artifact.executable) }
        : { sourceSha256: await sha256(artifact.executable) }),
    },
  };
  await writeJson(resolve(dir, "manifest.json"), manifest);
  return manifest;
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
  await writeFile(resolve(artifactDir, "assets/app.json"), "{}");
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

test("macOS inputs stay inside the bundle without requiring WebView2 or a pre-sign host digest", async () => {
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
