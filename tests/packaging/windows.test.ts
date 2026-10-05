import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  adapterFor,
  type AdapterInput,
  type AdapterStage,
  type ResolvedPackaging,
  registeredChannels,
  type SigningConfig,
} from "../../packages/packaging/src/index.ts";
import { renderInnoScript } from "../../packages/packaging/src/channels/windows/inno.ts";
import { renderAppxManifest } from "../../packages/packaging/src/channels/windows/msix.ts";

const metadata: ResolvedPackaging = {
  root: "C:\\proj",
  name: "Test App",
  identifier: "com.example.app",
  publisher: { display: "Example", identity: "CN=Example" },
  version: { semver: "1.2.3", build: 4, msix: "1.2.3.4" },
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
  expect(perUser).toContain("DefaultDirName={localappdata}\\Programs\\Test App");
  expect(perUser).toContain("PrivilegesRequired=lowest");
  expect(perUser).toContain('Name: "desktopicon"');
  expect(perUser).toContain("{group}\\Test App");
  expect(perUser).toContain("HasWebView2Runtime");
  expect(perUser).toContain("F3017226-FE2A-4295-8BDF-00C3A9A7E4C5");
  expect(perUser).not.toContain("MicrosoftEdgeWebview2Setup.exe");
  expect(perUser).not.toContain("[UninstallDelete]");

  const perMachine = renderInnoScript({
    ...base,
    scope: "perMachine",
    preserveUserData: false,
    bootstrapperPath: "C:\\stage\\webview2\\MicrosoftEdgeWebview2Setup.exe",
    webView2: "bootstrap",
  });
  expect(perMachine).toContain("DefaultDirName={autopf}\\Test App");
  expect(perMachine).toContain("PrivilegesRequired=admin");
  expect(perMachine).toContain(
    'Type: filesandordirs; Name: "{localappdata}\\bunaway\\com.example.app"',
  );
  expect(perMachine).toContain("MicrosoftEdgeWebview2Setup.exe");
  expect(perMachine).toContain('Parameters: "/silent /install"');
});

test("AppxManifest declares full trust, virtualization opt-out and icon resources", () => {
  const xml = renderAppxManifest({
    packageName: "Example.TestApp",
    appId: "com.example.app",
    name: "Test App",
    publisherDisplay: "Example",
    publisherIdentity: "CN=Example",
    version: "1.2.3.4",
    minVersion: "10.0.17763.0",
    unvirtualizedData: true,
    capabilities: [],
    executable: "bunaway-host.exe",
    logo: {
      square44: "Square44x44Logo.png",
      square150: "Square150x150Logo.png",
      storeLogo: "StoreLogo.png",
    },
  });
  expect(xml).toContain('Name="Example.TestApp"');
  expect(xml).toContain('Publisher="CN=Example"');
  expect(xml).toContain('Version="1.2.3.4"');
  expect(xml).toContain('Executable="bunaway-host.exe"');
  expect(xml).toContain('EntryPoint="Windows.FullTrustApplication"');
  expect(xml).toContain('Name="runFullTrust"');
  expect(xml).toContain('Name="unvirtualizedResources"');
  expect(xml).toContain("$(KnownFolder:LocalAppData)\\bunaway\\com.example.app");
  expect(xml).toContain("Square44x44Logo.png");

  const virtualized = renderAppxManifest({
    packageName: "Example.TestApp",
    appId: "com.example.app",
    name: "Test App",
    publisherDisplay: "Example",
    publisherIdentity: "CN=Example",
    version: "1.2.3.4",
    minVersion: "10.0.17763.0",
    unvirtualizedData: false,
    capabilities: ["privateNetworkClientServer"],
    executable: "bunaway-host.exe",
    logo: {
      square44: "Square44x44Logo.png",
      square150: "Square150x150Logo.png",
      storeLogo: "StoreLogo.png",
    },
  });
  expect(virtualized).not.toContain("unvirtualizedResources");
  expect(virtualized).not.toContain("ExcludedDirectories");
  expect(virtualized).toContain("privateNetworkClientServer");
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
