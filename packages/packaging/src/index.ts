export {
  findIscc,
  findWindowsKitTool,
} from "./channels/windows/common.ts";
export { type PackagingConfig, parsePackaging } from "./config.ts";
export * from "./contract.ts";
export {
  ownedDirectory,
  PublishedDirectoryCleanupError,
  publishOwnedDirectory,
} from "./directories.ts";
export { artifactPaths, loadManifest, verifyArtifact } from "./inputs.ts";
export {
  acquireBuildOutputLock,
  acquirePackageInputLock,
  TargetLockError,
} from "./locks.ts";
export { OUTPUT_TARGETS, type OutputTarget } from "./paths.ts";
export { adapterFor, registerAdapter, registeredChannels } from "./registry.ts";
export {
  type RequiredWindowsTool,
  requiredWindowsTools,
} from "./required-tools.ts";
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
