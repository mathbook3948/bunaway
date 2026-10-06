import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { type AdapterInput, type AdapterStage, CODES } from "../../contract.ts";
import { copyPayload } from "./common.ts";
import { compileInno, type InnoOptions, renderInnoScript } from "./inno.ts";
import { recordPackagedHashes } from "./manifest.ts";
import { signFiles, verifySignatures } from "./sign.ts";

// Shared Inno-based installer pipeline used by win-direct and
// win-store-unpackaged. Install/update/uninstall semantics live in the
// generated .iss (inno.ts); this module owns the stage wiring.
//
// Stages: stage → sign-runtime → prepare-webview2 → assemble → sign-installer
// → verify-artifact. The runner owns ordering/diagnostics/report; the state
// object carries what stage produced (payload dir, bootstrapper, installer)
// between stage closures.

interface InstallerOptions {
  // Store EXE/MSI must be standalone: never embed a WebView2 downloader.
  allowWebView2Bootstrap: boolean;
  // Channels that may bootstrap default to it; the store channel defaults to
  // check so it doesn't warn on every run.
  defaultWebView2: "check" | "bootstrap";
}

function opt<T>(value: unknown, fallback: T): T {
  return value === undefined ? fallback : (value as T);
}

export function installerStages(input: AdapterInput, options: InstallerOptions): AdapterStage[] {
  const config = input.channelConfig;
  const scope = opt<"perUser" | "perMachine">(config.scope, "perUser");
  let webView2 = opt<"check" | "bootstrap">(config.webView2, options.defaultWebView2);
  const desktopShortcut = opt<boolean>(config.desktopShortcut, false);
  const startMenuShortcut = opt<boolean>(config.startMenuShortcut, true);
  const uninstall = (config.uninstall ?? {}) as { preserveUserData?: boolean };
  const preserveUserData = uninstall.preserveUserData ?? true;

  const metadata = input.metadata;
  const target = metadata.targets.find(
    (target) => `${target.platform}-${target.arch}` === input.target,
  );
  const state: { payloadDir?: string; bootstrapperPath?: string; installer?: string } = {};

  const outputBaseName = `${metadata.identifier}-setup-${metadata.version.semver}`;

  return [
    {
      id: "stage",
      title: "Copy build artifact into staging",
      async run(ctx) {
        const payloadDir = join(ctx.staging, "app");
        await copyPayload(input.artifact.packageDir, payloadDir);
        state.payloadDir = payloadDir;
      },
    },
    {
      id: "sign-runtime",
      title: "Sign packaged executables",
      async run(ctx) {
        if (!state.payloadDir) throw new Error("stage did not produce a payload directory.");
        if (ctx.input.signing) {
          await signFiles(ctx, [join(state.payloadDir, "runtime", "bun.exe")]);
        }
        // Bind runtime checks and the pre-start launcher to the final bytes.
        await recordPackagedHashes(state.payloadDir);
        if (ctx.input.signing && ctx.input.channel === "win-store-unpackaged") {
          // Preserve third-party signatures and asset hashes; reject untrusted
          // payloads before assembly. Detect PE headers, including renamed DLLs.
          const executables: string[] = [];
          for (const entry of await readdir(state.payloadDir, {
            recursive: true,
            withFileTypes: true,
          })) {
            if (!entry.isFile()) continue;
            const path = join(entry.parentPath, entry.name);
            const file = Bun.file(path);
            const header = Buffer.from(await file.slice(0, 64).arrayBuffer());
            if (header.length < 64 || header.readUInt16LE(0) !== 0x5a4d) continue;
            const offset = header.readUInt32LE(0x3c);
            if ((await file.slice(offset, offset + 4).text()) === "PE\0\0") {
              executables.push(path);
            }
          }
          await verifySignatures(ctx, executables);
        }
      },
    },
    {
      id: "prepare-webview2",
      title: "Prepare WebView2 handling",
      async run(ctx) {
        if (!options.allowWebView2Bootstrap && webView2 === "bootstrap") {
          ctx.report({
            code: CODES.CONFIG_INVALID,
            severity: "warning",
            message:
              "Store submissions require standalone offline installers; falling back to webView2=check.",
          });
          webView2 = "check";
        }
        if (webView2 !== "bootstrap") return;
        // Microsoft's Evergreen bootstrapper (official fwlink). Embedded in the
        // installer and executed only when the runtime is missing.
        const url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
        const dir = join(ctx.staging, "webview2");
        await mkdir(dir, { recursive: true });
        const dest = join(dir, "MicrosoftEdgeWebview2Setup.exe");
        try {
          const response = await fetch(url, { redirect: "follow" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await Bun.write(dest, await response.arrayBuffer());
          state.bootstrapperPath = dest;
          ctx.report({
            code: CODES.TOOL_FAILED,
            severity: "info",
            message: `Downloaded the WebView2 Evergreen bootstrapper from ${url}.`,
          });
        } catch (error) {
          ctx.report({
            code: CODES.TOOL_FAILED,
            severity: "warning",
            message: `WebView2 bootstrapper download failed (${error instanceof Error ? error.message : String(error)}); falling back to check-only.`,
          });
          webView2 = "check";
        }
      },
    },
    {
      id: "assemble",
      title: "Compile Inno Setup installer",
      async run(ctx) {
        if (!state.payloadDir) throw new Error("stage did not produce a payload directory.");
        const outputDir = join(ctx.staging, "installer");
        await mkdir(outputDir, { recursive: true });
        const innoOptions: InnoOptions = {
          name: metadata.name,
          identifier: metadata.identifier,
          version: metadata.version.semver,
          publisher: metadata.publisher.display,
          scope,
          payloadDir: state.payloadDir,
          outputDir,
          outputBaseName,
          desktopShortcut,
          startMenuShortcut,
          webView2,
          appDataDir: `{localappdata}\\bunaway\\${input.manifest.app.id}`,
          preserveUserData,
          assetPaths: Object.keys(input.manifest.assets),
          signed: ctx.input.signing !== undefined,
          ...(target?.minVersion ? { minVersion: target.minVersion } : {}),
          ...(metadata.icons["windows.installer"]
            ? { iconFile: metadata.icons["windows.installer"] }
            : {}),
          ...(state.bootstrapperPath ? { bootstrapperPath: state.bootstrapperPath } : {}),
        };
        state.installer = await compileInno(
          ctx,
          renderInnoScript(innoOptions),
          ctx.staging,
          outputBaseName,
        );
      },
    },
    {
      id: "sign-installer",
      title: "Sign the installer",
      async run(ctx) {
        if (!state.installer) throw new Error("assemble did not produce an installer.");
        let signed = false;
        if (ctx.input.signing) {
          await signFiles(ctx, [state.installer]);
          signed = true;
        } else {
          ctx.report({
            code: CODES.SIGNING_MISSING,
            severity: "info",
            message: "Installer left unsigned; add signing credentials to remove trust warnings.",
          });
        }
        ctx.addArtifact(relative(ctx.staging, state.installer), "installer", { signed });
      },
    },
    {
      id: "verify-artifact",
      title: "Verify produced installer",
      async run(ctx) {
        if (!state.installer) throw new Error("no installer to verify.");
        // Drop intermediate payload dirs — only produced artifacts ship in
        // the output directory.
        if (state.payloadDir) await rm(state.payloadDir, { recursive: true, force: true });
        await rm(join(ctx.staging, "webview2"), { recursive: true, force: true });
        const file = Bun.file(state.installer);
        if (!(await file.exists()) || file.size === 0) {
          ctx.report({
            code: CODES.VERIFY_FAILED,
            severity: "error",
            message: "Installer artifact is missing or empty.",
            path: state.installer,
          });
          return;
        }
        if (ctx.input.signing) await verifySignatures(ctx, [state.installer]);
        ctx.report({
          code: CODES.VERIFY_FAILED,
          severity: "info",
          message: [
            `Default install dir: ${scope === "perUser" ? "%LOCALAPPDATA%\\Programs" : "Program Files"}\\${metadata.identifier}; existing installs keep their selected directory.`,
            `Data dir %LOCALAPPDATA%\\bunaway\\${input.manifest.app.id} is ${preserveUserData ? "preserved" : "removed"} on uninstall.`,
            "Updates are over-installs (same AppId): files are replaced, data is preserved.",
            "Silent install: <setup>.exe /VERYSILENT.",
          ].join(" "),
        });
      },
    },
  ];
}
