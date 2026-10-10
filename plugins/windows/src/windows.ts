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
import { convertGeometry } from "./window-geometry.ts";

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
      case "windows.getContentSize":
      case "windows.getOuterSize":
      case "windows.getContentPosition":
      case "windows.getOuterPosition":
      case "windows.getContentBounds":
      case "windows.getOuterBounds":
      case "windows.getNormalBounds": {
        let area: "content" | "outer" | "normal" = "outer";
        if (call.operation.startsWith("windows.getContent")) {
          area = "content";
        }
        if (call.operation === "windows.getNormalBounds") {
          area = "normal";
        }
        const { dpi, ...physical } = window.getBounds(area);
        const bounds =
          call.payload.unit === "logical"
            ? convertGeometry(physical, dpi, "logical")
            : physical;
        if (call.operation.endsWith("Size") && "width" in bounds) {
          return {
            width: bounds.width,
            height: bounds.height,
            dpi,
          };
        }
        if (call.operation.endsWith("Position") && "x" in bounds) {
          return {
            x: bounds.x,
            y: bounds.y,
            dpi,
          };
        }
        return {
          ...bounds,
          dpi,
        };
      }
      case "windows.toLogical":
      case "windows.toPhysical": {
        const dpi = window.getDpi();
        const unit =
          call.operation === "windows.toLogical" ? "logical" : "physical";
        return {
          value: convertGeometry(call.payload.value, dpi, unit),
          dpi,
        };
      }
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
      // Resolve each configured view's control grant before dispatching to the coordinator.
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
}
