import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import { validateWindowCall, type WindowCall } from "./contract.ts";
import { WindowOperations } from "./coordinator.ts";
import { windowsPlugin } from "./index.ts";
import { matches } from "./scope.ts";
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  if (!environment.windows) {
    throw new Error("Window services require the UI thread.");
  }
  const services = environment.windows;
  const registry = new NativeRegistry([
    windowsPlugin,
  ]);
  const operations = new WindowOperations(services.specs, {
    ...services,
    apply: applyWindow,
  });
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Window control requires UI execution.",
      });
    },
    executeUI(operation, input, _source, context) {
      const call = validateWindowCall({
        operation,
        payload: input,
      });
      const grants = services.specs
        .filter((spec) =>
          registry.allowed(
            context.permissions,
            {
              operation: "windows.show",
              payload: {
                view: spec.view,
              },
            },
            matches,
          ),
        )
        .map((spec) => spec.view);
      return operations.execute(call, grants, context.requestId);
    },
    busy: () => operations.replacing.size !== 0,
    dispose() {},
  };
  function applyWindow(call: WindowCall, viewId: string) {
    const window = services.window(viewId);
    switch (call.operation) {
      case "windows.show":
        window.show(true);
        break;
      case "windows.hide":
        window.show(false);
        break;
      case "windows.focus":
        if (!window.focus()) {
          throw new BunawayError({
            code: "BUSY",
            message: "OS declined window focus.",
          });
        }
        break;
      case "windows.close":
        return window.close();
      case "windows.setSize":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing size.",
          });
        }
        window.setSize(call.payload.width, call.payload.height);
        break;
      case "windows.setPosition":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing position.",
          });
        }
        window.setPosition(call.payload.x, call.payload.y);
        break;
      case "windows.setFullscreen":
        window.setFullscreen(call.payload.fullscreen);
        break;
      case "windows.setCloseConfirmation":
        window.setCloseConfirmation(call.payload.message);
        break;
      default:
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Expected a window operation.",
        });
    }
    return null;
  }
}
