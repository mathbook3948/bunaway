import {
  BunawayError,
  defineNativePlugin,
  type NativeAdapter,
  type NativeHandlerContext,
} from "@bunaway/plugin";
import type { JsonValue } from "@bunaway/protocol";
import type { z } from "zod";
import { createWindows } from "./calls.ts";
import { windowDefinitions, windowEvents } from "./contract.ts";
import { createOperations as createMacosOperations } from "./platforms/macos.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

type WindowDefinitions = typeof windowDefinitions;
type PlatformOperations<Names extends keyof WindowDefinitions> = {
  [Name in Names]: WindowDefinitions[Name] & {
    handler: (
      input: z.output<WindowDefinitions[Name]["input"]>,
      context: NativeHandlerContext<NativeAdapter>,
    ) =>
      | z.input<WindowDefinitions[Name]["output"]>
      | Promise<z.input<WindowDefinitions[Name]["output"]>>;
  };
};

/** Preserve the window coordinator's live authority checks behind each declared operation. */
function operation<Name extends keyof WindowDefinitions>(
  name: Name,
): PlatformOperations<Name>[Name] {
  const definition = windowDefinitions[name];
  return {
    ...definition,
    handler(
      input: JsonValue,
      {
        instance,
        source,
        requestId,
        permissions,
        signal,
      }: NativeHandlerContext<NativeAdapter>,
    ) {
      if (!instance.executeUI || !requestId || !permissions) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Window control requires a host call context.",
        });
      }
      // Dynamic window results are checked against this operation's output schema by the SDK.
      return instance.executeUI(`windows.${name}`, input, source, {
        requestId,
        permissions,
        ...(signal
          ? {
              signal,
            }
          : {}),
      }) as
        | z.input<WindowDefinitions[Name]["output"]>
        | Promise<z.input<WindowDefinitions[Name]["output"]>>;
    },
  } as PlatformOperations<Name>[Name];
}

// Every key comes from the complete local window schema inventory.
const windowsOperations = Object.fromEntries(
  Object.keys(windowDefinitions).map((name) => [
    name,
    operation(name as keyof WindowDefinitions),
  ]),
) as PlatformOperations<keyof WindowDefinitions>;

const macosOperations = {
  list: operation("list"),
  create: operation("create"),
  recreate: operation("recreate"),
  show: operation("show"),
  hide: operation("hide"),
  focus: operation("focus"),
  close: operation("close"),
  isVisible: operation("isVisible"),
  isFocused: operation("isFocused"),
  isDestroyed: operation("isDestroyed"),
  getWebViewState: operation("getWebViewState"),
  navigateWebView: operation("navigateWebView"),
  reloadWebView: operation("reloadWebView"),
  stopWebView: operation("stopWebView"),
  goBack: operation("goBack"),
  goForward: operation("goForward"),
  setZoomFactor: operation("setZoomFactor"),
};

function dispose(instance: NativeAdapter) {
  return instance.dispose();
}

function busy(instance: NativeAdapter): boolean {
  return instance.busy?.() ?? false;
}

/** Typed helpers for invoking the registered window operations. */
export default defineNativePlugin(
  {
    events: windowEvents,
    name: "windows",
    platforms: {
      windows: {
        thread: "ui",
        initialize: createWindowsOperations,
        dispose,
        busy,
        operations: windowsOperations,
      },
      macos: {
        thread: "ui",
        initialize: createMacosOperations,
        dispose,
        busy,
        // macOS supplies basic window and WebView services; geometry, identity and readiness remain unsupported.
        operations: macosOperations,
      },
    },
  },
  createWindows,
);

export type {
  WindowCall,
  WindowEvents,
  WindowInput,
  WindowOperation,
  WindowOutput,
} from "./contract.ts";
export {
  isWindowOperation,
  parseWindowCall,
  validateWindowCall,
  validateWindowOutput,
  windowEvents,
  windowOperations,
  windowReadinessSchema,
  windowSnapshotSchema,
} from "./contract.ts";

export type { Monitor, MonitorSnapshot } from "./monitor-contract.ts";
export {
  monitorChangeSchema,
  monitorSchema,
  monitorSnapshotSchema,
} from "./monitor-contract.ts";
