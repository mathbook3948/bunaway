import type { AdapterInput, AdapterStage, PackageAdapter } from "../../contract.ts";
import { installerStages } from "./installer.ts";

// win-direct: per-user (default) or per-machine Inno Setup installer for
// direct distribution. WebView2 is detected in the installer script;
// "bootstrap" mode bundles Microsoft's Evergreen bootstrapper (allowed for
// direct distribution, unlike the Store EXE/MSI channel).
const adapter: PackageAdapter = {
  channel: "win-direct",
  platform: "windows",
  signingRequirement: "optional",
  stages(input: AdapterInput): AdapterStage[] {
    return installerStages(input, {
      allowWebView2Bootstrap: true,
      defaultWebView2: "bootstrap",
    });
  },
};

export default adapter;
