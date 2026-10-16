/** A live HWND capability. The host invalidates it before destruction. */
export type NativeAppearanceWindow = {
  windowId: string;
  /** Apply DWM frame dark mode; false restores light/default frame rendering. */
  setDark(dark: boolean): void;
};
/** Optional UI service. A subscription owns DLL lifetime and resets frames on disposal. */
export type NativeAppearanceWindows = {
  /** Receive existing and future windows. Each returned callback retires that exact lifetime. */
  subscribe(
    receive: (window: NativeAppearanceWindow) => () => void,
  ): () => void;
};
