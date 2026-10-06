import { cp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type AdapterInput,
  type AdapterStage,
  CODES,
  type PackageAdapter,
} from "../../contract.ts";
import { copyPayload, findWindowsKitTool, must } from "./common.ts";
import { recordPackagedHashes } from "./manifest.ts";
import { signFiles, verifySignatures } from "./sign.ts";

// win-store-msix: AppxManifest + makeappx + signtool. MSIX refuses unsigned
// packages entirely, so this channel is "required-to-run": unsigned output is
// produced for inspection only and is neither installable nor submittable.
//
// Data virtualization: MSIX redirects AppData writes into a per-package
// location that Windows deletes on uninstall. The manifest opts our data
// root out via virtualization:ExcludedDirectories (requires the restricted
// capability unvirtualizedResources, which needs Store approval). Whether
// data actually survives uninstall is verified only by a local sideload
// test — the report marks it unverified until then.

const DEFAULT_MIN_VERSION = "10.0.17763.0";
// TargetDeviceFamily requires MaxVersionTested; default to the SDK version
// this tooling was verified on. Channels override via maxVersionTested.
const DEFAULT_MAX_TESTED = "10.0.26100.0";

interface MsixOptions {
  packageName: string;
  appId: string;
  name: string;
  publisherDisplay: string;
  publisherIdentity: string;
  version: string;
  minVersion: string;
  maxVersionTested?: string;
  unvirtualizedData: boolean;
  capabilities: string[];
  executable: string;
  logo: { square44: string; square150: string; storeLogo: string; wide?: string };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderAppxManifest(options: MsixOptions): string {
  // Virtualization opt-outs live under <Properties>: the desktop6 element
  // disables all AppData write virtualization on older OSes, and the Win11+
  // virtualization element lists targeted exclusions (takes precedence there).
  // Both require the unvirtualizedResources restricted capability.
  const virtualization = options.unvirtualizedData
    ? `
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
    <virtualization:FileSystemWriteVirtualization>
      <virtualization:ExcludedDirectories>
        <virtualization:ExcludedDirectory>$(KnownFolder:LocalAppData)\\bunaway\\${escapeXml(options.appId)}</virtualization:ExcludedDirectory>
      </virtualization:ExcludedDirectories>
    </virtualization:FileSystemWriteVirtualization>`
    : "";
  const capabilities = [
    '<rescap:Capability Name="runFullTrust"/>',
    ...(options.unvirtualizedData ? ['<rescap:Capability Name="unvirtualizedResources"/>'] : []),
    ...options.capabilities.map((cap) => `<rescap:Capability Name="${escapeXml(cap)}"/>`),
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         xmlns:virtualization="http://schemas.microsoft.com/appx/manifest/virtualization/windows10"
         IgnorableNamespaces="uap rescap desktop6 virtualization">
  <Identity Name="${escapeXml(options.packageName)}" Publisher="${escapeXml(options.publisherIdentity)}" Version="${escapeXml(options.version)}" ProcessorArchitecture="x64"/>
  <Properties>
    <DisplayName>${escapeXml(options.name)}</DisplayName>
    <PublisherDisplayName>${escapeXml(options.publisherDisplay)}</PublisherDisplayName>
    <Logo>${options.logo.storeLogo}</Logo>${virtualization}
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${escapeXml(options.minVersion)}"${options.maxVersionTested ? ` MaxVersionTested="${escapeXml(options.maxVersionTested)}"` : ""}/>
  </Dependencies>
  <Resources><Resource Language="en-US"/></Resources>
  <Applications>
    <Application Id="App" Executable="${escapeXml(options.executable)}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${escapeXml(options.name)}" Square150x150Logo="${options.logo.square150}" Square44x44Logo="${options.logo.square44}" Description="${escapeXml(options.name)}" BackgroundColor="transparent">${options.logo.wide ? `\n        <uap:DefaultTile Wide310x150Logo="${escapeXml(options.logo.wide)}"/>` : ""}
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    ${capabilities.join("\n    ")}
  </Capabilities>
</Package>
`;
}

const adapter: PackageAdapter = {
  channel: "win-store-msix",
  platform: "windows",
  signingRequirement: "required-to-run",
  stages(input: AdapterInput): AdapterStage[] {
    const config = input.channelConfig;
    const metadata = input.metadata;
    if (!metadata.publisher.identity) {
      throw new Error(
        'win-store-msix requires packaging.json publisher.identity (the X.500 subject, e.g. "CN=Example"), which must match the signing certificate.',
      );
    }
    const icons = metadata.icons;
    const missing = ["windows.square44", "windows.square150", "windows.storeLogo"].filter(
      (key) => !icons[key],
    );
    if (missing.length) {
      throw new Error(
        `win-store-msix requires icon assets ${missing.join(", ")} (declare them under icons.windows in packaging.json).`,
      );
    }
    const unvirtualizedData = (config.unvirtualizedData as boolean | undefined) ?? true;
    const packageName = (config.packageName as string | undefined) ?? metadata.identifier;
    const capabilities = (config.capabilities as string[] | undefined) ?? [];
    const manifestXml = renderAppxManifest({
      packageName,
      appId: input.manifest.app.id,
      name: metadata.name,
      publisherDisplay: metadata.publisher.display,
      publisherIdentity: metadata.publisher.identity,
      version: metadata.version.msix,
      minVersion: (config.minVersion as string | undefined) ?? DEFAULT_MIN_VERSION,
      maxVersionTested: (config.maxVersionTested as string | undefined) ?? DEFAULT_MAX_TESTED,
      unvirtualizedData,
      capabilities,
      executable: "bunaway-host.exe",
      logo: {
        square44: "Square44x44Logo.png",
        square150: "Square150x150Logo.png",
        storeLogo: "StoreLogo.png",
        ...(icons["windows.wide"] ? { wide: "Wide310x150Logo.png" } : {}),
      },
    });

    const state: { packageDir?: string; msix?: string } = {};
    return [
      {
        id: "stage",
        title: "Stage MSIX payload and manifest",
        async run(ctx) {
          const packageDir = join(ctx.staging, "package");
          await copyPayload(input.artifact.packageDir, packageDir);
          await Bun.write(join(packageDir, "AppxManifest.xml"), manifestXml);
          // Icon files land under the manifest's resource names.
          const copies: [string, string][] = [
            [icons["windows.square44"] as string, "Square44x44Logo.png"],
            [icons["windows.square150"] as string, "Square150x150Logo.png"],
            [icons["windows.storeLogo"] as string, "StoreLogo.png"],
          ];
          if (icons["windows.wide"]) copies.push([icons["windows.wide"], "Wide310x150Logo.png"]);
          for (const [source, name] of copies) await cp(source, join(packageDir, name));
          // Signing the .msix does not change inner bytes, but the hash rule
          // stays uniform: packagedSha256 mirrors the shipped manifest.
          await recordPackagedHashes(packageDir);
          state.packageDir = packageDir;
        },
      },
      {
        id: "assemble",
        title: "Pack payload with makeappx",
        async run(ctx) {
          if (!state.packageDir) throw new Error("stage did not produce a package directory.");
          const makeappx = await findWindowsKitTool("makeappx.exe");
          if (!makeappx) {
            ctx.report({
              code: CODES.TOOL_MISSING,
              severity: "error",
              message: "makeappx.exe not found in the Windows SDK bin directory.",
            });
            throw new Error("makeappx.exe not found.");
          }
          const msix = join(ctx.staging, `${metadata.identifier}-${metadata.version.msix}.msix`);
          try {
            await must(makeappx, ["pack", "/d", state.packageDir, "/p", msix, "/o"]);
          } catch (error) {
            ctx.report({
              code: CODES.TOOL_FAILED,
              severity: "error",
              message: `makeappx failed: ${error instanceof Error ? error.message : String(error)}`,
            });
            throw error;
          }
          state.msix = msix;
        },
      },
      {
        id: "sign",
        title: "Sign the MSIX package",
        async run(ctx) {
          if (!state.msix) throw new Error("assemble did not produce an msix.");
          let signed = false;
          if (ctx.input.signing) {
            await signFiles(ctx, [state.msix]);
            signed = true;
          } else {
            ctx.report({
              code: CODES.SIGNING_MISSING,
              severity: "warning",
              message:
                "MSIX is unsigned: it cannot be sideloaded or submitted. Configure signing to produce a usable package.",
            });
          }
          ctx.addArtifact(relative(ctx.staging, state.msix), "msix", { signed });
        },
      },
      {
        id: "verify-artifact",
        title: "Verify the signed package",
        async run(ctx) {
          if (!state.msix) throw new Error("no msix to verify.");
          if (state.packageDir) await rm(state.packageDir, { recursive: true, force: true });
          if (ctx.input.signing) await verifySignatures(ctx, [state.msix]);
          ctx.report({
            code: CODES.VERIFY_FAILED,
            severity: "info",
            message: unvirtualizedData
              ? "Declares rescap:unvirtualizedResources (restricted capability: requires Store approval) and a LocalAppData virtualization exclusion for the app data root; whether data survives uninstall is UNVERIFIED until a local sideload test."
              : "AppData writes are virtualized by MSIX and removed on uninstall; set unvirtualizedData to request an exclusion.",
          });
        },
      },
    ];
  },
};

export default adapter;
