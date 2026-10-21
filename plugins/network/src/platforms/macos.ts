import { BunawayError } from "@bunaway/protocol";

export {
  dispose,
  initialize,
  runCancelDownload,
  runDownload,
  runDownloadStatus,
  runExchange,
  runIsOnline,
  runRequest,
  runResolveHost,
} from "#network/platforms/shared";

/** The system proxy route lookup is implemented for Windows only. */
export function runResolveProxy(): never {
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "Proxy resolution is not supported on macOS.",
  });
}
