import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdapterInput,
  adapterFor,
  type Diagnostic,
  parsePackaging,
  type StageContext,
} from "@bunaway/packaging";
import { findIscc } from "#packaging/channels/windows/common";
import {
  compileInno,
  type InnoOptions,
  renderInnoScript,
} from "#packaging/channels/windows/inno";
import { readPeMachine } from "#packaging/channels/windows/webview2-offline";
import { deadline } from "../fixtures/deadlines.ts";

const base: InnoOptions = {
  name: "Offline fixture",
  identifier: "com.example.offline",
  appId: "app.offline",
  version: "1.0.0",
  publisher: "Test",
  scope: "perUser",
  payloadDir: "C:\\stage\\app",
  outputDir: "C:\\stage\\installer",
  outputBaseName: "setup",
  desktopShortcut: false,
  startMenuShortcut: false,
  webView2: "offline",
  offlineInstallerPath:
    "C:\\stage\\webview2\\MicrosoftEdgeWebView2RuntimeInstallerx64.exe",
  appDataDir: "{localappdata}\\bunaway\\app.offline",
  preserveUserData: true,
  assetPaths: [],
  executableName: "App.exe",
};

setDefaultTimeout(deadline("build"));

const AMD64 = 0x8664;
const ARM64 = 0xaa64;

/** Smallest byte sequence the PE header reader accepts: DOS pointer, signature and machine. */
function peHeader(machine: number): Uint8Array {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x00004550, true);
  view.setUint16(0x84, machine, true);
  return bytes;
}

const offlineConfig = (installers: Record<string, string>) => ({
  channels: {
    "win-direct": {
      webView2: {
        mode: "offline",
        installers,
      },
    },
  },
});

test("webView2 offline settings accept per-architecture installer paths and keep the string modes", () => {
  const parsed = parsePackaging(
    JSON.stringify(
      offlineConfig({
        x64: "vendor/MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
      }),
    ),
  );
  expect(parsed.channels?.["win-direct"]?.webView2).toEqual({
    mode: "offline",
    installers: {
      x64: "vendor/MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
    },
  });
  for (const mode of [
    "check",
    "bootstrap",
  ] as const) {
    const config = parsePackaging(
      JSON.stringify({
        channels: {
          "win-direct": {
            webView2: mode,
          },
        },
      }),
    );
    expect(config.channels?.["win-direct"]?.webView2).toBe(mode);
  }
});

test("webView2 offline settings reject unknown keys, escaping paths and the Store channel", () => {
  for (const invalid of [
    offlineConfig({}),
    offlineConfig({
      x86: "a.exe",
    }),
    offlineConfig({
      x64: "..\\outside.exe",
    }),
    offlineConfig({
      x64: "C:\\absolute.exe",
    }),
    offlineConfig({
      x64: "/absolute.exe",
    }),
    offlineConfig({
      x64: "C:drive-relative.exe",
    }),
    offlineConfig({
      x64: "",
    }),
    {
      channels: {
        "win-direct": {
          webView2: {
            mode: "download",
            installers: {
              x64: "a.exe",
            },
          },
        },
      },
    },
    {
      channels: {
        "win-direct": {
          webView2: {
            mode: "offline",
            installers: {
              x64: "a.exe",
            },
            url: "https://example.com/setup.exe",
          },
        },
      },
    },
    {
      channels: {
        "win-direct": {
          webView2: "offline",
        },
      },
    },
    {
      channels: {
        "win-store-unpackaged": {
          webView2: {
            mode: "offline",
            installers: {
              x64: "a.exe",
            },
          },
        },
      },
    },
  ]) {
    expect(() => parsePackaging(JSON.stringify(invalid))).toThrow();
  }
});

test("the PE header reader returns the machine field and rejects other data", () => {
  expect(readPeMachine(peHeader(AMD64))).toBe(AMD64);
  expect(readPeMachine(peHeader(ARM64))).toBe(ARM64);
  expect(readPeMachine(new Uint8Array(16))).toBeUndefined();
  expect(readPeMachine(new Uint8Array(256))).toBeUndefined();
  const pointerOutside = peHeader(AMD64);
  new DataView(pointerOutside.buffer).setUint32(0x3c, 0xfffff, true);
  expect(readPeMachine(pointerOutside)).toBeUndefined();
});

