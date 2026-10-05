import { join, relative } from "node:path";
import type { AdapterInput, AdapterStage, PackageAdapter } from "../../contract.ts";
import { installerStages } from "./installer.ts";

// win-store-unpackaged: Microsoft Store submission as a classic EXE/MSI
// package. Separate contract from MSIX — the developer owns the versioned,
// immutable download URL and update lifecycle; the framework only produces
// a submission-ready installer plus a checklist.
//
// Official Store EXE/MSI requirements (learn.microsoft.com Windows Apps
// "Publish your app" unpackaged-app submission docs):
//  - Standalone offline installer — downloader stubs are rejected, so this
//    channel never embeds the WebView2 bootstrapper (webView2="check" only,
//    enforced by packaging.json validation).
//  - Every PE file must carry an Authenticode signature chaining to a
//    Microsoft Trusted Root Program CA — hence signingRequirement is
//    "required-to-submit" and unsigned output is never submittable.
//  - The download URL is versioned and immutable once submitted.
//  - Unattended install is mandatory (Inno supports /VERYSILENT; UAC is fine).
const adapter: PackageAdapter = {
  channel: "win-store-unpackaged",
  platform: "windows",
  signingRequirement: "required-to-submit",
  stages(input: AdapterInput): AdapterStage[] {
    const stages = installerStages(input, {
      allowWebView2Bootstrap: false,
      defaultWebView2: "check",
    });
    // Submission metadata lands after verification: what to fill in before
    // the developer uploads to Partner Center.
    stages.push({
      id: "submission",
      title: "Write Store submission checklist",
      async run(ctx) {
        const checklist = {
          channel: "win-store-unpackaged",
          packageVersion: input.metadata.version.semver,
          requirements: {
            standaloneOffline:
              "Installer contains all payloads; no install-time downloads (webView2=check enforced).",
            signedPe:
              "Every .exe inside the installer and the installer itself must be Authenticode-signed with a Trusted Root CA certificate.",
            immutableUrl:
              "The HTTPS download URL must be versioned and must not change after submission.",
            silentInstall:
              "Support unattended install: <setup>.exe /VERYSILENT (UAC prompt is allowed).",
          },
          downloadUrl: null as string | null,
          notes: [
            "Set downloadUrl to the final HTTPS location before submission; do not reuse the URL across versions.",
            "This channel does NOT share the MSIX update contract — updates are your installer/URL lifecycle, not Appx updates.",
          ],
        };
        const path = join(ctx.staging, "submission.json");
        await Bun.write(path, `${JSON.stringify(checklist, null, 2)}\n`);
        ctx.addArtifact(relative(ctx.staging, path), "submission-metadata", { signed: false });
      },
    });
    return stages;
  },
};

export default adapter;
