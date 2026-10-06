import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageManifest } from "../../contract.ts";
import { sha256 } from "./common.ts";

// Records post-signing digests in the staged manifest copy. The upstream
// executableSha256 stays the immutable provenance record; packagedSha256 is
// what runtime integrity checks verify (host.cpp prefers it when present).
// Unsigned payloads simply record the same bytes under both fields.
export async function recordPackagedHashes(payloadDir: string): Promise<PackageManifest> {
  const manifestPath = join(payloadDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  const bunExe = join(payloadDir, "runtime", "bun.exe");
  const hostExe = join(payloadDir, "bunaway-host.exe");
  manifest.bun.packagedSha256 = await sha256(bunExe);
  manifest.host = {
    ...(manifest.host ?? { target: "windows-x64" }),
    packagedSha256: await sha256(hostExe),
  };
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