test("offline installer script embeds the installer uncompressed and installs only when the runtime is missing", () => {
  const script = renderInnoScript(base);
  expect(script).toContain(
    'Source: "C:\\stage\\webview2\\MicrosoftEdgeWebView2RuntimeInstallerx64.exe"; DestDir: "{tmp}"; DestName: "MicrosoftEdgeWebView2RuntimeInstaller.exe"; Flags: dontcopy nocompression',
  );
  expect(script).toContain("if HasWebView2Runtime then Exit;");
  expect(script).toContain(
    "ExtractTemporaryFile('MicrosoftEdgeWebView2RuntimeInstaller.exe');",
  );
  expect(script).toContain(
    "ExpandConstant('{tmp}\\MicrosoftEdgeWebView2RuntimeInstaller.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode",
  );
  expect(script).toContain("else if ResultCode <> 0 then");
  expect(script).toContain("else if not HasWebView2Runtime then");
  expect(script).toContain("check free disk space");
  expect(script).not.toContain("MicrosoftEdgeWebview2Setup.exe");
  expect(script).not.toContain("Check your internet connection");
  // The check-only reminder is for webView2="check" and must not appear here.
  expect(script).not.toContain("Log('WebView2 Runtime not detected");
});

/** Runs the prepare-webview2 stage of win-direct against a project root and returns its failure. */
async function prepareFailure(
  root: string,
  installers: Record<string, string>,
): Promise<string | undefined> {
  const adapter = adapterFor("win-direct");
  if (!adapter) {
    throw new Error("win-direct adapter missing");
  }
  const input: AdapterInput = {
    channel: "win-direct",
    channelConfig: {
      webView2: {
        mode: "offline",
        installers,
      },
    },
    metadata: {
      root,
      name: "Test App",
      identifier: "com.example.app",
      publisher: {
        display: "Example",
        identity: "CN=Example",
      },
      version: {
        semver: "1.2.3",
        build: 0,
        msix: "1.2.3.0",
      },
      icons: {},
      targets: [
        {
          platform: "windows",
          arch: "x64",
        },
      ],
    },
    target: "windows-x64",
    artifact: {
      dir: root,
      packageDir: root,
      executable: join(root, "app.exe"),
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
      app: {
        id: "com.example.app",
        version: "1.2.3",
      },
      host: {
        target: "windows-x64",
        kind: "bun-compiled",
        executable: "com.example.app.exe",
        sha256: "cc",
      },
    },
  };
  const stage = adapter.stages(input).find((s) => s.id === "prepare-webview2");
  if (!stage) {
    throw new Error("prepare-webview2 stage missing");
  }
  const reports: Omit<Diagnostic, "stage">[] = [];
  const ctx: StageContext = {
    input,
    staging: join(root, "staging"),
    report(diagnostic) {
      reports.push(diagnostic);
    },
    addArtifact() {},
  };
  try {
    await stage.run(ctx);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return reports.find((report) => report.severity === "error")?.message;
}

test("the build fails instead of falling back when the offline installer is unusable", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bunaway-webview2-offline-")),
  );
  try {
    await mkdir(join(root, "vendor"));
    await Bun.write(join(root, "vendor", "text.exe"), "not an executable");
    await Bun.write(join(root, "vendor", "arm64.exe"), peHeader(ARM64));
    expect(await prepareFailure(root, {})).toContain(
      "webView2.installers.x64 is not set",
    );
    expect(
      await prepareFailure(root, {
        x64: "vendor/missing.exe",
      }),
    ).toContain("not found");
    expect(
      await prepareFailure(root, {
        x64: "vendor/text.exe",
      }),
    ).toContain("not a Windows executable");
    expect(
      await prepareFailure(root, {
        x64: "vendor/arm64.exe",
      }),
    ).toContain("another architecture");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test.skipIf(process.platform !== "win32")(
  "an unsigned x64 executable is rejected by the signature check",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-webview2-unsigned-")),
    );
    try {
      await mkdir(join(root, "vendor"));
      await Bun.write(join(root, "vendor", "x64.exe"), peHeader(AMD64));
      const failure = await prepareFailure(root, {
        x64: "vendor/x64.exe",
      });
      expect(failure).toBeDefined();
      expect(failure).not.toContain("another architecture");
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

const iscc = process.platform === "win32" ? await findIscc() : undefined;

test.skipIf(!iscc)("Inno compiles the offline installer script", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bunaway-inno-offline-")),
  );
  try {
    await Bun.write(join(root, "app", "App.exe"), "runtime fixture");
    await Bun.write(join(root, "runtime.exe"), peHeader(AMD64));
    await mkdir(join(root, "installer"));
    const ctx: StageContext = {
      input: {} as AdapterInput,
      staging: root,
      report() {},
      addArtifact() {},
    };
    const script = renderInnoScript({
      ...base,
      payloadDir: join(root, "app"),
      outputDir: join(root, "installer"),
      offlineInstallerPath: join(root, "runtime.exe"),
    });
    const installer = await compileInno(ctx, script, root, "setup");
    expect(Bun.file(installer).size).toBeGreaterThan(0);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
