import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageManifest } from "../../contract.ts";
import { sha256 } from "./common.ts";

// Keep build provenance and post-signing bytes separate. Nothing patches the
// compiled executable after signing, and these hashes are not startup checks.
export async function recordPackagedHashes(
  payloadDir: string,
): Promise<PackageManifest> {
  const manifestPath = join(payloadDir, "manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as PackageManifest;
  if (manifest.host?.kind !== "bun-compiled" || !manifest.host.executable) {
    throw new Error("Missing compiled Windows app.");
  }
  manifest.host.packagedSha256 = await sha256(
    join(payloadDir, manifest.host.executable),
  );
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
