import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageManifest } from "../../contract.ts";
import { sha256 } from "./common.ts";

// Records post-signing digests in the staged manifest copy. The upstream
// executableSha256 stays the immutable provenance record; packagedSha256 is
// what runtime integrity checks verify. The pre-start PowerShell launcher also
// pins the post-sign bytes because it must reject tampering before Bun runs.
export async function recordPackagedHashes(
  payloadDir: string,
): Promise<PackageManifest> {
  const manifestPath = join(payloadDir, "manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as PackageManifest;
  const bunExe = join(payloadDir, "runtime", "bun.exe");
  const sourceDigest =
    manifest.bun.packagedSha256 ?? manifest.bun.executableSha256;
  const packagedDigest = await sha256(bunExe);
  const launcherPath = join(payloadDir, "launch.ps1");
  const launcher = await readFile(launcherPath, "utf8");
  const pins = [
    ...launcher.matchAll(/^Check \$bun '([a-f0-9]{64})'\r?$/gm),
  ];
  if (pins.length !== 1 || pins[0]?.[1] !== sourceDigest) {
    throw new Error(
      "Windows launcher runtime pin does not match the build manifest.",
    );
  }
  await Bun.write(
    launcherPath,
    launcher.replace(
      /^Check \$bun '[a-f0-9]{64}'\r?$/gm,
      `Check $bun '${packagedDigest}'`,
    ),
  );
  manifest.bun.packagedSha256 = packagedDigest;
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
