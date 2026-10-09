import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageManifest } from "../../contract.ts";
import { sha256 } from "./common.ts";

/**
 * Records the compiled host's final digest in the staged manifest.
 * `sha256` remains build provenance; this digest describes packaged bytes and
 * is not a startup integrity check.
 */
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
