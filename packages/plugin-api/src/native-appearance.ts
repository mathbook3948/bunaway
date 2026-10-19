/** WebView2 `PreferredColorScheme`: `auto` follows the OS app theme. */
export type NativeContentColorScheme = "auto" | "light" | "dark";
/** A live HWND capability. The host invalidates it before destruction. */
export type NativeAppearanceWindow = {
  windowId: string;
  /** Apply DWM frame dark mode; false restores light/default frame rendering. */
  setDark(dark: boolean): void;
  /**
   * Set the `prefers-color-scheme` of the window's web content. WebView2 stores it per profile, so
   * windows sharing a profile share the last value. A runtime without profile color schemes keeps
   * the frame change and skips the content.
   */
  setContentColorScheme(scheme: NativeContentColorScheme): void;
};
/** Optional UI service. A subscription owns DLL lifetime and resets frames on disposal. */
export type NativeAppearanceWindows = {
  /** Receive existing and future windows. Each returned callback retires that exact lifetime. */
  subscribe(
    receive: (window: NativeAppearanceWindow) => () => void,
  ): () => void;
};
