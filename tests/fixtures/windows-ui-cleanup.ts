/** Shared counters observe cleanup performed inside the production UI Worker. */
export const uiCleanupSlots = {
  tray: 0,
  adapter: 1,
  com: 2,
  windows: 3,
  apartment: 4,
  bindings: 5,
};

/** Controls and per-window counts for lifecycle tests, separate from host teardown counts. */
export const uiLifecycleSlots = {
  confirmClose: 0,
  confirmations: 1,
  holdProfileReuse: 2,
  detach: 3,
  finish: 4,
  destroy: 5,
  close: 6,
  inputRestoreFailures: 7,
  inputRestores: 8,
  /** Test sets 1 after storing the message fields; the fixture pump consumes and clears it. */
  sessionRequest: 9,
  sessionMessage: 10,
  sessionWparam: 11,
  /** Unsigned 32-bit lParam stored as Int32; the fixture reads it back with `>>> 0`. */
  sessionLparam: 12,
  /** Handler result, or -1 when it returned undefined. Valid once `sessionDone` is 1. */
  sessionResult: 13,
  sessionDone: 14,
  /** Test sets 1 after storing the web fields; the fixture pump runs the renderer action on the UI thread. */
  webRequest: 15,
  /** One of `uiWebRequestKinds`. */
  webKind: 16,
  /** HWND number of the live fixture window that receives the action. */
  webTarget: 17,
  /** UTF-8 byte length of the JSON message stored in the shared web message buffer. */
  webLength: 18,
  webDone: 19,
  /** Number of upcoming `detach` calls that fail with a recoverable download cleanup error. */
  detachFailures: 20,
};

/** Renderer-side actions the fixture can replay into the production UI owner. */
export const uiWebRequestKinds = {
  documentComplete: 1,
  message: 2,
  /** The WebView starts a navigation, which revokes the document's session. */
  navigation: 3,
  /** A non-forced user close of the target window. */
  close: 4,
};
