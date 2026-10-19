import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import type {
  NativeWindowServices,
  WindowIdentity,
} from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { validateWindowCall, type WindowCall } from "#windows/contract";
import { WindowOperations } from "#windows/platforms/coordinator";
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
type IdentityLookupCall = Extract<
  WindowCall,
  {
    operation:
      | "windows.getById"
      | "windows.getCurrent"
      | "windows.getFocused"
      | "windows.getLastActive";
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

function isIdentityLookupCall(call: WindowCall): call is IdentityLookupCall {
  return (
    call.operation === "windows.getById" ||
    call.operation === "windows.getCurrent" ||
    call.operation === "windows.getFocused" ||
    call.operation === "windows.getLastActive"
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
  if (
    (call.operation === "windows.list" ||
      call.operation === "windows.listInstances") &&
    !permitted
  ) {
    throw denied("Window listing permission required.");
  }
  if (
    call.operation === "windows.destroy" &&
    (source !== "backend" || !permitted)
  ) {
    throw denied("Trusted backend destroy permission required.");
  }
  if (call.operation === "windows.setParent" && !permitted) {
    throw denied("Window relationship policy denied.");
  }
  // Check permission before resolving configuration so unknown views do not bypass denial.
  if (!permitted) {
    throw denied("Window policy denied.");
  }
}

/** A parent must be an open native lifetime that is not being recreated. */
function assertParentOpen(scope: WindowActionContext, parentId: string): void {
  const { services } = scope;
  const parent = services.lookup?.byId(parentId);
  if (!parent || services.read(scope.identityKey(parent))?.closed !== false) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Parent window lifetime is not open.",
    });
  }
  if (scope.isReplacing(scope.identityKey(parent))) {
    throw new BunawayError({
      code: "BUSY",
      message: "Parent window is being recreated.",
    });
  }
}

/**
 * The window that made a `windows.getCurrent` call: none for the backend, otherwise the window
 * of the calling view, confirmed by the authenticated request when the platform provides one.
 */
function callerIdentity(
  scope: WindowActionContext,
  lookup: NonNullable<NativeWindowServices["lookup"]>,
  source: string,
  requestId: string,
): WindowIdentity | null {
  const { services } = scope;
  if (source === "backend") {
    return null;
  }
  const viewId = source.startsWith("view:") ? source.slice("view:".length) : "";
  if (!services.specs.some((spec) => spec.view === viewId)) {
    throw denied("Invalid window call source.");
  }
  // Host request IDs are mapped to authenticated contexts by the UI owner.
  if (lookup.byRequest) {
    const identity = lookup.byRequest(requestId);
    if (identity && identity.viewId !== viewId) {
      throw denied("Window source does not match its authenticated request.");
    }
    return identity;
  }
  if (services.read(viewId)?.closed === false && !scope.isReplacing(viewId)) {
    return lookup.byView(viewId);
  }
  return null;
}

/**
 * Answer an identity lookup. Identifiers of denied, closed or recreating views are never exposed,
 * and a lookup never falls back to another window.
 */
function lookupWindow(
  scope: WindowActionContext,
  call: IdentityLookupCall,
  source: string,
  requestId: string,
): JsonValue {
  const { services } = scope;
  if (services.stopping() || services.cancelled(requestId)) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Window request cancelled.",
    });
  }
  const lookup = services.lookup;
  if (!lookup) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Window identity lookup is not implemented on this platform.",
    });
  }
  let identity: WindowIdentity | null = null;
  switch (call.operation) {
    case "windows.getById":
      identity = lookup.byId(call.payload.windowId);
      break;
    case "windows.getCurrent":
      identity = callerIdentity(scope, lookup, source, requestId);
      break;
    case "windows.getFocused":
      identity = lookup.focused();
      break;
    case "windows.getLastActive":
      identity = lookup.lastActive();
      break;
  }
  if (
    !identity ||
    !services.specs.some((spec) => spec.view === identity.viewId) ||
    services.read(scope.identityKey(identity))?.closed !== false ||
    scope.isReplacing(scope.identityKey(identity))
  ) {
    return null;
  }
  return {
    ...identity,
  };
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
    isReplacing: (key) => operations.replacing.has(key),
    identityKey,
  };
  const operations = new WindowOperations(services.specs, {
    ...services,
    apply: (call, viewId) => applyWindowCall(scope, call, viewId),
  });
  function identityKey(identity: WindowIdentity): string {
    return services.instances
      ? (operations.resolveKey(identity.viewId, identity.windowId) ??
          identity.viewId)
      : identity.viewId;
  }
  /**
   * Allows a close answer only from the trusted backend or from the document that was asked.
   * Request IDs are small increasing integers, so permission alone would let another window's
   * document approve a close and bypass that window's confirmation. The caller is identified by the
   * authenticated document session behind the host request, never by the payload, and fails closed
   * when the platform cannot provide that identity.
   */
  function assertAskedWindowAnswers(
    target: {
      view: string;
      windowId?: string;
    },
    source: string,
    requestId: string,
  ): void {
    if (source === "backend") {
      return;
    }
    const caller = services.lookup?.byRequest?.(requestId);
    if (
      !caller ||
      source !== `view:${caller.viewId}` ||
      caller.viewId !== target.view ||
      identityKey(caller) !==
        operations.resolveKey(target.view, target.windowId)
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
      if (call.operation === "windows.respondClose") {
        assertAskedWindowAnswers(call.payload, source, context.requestId);
      }
      if (
        call.operation === "windows.setParent" &&
        call.payload.parent !== null
      ) {
        assertParentOpen(scope, call.payload.parent);
      }
      if (isIdentityLookupCall(call)) {
        return lookupWindow(scope, call, source, context.requestId);
      }
      if (
        call.operation === "windows.completeSplashscreen" &&
        source === `view:${call.payload.splash}`
      ) {
        // Closing the caller's WebView revokes its route before the result can be delivered.
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message:
            "Complete the splashscreen handoff from the main window or backend.",
        });
      }
      return operations.execute(call, context.requestId);
    },
    busy: () => operations.replacing.size !== 0,
    dispose() {},
  };
}
