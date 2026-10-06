export { loadPackaging, type PackagingConfig, parsePackaging } from "./config.ts";
export * from "./contract.ts";
export { ownedDirectory } from "./directories.ts";
export { artifactPaths, loadManifest, verifyArtifact } from "./inputs.ts";
export { acquireBuildOutputLock, acquirePackageInputLock, TargetLockError } from "./locks.ts";
export { adapterFor, registerAdapter, registeredChannels } from "./registry.ts";
export {
  deriveIdentifier,
  deriveMsixPackageName,
  type ResolvedChannel,
  resolvePackaging,
} from "./resolve.ts";
export {
  packagingOutputDir,
  packagingReportPath,
  type RunPackageArgs,
  runPackage,
} from "./runner.ts";

// Side-effect import: registers the built-in channel adapters.
import "./channels/index.ts";
