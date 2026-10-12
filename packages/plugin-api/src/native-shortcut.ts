/** Host-owned hidden HWNDs and event routing used by the optional global shortcut adapter. */
export type NativeShortcutServices = {
  /** Creates an invisible window on the existing UI thread. The adapter owns its release. */
  createWindow(
    receive: (message: number, wparam: bigint, lparam: bigint) => void,
  ): bigint;
  /** Destroys an adapter-owned hidden window without changing app residency policy. */
  destroyWindow(hwnd: bigint): void;
  /** Uses existing per-view policy and subscription checks before delivering native events. */
  emit(event: string, payload: import("@bunaway/protocol").JsonValue): void;
};
