import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  artifactPaths,
  CODES,
  isChannelId,
  loadPackaging,
  loadManifest,
  packagedDigest,
  type PackageAdapter,
  type PackageManifest,
  type PackageReport,
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
async function makeArtifact(projectRoot = root): Promise<PackageManifest> {
  const dir = resolve(projectRoot, "dist/windows-x64");
  if (projectRoot === root) artifactDir = dir;
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

function runAdapter(projectRoot: string, adapter: PackageAdapter) {
  return runPackage({
    metadata: {
      root: projectRoot,
      name: "Test App",
      identifier: "app.test",
      publisher: { display: "Test" },
      version: { semver: "0.1.0", build: 0, msix: "0.1.0.0" },
      icons: {},
      targets: [{ platform: "windows", arch: "x64" }],
    },
    appId: "app.test",
    channel: adapter.channel,
    channelConfig: {},
    target: "windows-x64",
    artifact: artifactPaths({ root: projectRoot, target: "windows-x64", appId: "app.test" }),
    adapter,
  });
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
