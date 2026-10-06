import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyPayload, findIscc } from "../../packages/packaging/src/channels/windows/common.ts";
import {
  compileInno,
  prepareInnoSigning,
  renderInnoScript,
} from "../../packages/packaging/src/channels/windows/inno.ts";
import { renderAppxManifest } from "../../packages/packaging/src/channels/windows/msix.ts";
import { signingArgs } from "../../packages/packaging/src/channels/windows/sign.ts";
import {
  type AdapterInput,
  type AdapterStage,
  adapterFor,
  parsePackaging,
  type ResolvedPackaging,
  registeredChannels,
  type SigningConfig,
  type StageContext,
} from "../../packages/packaging/src/index.ts";

const metadata: ResolvedPackaging = {
  root: "C:\\proj",
  name: "Test App",
  identifier: "com.example.app",
  publisher: { display: "Example", identity: "CN=Example" },
  version: { semver: "1.2.3", build: 0, msix: "1.2.3.0" },
  icons: {},
  targets: [{ platform: "windows", arch: "x64" }],
};

const input = (channelConfig: Record<string, unknown>, signing?: SigningConfig): AdapterInput => ({
  channel: "win-direct",
  channelConfig,
  metadata,
  target: "windows-x64",
  artifact: {
    dir: "C:\\proj\\dist\\windows-x64",
    packageDir: "C:\\proj\\dist\\windows-x64",
    executable: "C:\\proj\\dist\\windows-x64\\bunaway-host.exe",
  },
  manifest: {
    bun: {
      version: "1.4.2",
      sourceRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
      target: "windows-x64-baseline",
      executableSha256: "aa",
      licenseSha256: "bb",
    },
    assets: {},
    app: { id: "com.example.app", version: "1.2.3" },
  },
  ...(signing ? { signing } : {}),
});

const runIds = (stages: AdapterStage[]) => stages.map((stage) => stage.id);

const adapterOrThrow = (channel: string) => {
  const adapter = adapterFor(channel as never);
  if (!adapter) throw new Error(`${channel} adapter missing`);
  return adapter;
};

const iscc = process.platform === "win32" ? await findIscc() : undefined;

test.skipIf(!iscc)(
  "Inno compiles literal display names and the WebView2 version check",
  async () => {
    const root = join(
      await realpath(await mkdtemp(join(tmpdir(), "bunaway-inno-compile-"))),
      "{demo}",
    );
    try {
      await Bun.write(join(root, "app", "bunaway-host.exe"), "host fixture");
      await Bun.write(join(root, "bootstrapper.exe"), "bootstrapper fixture");
      await mkdir(join(root, "installer"));
      const ctx: StageContext = {
        input: input({}),
        staging: root,
        report() {},
        addArtifact() {},
      };
      const script = renderInnoScript({
        name: 'My "App" {Beta}',
        identifier: metadata.identifier,
        version: metadata.version.semver,
        publisher: 'Example {Company} "Ltd"',
        scope: "perUser",
        payloadDir: join(root, "app"),
        outputDir: join(root, "installer"),
        outputBaseName: "setup",
        desktopShortcut: true,
        startMenuShortcut: true,
        webView2: "bootstrap",
        bootstrapperPath: join(root, "bootstrapper.exe"),
        appDataDir: "{localappdata}\\bunaway\\test.app",
        preserveUserData: true,
      });
      const installer = await compileInno(ctx, script, root, "setup");
      expect(await Bun.file(installer).exists()).toBe(true);
      expect(Bun.file(installer).size).toBeGreaterThan(0);
    } finally {
      await rm(resolve(root, ".."), { recursive: true, force: true });
    }
  },
  30000,
);

test("Windows adapters register all three channels", () => {
  expect(registeredChannels()).toEqual(["win-direct", "win-store-msix", "win-store-unpackaged"]);
  expect(adapterFor("win-direct")?.signingRequirement).toBe("optional");
  expect(adapterFor("win-store-msix")?.signingRequirement).toBe("required-to-run");
  expect(adapterFor("win-store-unpackaged")?.signingRequirement).toBe("required-to-submit");
  expect(adapterFor("mac-direct")).toBeUndefined();
});

