import type { WindowProcessFailureKind } from "@bunaway/plugin-api/native";

/** COREWEBVIEW2_PROCESS_FAILED_KIND values by number; an unlisted value reports `unknown-exited`. */
const PROCESS_FAILURE_KINDS: readonly WindowProcessFailureKind[] = [
  "browser-exited",
  "renderer-exited",
  "renderer-unresponsive",
  "frame-renderer-exited",
  "utility-exited",
  "sandbox-helper-exited",
  "gpu-exited",
  "plugin-exited",
  "plugin-broker-exited",
  "unknown-exited",
];

/** Name the WebView2 process failure kind reported by `ProcessFailed`. */
export function processFailureKind(kind: number): WindowProcessFailureKind {
  return PROCESS_FAILURE_KINDS[kind] ?? "unknown-exited";
}
