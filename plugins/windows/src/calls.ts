import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type { z } from "zod";
import type { windowDefinitions } from "#windows/contract";

type Definitions = typeof windowDefinitions;
type Input<Name extends keyof Definitions> = z.input<
  Definitions[Name]["input"]
>;

/**
 * Add call helpers to the typed operations. The app has one window, so an operation without data
 * takes no request and one whose request has only optional fields may omit it.
 */
export function createWindows(api: NativePluginAPI<Definitions>) {
  return {
    ...api,
    getMonitorSnapshot: (options?: NativeInvokeOptions) =>
      api.getMonitorSnapshot(null, options),
    getMonitors: (options?: NativeInvokeOptions) =>
      api.getMonitors(null, options),
    getPrimaryMonitor: (options?: NativeInvokeOptions) =>
      api.getPrimaryMonitor(null, options),
    getMonitor: (options?: NativeInvokeOptions) =>
      api.getMonitor(null, options),
    getCursorPosition: (options?: NativeInvokeOptions) =>
      api.getCursorPosition(null, options),
    getDownloads: (options?: NativeInvokeOptions) =>
      api.getDownloads(null, options),
    getWebViewState: (options?: NativeInvokeOptions) =>
      api.getWebViewState(null, options),
    reloadWebView: (options?: NativeInvokeOptions) =>
      api.reloadWebView(null, options),
    stopWebView: (options?: NativeInvokeOptions) =>
      api.stopWebView(null, options),
    goBack: (options?: NativeInvokeOptions) => api.goBack(null, options),
    goForward: (options?: NativeInvokeOptions) => api.goForward(null, options),
    openDevTools: (options?: NativeInvokeOptions) =>
      api.openDevTools(null, options),
    getWebViewAudioState: (options?: NativeInvokeOptions) =>
      api.getWebViewAudioState(null, options),
    hasCustomIcon: (options?: NativeInvokeOptions) =>
      api.hasCustomIcon(null, options),
    getReadiness: (options?: NativeInvokeOptions) =>
      api.getReadiness(null, options),
    getSnapshot: (options?: NativeInvokeOptions) =>
      api.getSnapshot(null, options),
    isOpen: (options?: NativeInvokeOptions) => api.isOpen(null, options),
    show: (options?: NativeInvokeOptions) => api.show(null, options),
    showInactive: (options?: NativeInvokeOptions) =>
      api.showInactive(null, options),
    hide: (options?: NativeInvokeOptions) => api.hide(null, options),
    focus: (options?: NativeInvokeOptions) => api.focus(null, options),
    activate: (options?: NativeInvokeOptions) => api.activate(null, options),
    minimize: (options?: NativeInvokeOptions) => api.minimize(null, options),
    maximize: (options?: NativeInvokeOptions) => api.maximize(null, options),
    unmaximize: (options?: NativeInvokeOptions) =>
      api.unmaximize(null, options),
    restore: (options?: NativeInvokeOptions) => api.restore(null, options),
    toggleMaximize: (options?: NativeInvokeOptions) =>
      api.toggleMaximize(null, options),
    isMinimized: (options?: NativeInvokeOptions) =>
      api.isMinimized(null, options),
    isMaximized: (options?: NativeInvokeOptions) =>
      api.isMaximized(null, options),
    isFullscreen: (options?: NativeInvokeOptions) =>
      api.isFullscreen(null, options),
    isVisible: (options?: NativeInvokeOptions) => api.isVisible(null, options),
    isFocused: (options?: NativeInvokeOptions) => api.isFocused(null, options),
    isNormal: (options?: NativeInvokeOptions) => api.isNormal(null, options),
    close: (options?: NativeInvokeOptions) => api.close(null, options),
    destroy: (options?: NativeInvokeOptions) => api.destroy(null, options),
    isEnabled: (options?: NativeInvokeOptions) => api.isEnabled(null, options),
    isFocusable: (options?: NativeInvokeOptions) =>
      api.isFocusable(null, options),
    getTitlebar: (options?: NativeInvokeOptions) =>
      api.getTitlebar(null, options),
    isAlwaysOnTop: (options?: NativeInvokeOptions) =>
      api.isAlwaysOnTop(null, options),
    moveTop: (options?: NativeInvokeOptions) => api.moveTop(null, options),
    moveToBottom: (options?: NativeInvokeOptions) =>
      api.moveToBottom(null, options),
    isSkipTaskbar: (options?: NativeInvokeOptions) =>
      api.isSkipTaskbar(null, options),
    isContentProtected: (options?: NativeInvokeOptions) =>
      api.isContentProtected(null, options),
    cancelAttention: (options?: NativeInvokeOptions) =>
      api.cancelAttention(null, options),
    isMinimizable: (options?: NativeInvokeOptions) =>
      api.isMinimizable(null, options),
    isMaximizable: (options?: NativeInvokeOptions) =>
      api.isMaximizable(null, options),
    isFullscreenable: (options?: NativeInvokeOptions) =>
      api.isFullscreenable(null, options),
    getOpacity: (options?: NativeInvokeOptions) =>
      api.getOpacity(null, options),
    hasShadow: (options?: NativeInvokeOptions) => api.hasShadow(null, options),
    hasRoundedCorners: (options?: NativeInvokeOptions) =>
      api.hasRoundedCorners(null, options),
    getBackgroundMaterial: (options?: NativeInvokeOptions) =>
      api.getBackgroundMaterial(null, options),
    getBackgroundColor: (options?: NativeInvokeOptions) =>
      api.getBackgroundColor(null, options),
    isIgnoreMouseEvents: (options?: NativeInvokeOptions) =>
      api.isIgnoreMouseEvents(null, options),
    isClosable: (options?: NativeInvokeOptions) =>
      api.isClosable(null, options),
    getTitle: (options?: NativeInvokeOptions) => api.getTitle(null, options),
    getAccessibleTitle: (options?: NativeInvokeOptions) =>
      api.getAccessibleTitle(null, options),
    isResizable: (options?: NativeInvokeOptions) =>
      api.isResizable(null, options),
    isMovable: (options?: NativeInvokeOptions) => api.isMovable(null, options),
    getAspectRatio: (options?: NativeInvokeOptions) =>
      api.getAspectRatio(null, options),
    startDragging: (options?: NativeInvokeOptions) =>
      api.startDragging(null, options),
    getMinSize: (options?: NativeInvokeOptions) =>
      api.getMinSize(null, options),
    getMaxSize: (options?: NativeInvokeOptions) =>
      api.getMaxSize(null, options),
    getSizeConstraints: (options?: NativeInvokeOptions) =>
      api.getSizeConstraints(null, options),
    showPrintUI: (
      input: Input<"showPrintUI"> = {},
      options?: NativeInvokeOptions,
    ) => api.showPrintUI(input, options),
    waitForLifecycle: (
      input: Input<"waitForLifecycle"> = {},
      options?: NativeInvokeOptions,
    ) => api.waitForLifecycle(input, options),
    waitForProcessFailure: (
      input: Input<"waitForProcessFailure"> = {},
      options?: NativeInvokeOptions,
    ) => api.waitForProcessFailure(input, options),
    create: (input: Input<"create"> = {}, options?: NativeInvokeOptions) =>
      api.create(input, options),
    recreate: (input: Input<"recreate"> = {}, options?: NativeInvokeOptions) =>
      api.recreate(input, options),
    requestAttention: (
      input: Input<"requestAttention"> = {},
      options?: NativeInvokeOptions,
    ) => api.requestAttention(input, options),
    getContentSize: (
      input: Input<"getContentSize"> = {},
      options?: NativeInvokeOptions,
    ) => api.getContentSize(input, options),
    getOuterSize: (
      input: Input<"getOuterSize"> = {},
      options?: NativeInvokeOptions,
    ) => api.getOuterSize(input, options),
    getContentPosition: (
      input: Input<"getContentPosition"> = {},
      options?: NativeInvokeOptions,
    ) => api.getContentPosition(input, options),
    getOuterPosition: (
      input: Input<"getOuterPosition"> = {},
      options?: NativeInvokeOptions,
    ) => api.getOuterPosition(input, options),
    getContentBounds: (
      input: Input<"getContentBounds"> = {},
      options?: NativeInvokeOptions,
    ) => api.getContentBounds(input, options),
    getOuterBounds: (
      input: Input<"getOuterBounds"> = {},
      options?: NativeInvokeOptions,
    ) => api.getOuterBounds(input, options),
    getNormalBounds: (
      input: Input<"getNormalBounds"> = {},
      options?: NativeInvokeOptions,
    ) => api.getNormalBounds(input, options),
    setSizeConstraints: (
      input: Input<"setSizeConstraints"> = {},
      options?: NativeInvokeOptions,
    ) => api.setSizeConstraints(input, options),
    center: (input: Input<"center"> = {}, options?: NativeInvokeOptions) =>
      api.center(input, options),
  };
}