test("win-direct stages follow the contract pipeline", () => {
  expect(runIds(adapterOrThrow("win-direct").stages(input({})))).toEqual([
    "stage",
    "sign-runtime",
    "prepare-webview2",
    "assemble",
    "sign-installer",
    "verify-artifact",
  ]);
});

test("win-store-unpackaged adds a submission checklist stage and forbids bootstrap", () => {
  const adapter = adapterOrThrow("win-store-unpackaged");
  const ids = runIds(adapter.stages({ ...input({}), channel: "win-store-unpackaged" }));
  expect(ids[ids.length - 1]).toBe("submission");
});

test.each(["win-direct", "win-store-unpackaged"])(
  "%s rejects machine-wide user data cleanup before packaging",
  (channel) => {
    const config = (options: Record<string, unknown>) =>
      JSON.stringify({ version: 1, channels: { [channel]: options } });
    expect(() =>
      parsePackaging(config({ scope: "perMachine", uninstall: { preserveUserData: false } })),
    ).toThrow(/requires scope=perUser/);
    for (const options of [
      { scope: "perMachine" },
      { scope: "perMachine", uninstall: { preserveUserData: true } },
      { scope: "perUser", uninstall: { preserveUserData: false } },
      { uninstall: { preserveUserData: false } },
    ]) {
      expect(() => parsePackaging(config(options))).not.toThrow();
    }
  },
);

