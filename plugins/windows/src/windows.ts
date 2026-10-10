import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import {
  hasValidWindowSizeConstraints,
  type WindowSizeConstraints,
} from "@bunaway/plugin-api/native";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { validateWindowCall, type WindowCall } from "./contract.ts";
import { WindowOperations } from "./coordinator.ts";
import { windowsPlugin } from "./index.ts";
import { matches } from "./scope.ts";

/** Create the UI-worker adapter; throws when window services are unavailable. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  if (!environment.windows) {
    throw new Error("Window services require the UI thread.");
  }
  const services = environment.windows;
  function applyWindow(
    call: WindowCall,
    viewId: string,
  ): JsonValue | Promise<JsonValue> {
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
      case "windows.minimize":
      case "windows.maximize":
      case "windows.unmaximize":
      case "windows.restore":
      case "windows.toggleMaximize":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing window state.",
          });
        }
        switch (call.operation) {
          case "windows.minimize":
            window.minimize();
            break;
          case "windows.maximize":
            window.maximize();
            break;
          case "windows.unmaximize":
            window.unmaximize();
            break;
          case "windows.restore":
            window.restore();
            break;
          case "windows.toggleMaximize":
            window.toggleMaximize();
            break;
        }
        break;
      case "windows.isMinimized":
        return window.isMinimized();
      case "windows.isMaximized":
        return window.isMaximized();
      case "windows.isFullscreen":
        return window.isFullscreen();
      case "windows.isVisible":
        return window.isVisible();
      case "windows.isFocused":
        return window.isFocused();
      case "windows.setSize":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing size.",
          });
        }
        window.setSize(call.payload.width, call.payload.height);
        break;
      case "windows.getMinSize": {
        const constraints = window.getSizeConstraints();
        return {
          width: constraints.minWidth,
          height: constraints.minHeight,
        };
      }
      case "windows.getMaxSize": {
        const constraints = window.getSizeConstraints();
        return {
          width: constraints.maxWidth,
          height: constraints.maxHeight,
        };
      }
      case "windows.setMinSize": {
        const constraints = window.getSizeConstraints();
        const next: WindowSizeConstraints = {
          ...constraints,
          minWidth: call.payload.width,
          minHeight: call.payload.height,
        };
        if (!hasValidWindowSizeConstraints(next)) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Minimum window size cannot exceed the maximum size.",
          });
        }
        window.setSizeConstraints(next);
        break;
      }
      case "windows.setMaxSize": {
        const constraints = window.getSizeConstraints();
        const next: WindowSizeConstraints = {
          ...constraints,
          maxWidth: call.payload.width,
          maxHeight: call.payload.height,
        };
        if (!hasValidWindowSizeConstraints(next)) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message:
              "Maximum window size cannot be smaller than the minimum size.",
          });
        }
        window.setSizeConstraints(next);
        break;
      }
      case "windows.getSizeConstraints":
        return {
          ...window.getSizeConstraints(),
        };
      case "windows.setSizeConstraints": {
        // Omitted bounds mean no limit; validate the complete pair before changing either bound.
        const next: WindowSizeConstraints = {
          minWidth: call.payload.minWidth ?? null,
          minHeight: call.payload.minHeight ?? null,
          maxWidth: call.payload.maxWidth ?? null,
          maxHeight: call.payload.maxHeight ?? null,
        };
        if (!hasValidWindowSizeConstraints(next)) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Minimum window size cannot exceed the maximum size.",
          });
        }
        window.setSizeConstraints(next);
        break;
      }
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
      // Check permission before resolving configuration so unknown views do not bypass denial.
      const targets =
        call.operation === "windows.list"
          ? services.specs.map((spec) => spec.view)
          : [
              call.payload.view,
            ];
      const grants = targets.filter((view) =>
        registry.allowed(
          context.permissions,
          {
            operation: "windows.show",
            payload: {
              view,
            },
          },
          matches,
        ),
      );
      return operations.execute(call, grants, context.requestId);
    },
    busy: () => operations.replacing.size !== 0,
    dispose() {},
  };
}
