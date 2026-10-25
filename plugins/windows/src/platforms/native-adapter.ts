import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import type { NativeWindowServices } from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { validateWindowCall, type WindowCall } from "#windows/contract";
import { WindowOperations } from "#windows/platforms/coordinator";
import {
  AudioChangeFeed,
  LifecycleFeed,
  ProcessFailureFeed,
} from "#windows/platforms/lifecycle-feed";
import {
  applyWindowCall,
  type WindowActionContext,
} from "#windows/platforms/window-actions";

type UiContext = NonNullable<
  Parameters<NonNullable<NativeAdapter["executeUI"]>>[3]
>;
type MonitorCall = Extract<
  WindowCall,
  {
    operation:
      | "windows.getMonitors"
      | "windows.getMonitorSnapshot"
      | "windows.getPrimaryMonitor"
      | "windows.getMonitorNearestPoint"
      | "windows.getMonitorNearestRect"
      | "windows.getCursorPosition";
  }
>;
/** Download controls are limited to the trusted backend, not to a document's own grants. */
const TRUSTED_DOWNLOAD_OPERATIONS: readonly string[] = [
  "windows.setDownloadRequestsEnabled",
  "windows.getDownloads",
  "windows.approveDownload",
  "windows.cancelDownload",
  "windows.pauseDownload",
  "windows.resumeDownload",
  "windows.forgetDownload",
];

function isMonitorCall(call: WindowCall): call is MonitorCall {
  return (
    call.operation === "windows.getMonitors" ||
    call.operation === "windows.getMonitorSnapshot" ||
    call.operation === "windows.getPrimaryMonitor" ||
    call.operation === "windows.getMonitorNearestPoint" ||
    call.operation === "windows.getMonitorNearestRect" ||
    call.operation === "windows.getCursorPosition"
  );
}

function denied(message: string): BunawayError {
  return new BunawayError({
    code: "PERMISSION_DENIED",
    message,
  });
}

/** Answer a display query after checking its grant, cancellation and platform support. */
function queryMonitors(
  services: NativeWindowServices,
  call: MonitorCall,
  context: UiContext,
): JsonValue {
  if (!context.permissions.permissions.includes(call.operation)) {
    throw denied("Monitor query permission required.");
  }
  if (services.stopping() || services.cancelled(context.requestId)) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Monitor query cancelled.",
    });
  }
  const monitors = services.monitors;
  if (!monitors) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Monitor queries are unavailable.",
    });
  }
  switch (call.operation) {
    case "windows.getMonitorSnapshot":
      if (!monitors.snapshot) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Monitor events are unavailable.",
        });
      }
      return {
        ...monitors.snapshot(),
      };
    case "windows.getMonitors":
      return monitors.list().map((monitor) => ({
        ...monitor,
      }));
    case "windows.getPrimaryMonitor":
      return {
        ...monitors.primary(),
      };
    case "windows.getMonitorNearestPoint":
      return {
        ...monitors.nearestPoint(call.payload),
      };
    case "windows.getMonitorNearestRect":
      return {
        ...monitors.nearestRect(call.payload),
      };
    case "windows.getCursorPosition":
      return {
        ...monitors.cursor(),
      };
  }
}

/**
 * Check the caller's grant for a window operation before the target view is resolved, so an
 * unknown view cannot bypass a denial. Destroy and downloads additionally need the backend.
 */
function assertCallerAllowed(
  call: WindowCall,
  source: string,
  granted: readonly string[],
): void {
  const permitted = granted.includes(call.operation);
  if (
    TRUSTED_DOWNLOAD_OPERATIONS.includes(call.operation) &&
    source !== "backend"
  ) {
    throw denied("WebView downloads require a trusted backend context.");
  }
  if (call.operation === "windows.waitForLifecycle") {
    // Only the backend subscribes, and the notification itself needs no grant.
    if (source !== "backend") {
      throw denied("Window lifecycle subscription requires the backend.");
    }
    return;
  }
  if (call.operation === "windows.waitForAudioChange") {
    if (source !== "backend") {
      throw denied("WebView audio subscription requires the backend.");
    }
    return;
  }
  if (call.operation === "windows.waitForProcessFailure") {
    if (source !== "backend") {
      throw denied(
        "WebView process failure subscription requires the backend.",
      );
    }
    return;
  }
  if (
    call.operation === "windows.destroy" &&
    (source !== "backend" || !permitted)
  ) {
    throw denied("Trusted backend destroy permission required.");
  }
  // Check permission before resolving configuration so unknown views do not bypass denial.
  if (!permitted) {
    throw denied("Window policy denied.");
  }
}

/** Create the UI-worker adapter; throws when window services are unavailable. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  if (!environment.windows) {
    throw new Error("Window services require the UI thread.");
  }
  const services = environment.windows;
  const scope: WindowActionContext = {
    services,
  };
  const operations = new WindowOperations(services.specs, {
    ...services,
    apply: (call, viewId) => applyWindowCall(scope, call, viewId),
  });
  const lifecycle = new LifecycleFeed(services.onLifecycle?.bind(services));
  const audioChanges = new AudioChangeFeed(
    services.onAudioChange?.bind(services),
  );
  const processFailures = new ProcessFailureFeed(
    services.onProcessFailure?.bind(services),
  );
  /**
   * Allows a close answer only from the trusted backend or from the document that was asked.
   * Request IDs are small increasing integers, so permission alone would let another document
   * approve a close and bypass the window's confirmation. The caller is identified by the
   * authenticated document session behind the host request, never by the payload, and fails closed
   * when the platform cannot provide that identity.
   */
  function assertAskedWindowAnswers(source: string, requestId: string): void {
    if (source === "backend") {
      return;
    }
    const caller = services.lookup?.byRequest?.(requestId);
    if (
      !caller ||
      source !== `view:${caller.viewId}` ||
      !services.specs.some((spec) => spec.view === caller.viewId)
    ) {
      throw denied(
        "Close requests are answered only by the asked window's document or the backend.",
      );
    }
  }
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Window control requires UI execution.",
      });
    },
    async executeUI(operation, input, source, context) {
      const call = validateWindowCall({
        operation,
        payload: input,
      });
      if (isMonitorCall(call)) {
        return queryMonitors(services, call, context);
      }
      assertCallerAllowed(call, source, context.permissions.permissions);
      if (call.operation === "windows.waitForLifecycle") {
        return {
          ...(await lifecycle.wait(call.payload.after, context.signal)),
        };
      }
      if (call.operation === "windows.waitForAudioChange") {
        return {
          ...(await audioChanges.wait(call.payload.after, context.signal)),
        };
      }
      if (call.operation === "windows.waitForProcessFailure") {
        return {
          ...(await processFailures.wait(call.payload.after, context.signal)),
        };
      }
      if (call.operation === "windows.respondClose") {
        assertAskedWindowAnswers(source, context.requestId);
      }
      return operations.execute(call, context.requestId);
    },
    busy: () => operations.replacing.size !== 0,
    dispose() {
      lifecycle.dispose();
      audioChanges.dispose();
      processFailures.dispose();
    },
  };
}
