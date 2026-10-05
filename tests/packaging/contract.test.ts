import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  artifactPaths,
  CODES,
  isChannelId,
  loadPackaging,
  packagedDigest,
  type PackageAdapter,
  type PackageManifest,
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
async function makeArtifact(): Promise<PackageManifest> {
  const dir = resolve(root, "dist/windows-x64");
  artifactDir = dir;
  await mkdir(resolve(dir, "assets"), { recursive: true });
  await mkdir(resolve(dir, "runtime"), { recursive: true });
  await mkdir(resolve(dir, "licenses"), { recursive: true });
  await writeFile(resolve(dir, "bunaway-host.exe"), "fake host");
  await writeFile(resolve(dir, "runtime/bun.exe"), "fake bun");
  await writeFile(resolve(dir, "assets/app.json"), "{}");
  await writeFile(resolve(dir, "licenses/LICENSE.bun"), "license");
  const manifest: PackageManifest = {
    bun: {
      version: "1.4.2",
      target: "windows-x64-baseline",
      executableSha256: await sha256(resolve(dir, "runtime/bun.exe")),
      licenseSha256: "x",
    },
    assets: {
      "assets/app.json": await sha256(resolve(dir, "assets/app.json")),
      "licenses/LICENSE.bun": await sha256(resolve(dir, "licenses/LICENSE.bun")),
    },
    app: { id: "app.test", version: "0.1.0" },
    host: { target: "windows-x64", sha256: await sha256(resolve(dir, "bunaway-host.exe")) },
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
  await writeFile(resolve(artifactDir, "assets/app.json"), "tampered");
  let diagnostics = await verifyArtifact({ artifact, manifest, channel: "win-direct" });
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
