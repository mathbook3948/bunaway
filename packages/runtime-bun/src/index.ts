// Bun 서비스 어댑터와 프로세스 IPC 연결.

export type { AppMetadata } from "./app-metadata.ts";
export { bindHostAPI } from "./host-api.ts";
export { readJsonLines } from "./process-ipc.ts";
export { runBunApp } from "./runtime.ts";
