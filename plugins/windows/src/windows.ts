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
    grants: readonly string[],
  ): JsonValue | Promise<JsonValue> {
    const window = services.window(viewId);
    switch (call.operation) {
      case "windows.getSnapshot":
        return {
          ...window.getSnapshot(),
        };
      case "windows.show":
        window.show(true);
        break;
      case "windows.showInactive":
        window.showInactive();
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
      case "windows.activate":
        return window.activate();
      case "windows.blur": {
        if (window.isMinimized() || !window.isVisible()) {
          return !window.isFocused();
        }
        if (!window.isFocused()) {
          return true;
        }
        // Configuration order is deterministic; never activate an ungranted or external window.
        for (const spec of services.specs) {
          if (spec.view === viewId || !grants.includes(spec.view)) {
            continue;
          }
          const state = services.read(spec.view);
          if (
            !state ||
            state.closed ||
            !state.ready ||
            state.failure ||
            operations.replacing.has(spec.view)
          ) {
            continue;
          }
          const next = services.window(spec.view);
          if (next.isVisible() && !next.isMinimized()) {
            next.activate();
            return !window.isFocused();
          }
        }
        return false;
      }
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
      case "windows.setContentPosition":
      case "windows.setOuterSize":
      case "windows.setContentBounds":
      case "windows.setOuterBounds": {
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing window geometry.",
          });
        }
        const { view: _view, unit, ...geometry } = call.payload;
        const physical =
          unit === "logical"
            ? convertGeometry(geometry, window.getDpi(), "physical")
            : geometry;
        window.setGeometry(
          call.operation.startsWith("windows.setContent") ? "content" : "outer",
          physical,
        );
        break;
      }
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
      if (call.operation === "windows.blur") {
        targets.push(
          ...services.specs
            .filter((spec) => spec.view !== call.payload.view)
            .map((spec) => spec.view),
        );
      }
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
