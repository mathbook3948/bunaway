import type { NativeEnvironment } from "@bunaway/plugin";
import type { z } from "zod";
import type { resolveProxyInputSchema } from "#network/contract";
import {
  openWinHttp,
  resolveProxy,
  type WinHttpApi,
  winHttpApi,
} from "#network/platforms/resolve-proxy";
import {
  dispose as disposeShared,
  initialize as initializeShared,
  run,
} from "#network/platforms/shared";

export {
  runExchange,
  runIsOnline,
  runRequest,
  runResolveHost,
} from "#network/platforms/shared";

type ResolveProxyInput = z.output<typeof resolveProxyInputSchema>;
type SharedState = ReturnType<typeof initializeShared>;
type WindowsState = SharedState & {
  /** WinHTTP libraries, opened by the first proxy lookup and closed on dispose. */
  winhttp: {
    libraries: ReturnType<typeof openWinHttp> | undefined;
  };
};

/** The shared network state plus the slot for the WinHTTP libraries a proxy lookup opens. */
export function initialize(
  environment?: NativeEnvironment,
  seams?: Parameters<typeof initializeShared>[1],
): WindowsState {
  return Object.assign(initializeShared(environment, seams), {
    winhttp: {
      libraries: undefined,
    },
  });
}

function systemWinHttp(state: WindowsState): WinHttpApi {
  state.winhttp.libraries ??= openWinHttp();
  return winHttpApi(state.winhttp.libraries);
}

/** Look up the system proxy route for a URL under the shared request limit; at most 16 requests run at once. */
export function runResolveProxy(
  state: WindowsState,
  input: ResolveProxyInput,
  signal?: AbortSignal,
  api: () => WinHttpApi = () => systemWinHttp(state),
) {
  return run(state, input.timeoutMs, signal, async (activeSignal) => ({
    entries: resolveProxy(api(), input.url, input.timeoutMs, activeSignal),
  }));
}

/** Cancel in-flight work, then release the WinHTTP libraries; repeated cleanup is safe. */
export async function dispose(state: WindowsState) {
  await disposeShared(state);
  const libraries = state.winhttp.libraries;
  state.winhttp.libraries = undefined;
  if (libraries) {
    libraries.winhttp.close();
    libraries.kernel.close();
  }
}