test("MSIX staging bounds derived package names and preserves explicit identities", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-msix-name-")));
  try {
    const source = join(root, "source");
    const original = input({});
    await Bun.write(join(source, "runtime", "bun.exe"), "bun fixture");
    await Bun.write(join(source, "bunaway-host.exe"), "host fixture");
    await Bun.write(join(source, "manifest.json"), JSON.stringify(original.manifest));
    const icons = {
      "windows.square44": join(root, "44.png"),
      "windows.square150": join(root, "150.png"),
      "windows.storeLogo": join(root, "store.png"),
    };
    for (const path of Object.values(icons)) await Bun.write(path, "icon fixture");
    const identifier = "com.example.department.product.averylongapplicationname";
    for (const [packageName, minVersion, channelConfig] of [
      [undefined, "10.0.18362.0", {}],
      ["Store.ReservedIdentity", "10.0.22621.0", {}],
      ["Store.ChannelOverride", "10.0.26100.0", { minVersion: "10.0.26100.0" }],
      ["Store.Virtualized", "10.0.17763.0", { unvirtualizedData: false }],
    ] as const) {
      const msixInput: AdapterInput = {
        ...original,
        channel: "win-store-msix",
        channelConfig: { ...channelConfig, ...(packageName ? { packageName } : {}) },
        metadata: {
          ...metadata,
          root,
          identifier,
          icons,
          targets: [
            {
              platform: "windows",
              arch: "x64",
              ...(packageName === "Store.ReservedIdentity" ||
              packageName === "Store.ChannelOverride"
                ? { minVersion: "10.0.22621.0" }
                : {}),
            },
          ],
        },
        artifact: { dir: source, packageDir: source, executable: join(source, "bunaway-host.exe") },
      };
      const staging = join(root, packageName ?? "derived");
      const stage = adapterOrThrow("win-store-msix").stages(msixInput)[0];
      if (!stage) throw new Error("Expected MSIX staging.");
      await stage.run({ input: msixInput, staging, report() {}, addArtifact() {} });
      const xml = await readFile(join(staging, "package", "AppxManifest.xml"), "utf8");
      expect(xml).toContain(`<Identity Name="${packageName ?? identifier.slice(0, 50)}"`);
      expect(xml).toContain(`MinVersion="${minVersion}"`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("win-store-msix requires publisher.identity and MSIX icons up front", () => {
  const adapter = adapterOrThrow("win-store-msix");
  const msixInput = (overrides: Partial<ResolvedPackaging>, icons = {}) =>
    ({
      ...input({}),
      channel: "win-store-msix",
      metadata: { ...metadata, ...overrides, icons },
    }) as AdapterInput;
  expect(() => adapter.stages(msixInput({ publisher: { display: "NoId" } }))).toThrow(
    /publisher\.identity/,
  );
  expect(() => adapter.stages(msixInput({}))).toThrow(/icons\.windows/);
  const fullIcons = {
    "windows.square44": "C:\\proj\\icons\\44.png",
    "windows.square150": "C:\\proj\\icons\\150.png",
    "windows.storeLogo": "C:\\proj\\icons\\store.png",
  };
  const stages = adapter.stages(msixInput({}, fullIcons));
  expect(runIds(stages)).toEqual(["stage", "assemble", "sign", "verify-artifact"]);
  const oldTarget = msixInput(
    { targets: [{ platform: "windows", arch: "x64", minVersion: "10.0.17763.0" }] },
    fullIcons,
  );
  expect(() => adapter.stages(oldTarget)).toThrow(/unvirtualizedData requires minVersion/);
  expect(() =>
    adapter.stages({ ...oldTarget, channelConfig: { unvirtualizedData: false } }),
  ).not.toThrow();
  expect(() =>
    adapter.stages({ ...oldTarget, channelConfig: { minVersion: "10.0.18362.0" } }),
  ).not.toThrow();
  expect(() =>
    adapter.stages({ ...oldTarget, channelConfig: { minVersion: "10.0.17763.0" } }),
  ).toThrow(/unvirtualizedData requires minVersion/);
  expect(() =>
    adapter.stages(
      msixInput(
        {
          version: { semver: "1.2.3", build: 4, msix: "1.2.3.4" },
        },
        fullIcons,
      ),
    ),
  ).toThrow(/release.build=0/);
});

test("Inno script encodes scope, WebView2 mode, shortcuts and uninstall data policy", () => {
  const base = {
    name: "Test App",
    identifier: "com.example.app",
    version: "1.2.3",
    publisher: "Example",
    payloadDir: "C:\\stage\\app",
    outputDir: "C:\\stage\\installer",
    outputBaseName: "com.example.app-setup-1.2.3",
    desktopShortcut: true,
    startMenuShortcut: true,
    webView2: "check" as const,
    appDataDir: "{localappdata}\\bunaway\\com.example.app",
    preserveUserData: true,
  };
  const perUser = renderInnoScript({ ...base, scope: "perUser" });
  expect(perUser).toContain("DefaultDirName={localappdata}\\Programs\\com.example.app");
  expect(perUser).toContain("DefaultGroupName=com.example.app");
  expect(perUser).toContain("{autodesktop}\\Test App (com.example.app)");
  expect(perUser).toContain("PrivilegesRequired=lowest");
  expect(perUser).toContain("ArchitecturesAllowed=x64compatible");
  expect(perUser).toContain('Name: "desktopicon"');
  expect(perUser).toContain("{group}\\Test App");
  expect(perUser).toContain("HasWebView2Runtime");
  expect(perUser).toContain("F3017226-FE2A-4295-8BDF-00C3A9A7E4C5");
  expect(perUser).toContain("StrToVersion(Version, PackedVersion)");
  expect(perUser).toContain("ComparePackedVersion(PackedVersion, 0) > 0");
  expect(perUser.match(/and HasRuntimeVersion\(Version\)/g)).toHaveLength(3);
  expect(perUser).not.toContain("MicrosoftEdgeWebview2Setup.exe");
  expect(perUser).not.toContain("[UninstallDelete]");

  const perMachine = renderInnoScript({
    ...base,
    scope: "perMachine",
    bootstrapperPath: "C:\\stage\\webview2\\MicrosoftEdgeWebview2Setup.exe",
    webView2: "bootstrap",
    signed: true,
  });
  expect(perMachine).toContain("DefaultDirName={autopf}\\com.example.app");
  expect(perMachine).toContain("PrivilegesRequired=admin");
  expect(perMachine).toContain("ArchitecturesAllowed=x64compatible");
  expect(perMachine).not.toContain("[UninstallDelete]");
  expect(() => renderInnoScript({ ...base, scope: "perMachine", preserveUserData: false })).toThrow(
    /must preserve user data/,
  );
  const perUserCleanup = renderInnoScript({ ...base, scope: "perUser", preserveUserData: false });
  expect(perUserCleanup).toContain(
    'Type: filesandordirs; Name: "{localappdata}\\bunaway\\com.example.app"',
  );
  expect(perMachine).toContain("MicrosoftEdgeWebview2Setup.exe");
  const bracePath = "C:\\project\\{demo}\\bootstrapper.exe";
  const braceScript = renderInnoScript({
    ...base,
    scope: "perUser",
    bootstrapperPath: bracePath,
    webView2: "bootstrap",
  });
  expect(braceScript).toContain(`Source: "${bracePath}";`);
  expect(braceScript).not.toContain("C:\\project\\{{demo}");
  expect(() =>
    renderInnoScript({ ...base, scope: "perUser", bootstrapperPath: "bad\npath" }),
  ).toThrow(/line breaks/);
  expect(perMachine).toContain('Parameters: "/silent /install"');
  expect(perMachine).toContain("SignTool=bunaway\nSignedUninstaller=yes");
  expect(perUser).not.toContain("SignTool=bunaway");

  const escaped = renderInnoScript({ ...base, scope: "perUser", name: 'My "App" {Beta}' });
  expect(escaped).toContain('AppName=My "App" {{Beta}');
  expect(escaped).toContain('Description: "Launch My ""App"" {{Beta}"');
  expect(escaped).toContain("DefaultDirName={localappdata}\\Programs\\com.example.app");
  expect(escaped).toContain("{autodesktop}\\My _App_ {{Beta} (com.example.app)");
  for (const scope of ["perUser", "perMachine"] as const) {
    const first = renderInnoScript({ ...base, scope });
    const second = renderInnoScript({ ...base, scope, identifier: "com.other.app" });
    for (const directive of ["DefaultDirName", "DefaultGroupName", "AppId"]) {
      const pattern = new RegExp(`^${directive}=.*$`, "m");
      expect(first.match(pattern)?.[0]).not.toBe(second.match(pattern)?.[0]);
    }
    expect(second).toContain("{autodesktop}\\Test App (com.other.app)");
  }
  expect(() => renderInnoScript({ ...base, scope: "perUser", name: "App\n[Run]" })).toThrow(
    /line breaks/,
  );
});

test("AppxManifest declares full trust, virtualization opt-out and icon resources", () => {
  const manifestOptions = {
    packageName: "Example.TestApp",
    appId: "com.example.app",
    name: "Test App",
    publisherDisplay: "Example",
    publisherIdentity: "CN=Example",
    version: "1.2.3.0",
    minVersion: "10.0.18362.0",
    unvirtualizedData: true,
    capabilities: [],
    executable: "bunaway-host.exe",
    logo: {
      square44: "Square44x44Logo.png",
      square150: "Square150x150Logo.png",
      storeLogo: "StoreLogo.png",
      wide: "Wide310x150Logo.png",
    },
  };
  const xml = renderAppxManifest(manifestOptions);
  expect(() => renderAppxManifest({ ...manifestOptions, minVersion: "10.0.17763.0" })).toThrow(
    /unvirtualizedData requires minVersion/,
  );
  for (const packageName of ["a", "ab", "a".repeat(51)]) {
    expect(() => renderAppxManifest({ ...manifestOptions, packageName })).toThrow(/3\.\.50/);
    expect(() =>
      parsePackaging(
        JSON.stringify({ version: 1, channels: { "win-store-msix": { packageName } } }),
      ),
    ).toThrow();
  }
  for (const packageName of ["abc", "a".repeat(50)]) {
    expect(() => renderAppxManifest({ ...manifestOptions, packageName })).not.toThrow();
    expect(() =>
      parsePackaging(
        JSON.stringify({ version: 1, channels: { "win-store-msix": { packageName } } }),
      ),
    ).not.toThrow();
  }
  expect(xml).toContain('Name="Example.TestApp"');
  expect(xml).toContain('Publisher="CN=Example"');
  expect(xml).toContain('Version="1.2.3.0"');
  expect(xml).toContain('Executable="bunaway-host.exe"');
  expect(xml).toContain('EntryPoint="Windows.FullTrustApplication"');
  expect(xml).toContain('Name="runFullTrust"');
  expect(xml).toContain('Name="unvirtualizedResources"');
  expect(xml).toContain("$(KnownFolder:LocalAppData)\\bunaway\\com.example.app");
  expect(xml).toContain("Square44x44Logo.png");
  expect(xml.match(/<uap:VisualElements[^>]*>/)?.[0]).not.toContain("Wide310x150Logo");
  expect(xml).toMatch(
    /<uap:VisualElements[^>]*>\s*<uap:DefaultTile Wide310x150Logo="Wide310x150Logo.png"\/>\s*<\/uap:VisualElements>/,
  );

  const virtualized = renderAppxManifest({
    packageName: "Example.TestApp",
    appId: "com.example.app",
    name: "Test App",
    publisherDisplay: "Example",
    publisherIdentity: "CN=Example",
    version: "1.2.3.0",
    minVersion: "10.0.17763.0",
    unvirtualizedData: false,
    capabilities: [
      "internetClient",
      "privateNetworkClientServer",
      "picturesLibrary",
      "broadFileSystemAccess",
    ],
    executable: "bunaway-host.exe",
    logo: {
      square44: "Square44x44Logo.png",
      square150: "Square150x150Logo.png",
      storeLogo: "StoreLogo.png",
    },
  });
  expect(virtualized).not.toContain("unvirtualizedResources");
  expect(virtualized).not.toContain("ExcludedDirectories");
  expect(virtualized).toContain('<Capability Name="internetClient"/>');
  expect(virtualized).toContain('<Capability Name="privateNetworkClientServer"/>');
  expect(virtualized).toContain('<uap:Capability Name="picturesLibrary"/>');
  expect(virtualized).toContain('<rescap:Capability Name="broadFileSystemAccess"/>');
  expect(virtualized).not.toContain('<rescap:Capability Name="privateNetworkClientServer"');
  for (const version of [
    "1.2.3.4",
    "0.1.0.0",
    "65536.0.0.0",
    "1.65536.0.0",
    "1.0.65536.0",
    "1.2.3",
    "1.2.3.0\n",
  ]) {
    expect(() => renderAppxManifest({ ...manifestOptions, version })).toThrow(/win-store-msix/);
  }
});

test("Windows signing resolves certificates from the project root, independent of cwd", () => {
  const root = resolve(tmpdir(), "bunaway-certificate-project");
  for (const certificateFile of ["certs/developer.pfx", resolve(tmpdir(), "external.pfx")]) {
    const ctx: StageContext = {
      input: { ...input({}, { certificateFile }), metadata: { ...metadata, root } },
      staging: "unused",
      report() {},
      addArtifact() {},
    };
    const args = signingArgs(ctx);
    expect(args[args.indexOf("/f") + 1]).toBe(resolve(root, certificateFile));
  }
});

test("payload staging refuses internal junctions before signing can mutate the build", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-copy-")));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "real-runtime"), { recursive: true });
    await writeFile(join(source, "real-runtime", "bun.exe"), "original runtime");
    await symlink(join(source, "real-runtime"), join(source, "runtime"), "junction");
    await expect(copyPayload(source, join(root, "stage"))).rejects.toThrow(/symlinks or junctions/);
    expect(await readFile(join(source, "real-runtime", "bun.exe"), "utf8")).toBe(
      "original runtime",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain staged payloads are independent and exclude previous package outputs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-copy-")));
  try {
    const source = join(root, "source");
    const stage = join(source, "packaged", "staging");
    await Bun.write(join(source, "runtime", "bun.exe"), "original runtime");
    await Bun.write(join(source, "packaged", "previous", "setup.exe"), "previous installer");
    await copyPayload(source, stage);
    await writeFile(join(stage, "runtime", "bun.exe"), "signed runtime");
    expect(await readFile(join(source, "runtime", "bun.exe"), "utf8")).toBe("original runtime");
    expect(await Bun.file(join(stage, "packaged", "previous", "setup.exe")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["success", "sign", "verify"])("Inno signing callback: %s", async (failure) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-inno-")));
  try {
    const ctx: StageContext = {
      input: input(
        {},
        { certificateFile: "developer.pfx", passwordEnv: "BUNAWAY_TEST_PFX_PASSWORD" },
      ),
      staging: root,
      report() {},
      addArtifact() {},
    };
    const password = "test-password-never-written";
    const previous = process.env.BUNAWAY_TEST_PFX_PASSWORD;
    process.env.BUNAWAY_TEST_PFX_PASSWORD = password;
    let signing: Awaited<ReturnType<typeof prepareInnoSigning>>;
    try {
      signing = await prepareInnoSigning(ctx, root, "signtool.exe");
    } finally {
      if (previous === undefined) delete process.env.BUNAWAY_TEST_PFX_PASSWORD;
      else process.env.BUNAWAY_TEST_PFX_PASSWORD = previous;
    }
    const callback = join(root, "inno-signing", "sign.js");
    expect(await readFile(callback, "utf8")).not.toContain(password);
    expect(signing.args.join(" ")).not.toContain(password);
    expect(JSON.parse(signing.env.BUNAWAY_INNO_SIGN_COMMANDS)[0]).toContain(password);
    expect(JSON.parse(signing.env.BUNAWAY_INNO_SIGN_COMMANDS)[0]).toContain(
      resolve(ctx.input.metadata.root, "developer.pfx"),
    );
    const trace = join(root, "trace.txt");
    const tool = join(root, "fake-signtool.js");
    await writeFile(
      tool,
      `import { appendFileSync } from "node:fs";
appendFileSync(process.env.TRACE, process.argv[2] + "\\n");
if (process.argv[2] === process.env.FAIL_STAGE) {
  console.error(process.env.BUNAWAY_TEST_PFX_PASSWORD);
  process.exit(1);
}
`,
    );
    const child = Bun.spawn([process.execPath, callback, join(root, "uninstaller.exe")], {
      env: {
        ...signing.env,
        TRACE: trace,
        FAIL_STAGE: failure,
        BUNAWAY_INNO_SIGN_COMMANDS: JSON.stringify([
          [process.execPath, tool, "sign"],
          [process.execPath, tool, "verify"],
        ]),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(failure === "success" ? 0 : 1);
    expect(await readFile(trace, "utf8")).toBe(failure === "sign" ? "sign\n" : "sign\nverify\n");
    expect(stdout + stderr).not.toContain(password);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packagedSha256 mirrors the shipped bytes in the staged manifest", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-msix-")));
  try {
    const payload = resolve(root, "package");
    await Bun.write(resolve(payload, "runtime/bun.exe"), "bun bytes");
    await Bun.write(resolve(payload, "bunaway-host.exe"), "host bytes");
    await Bun.write(
      resolve(payload, "manifest.json"),
      JSON.stringify({
        bun: {
          version: "1",
          sourceRevision: "test-revision",
          target: "windows-x64-baseline",
          executableSha256: "upstream",
          licenseSha256: "l",
        },
        assets: {},
        app: { id: "x", version: "1" },
        host: { target: "windows-x64", sha256: "oldhost" },
      }),
    );
    const { recordPackagedHashes } = await import(
      "../../packages/packaging/src/channels/windows/manifest.ts"
    );
    const manifest = await recordPackagedHashes(payload);
    expect(manifest.bun.executableSha256).toBe("upstream"); // immutable provenance
    expect(manifest.bun.packagedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.host?.packagedSha256).toMatch(/^[0-9a-f]{64}$/);
    const written = JSON.parse(await Bun.file(resolve(payload, "manifest.json")).text());
    expect(written.bun.packagedSha256).toBe(manifest.bun.packagedSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
