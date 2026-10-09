import type { AdapterStage, PackageAdapter } from "../../contract.ts";

// Pure manifest rendering remains available for schema-level tests. The
// registered adapter below fails closed until packaged activation preserves
// compiled app activation and data paths.

const DEFAULT_MIN_VERSION = "10.0.17763.0";
const UNVIRTUALIZED_MIN_VERSION = "10.0.18362.0";
// Names defined by the foundation and UAP schemas; other capabilities retain
// the restricted namespace used by this adapter.
const GENERAL_CAPABILITIES = new Set([
  "internetClient",
  "internetClientServer",
  "privateNetworkClientServer",
  "allJoyn",
  "codeGeneration",
]);
const UAP_CAPABILITIES = new Set([
  "documentsLibrary",
  "picturesLibrary",
  "videosLibrary",
  "musicLibrary",
  "enterpriseAuthentication",
  "sharedUserCertificates",
  "userAccountInformation",
  "removableStorage",
  "appointments",
  "contacts",
  "phoneCall",
  "blockedChatMessages",
  "objects3D",
  "voipCall",
  "chat",
]);

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
  logo: {
    square44: string;
    square150: string;
    storeLogo: string;
    wide?: string;
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Renders the Appx manifest and enforces supported Windows and package-version
 * constraints before SDK tooling consumes it.
 */
export function renderAppxManifest(options: MsixOptions): string {
  if (
    options.minVersion.localeCompare(DEFAULT_MIN_VERSION, undefined, {
      numeric: true,
    }) < 0
  ) {
    throw new Error(
      "Windows minVersion must be >= 10.0.17763.0 (bundled Bun requirement).",
    );
  }
  if (
    options.unvirtualizedData &&
    options.minVersion.localeCompare(UNVIRTUALIZED_MIN_VERSION, undefined, {
      numeric: true,
    }) < 0
  ) {
    throw new Error(
      "unvirtualizedData requires minVersion >= 10.0.18362.0 to preserve data on uninstall.",
    );
  }
  if (options.packageName.length < 3 || options.packageName.length > 50) {
    throw new Error(
      "win-store-msix requires packageName to be 3..50 characters.",
    );
  }
  if (
    options.version.trim() !== options.version ||
    !/^[1-9]\d*\.\d+\.\d+\.0$/.test(options.version) ||
    options.version.split(".").some((part) => Number(part) > 65535)
  ) {
    throw new Error(
      "win-store-msix requires a four-part version with major 1..65535 and release.build=0 (the fourth part is reserved for the Store).",
    );
  }
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
    ...new Set([
      "runFullTrust",
      ...(options.unvirtualizedData
        ? [
            "unvirtualizedResources",
          ]
        : []),
      ...options.capabilities,
    ]),
  ].map((cap) => {
    const prefix = GENERAL_CAPABILITIES.has(cap)
      ? ""
      : UAP_CAPABILITIES.has(cap)
        ? "uap:"
        : "rescap:";
    return `<${prefix}Capability Name="${escapeXml(cap)}"/>`;
  });
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

// MSIX stays registered so configuration fails with an actionable message.
// Compiled app activation and data paths need native validation before this
// channel stages or invokes any Windows SDK tool.
const adapter: PackageAdapter = {
  channel: "win-store-msix",
  platform: "windows",
  signingRequirement: "required-to-run",
  stages(): AdapterStage[] {
    throw new Error(
      "win-store-msix does not support compiled Bun apps yet: packaged activation and data paths are unverified. Use win-direct or win-store-unpackaged.",
    );
  },
};

export default adapter;
