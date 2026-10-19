import { attemptAll } from "@bunaway/plugin";
import type {
  NativeAppearanceWindow,
  NativeContentColorScheme,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type {
  AccessibilityState,
  AppearancePreferences,
  ThemePreference,
  ThemeState,
} from "#appearance/contract";

type WindowEntry = {
  native: NativeAppearanceWindow;
  override: ThemePreference | null;
  supported: boolean;
  effectiveTheme: ThemeState["effectiveTheme"];
};
type Reader = {
  read(): AppearancePreferences;
  /** Absent in query-only readers that cannot probe UI Automation. */
  readAccessibilityState?(): AccessibilityState;
  dispose(): void;
};
/** Plugin lifetime owns the requested state, deduplicated OS snapshots and native subscriptions. */
export function createAppearanceController(
  reader: Reader,
  services?: Pick<NativeWindowServices, "appearance" | "systemEvents">,
) {
  let appPreference: ThemePreference = "system";
  let preferences = reader.read();
  let lastPublished = JSON.stringify(preferences);
  let disposed = false;
  const windows = new Map<string, WindowEntry>();
  const active = () => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Appearance adapter is disposed.",
      });
    }
  };
  const resolvedTheme = (
    preference: ThemePreference,
  ): ThemeState["effectiveTheme"] => {
    if (preferences.highContrast) {
      return null;
    }
    return preference === "system" ? preferences.appsTheme : preference;
  };
  const state = (entry?: WindowEntry): ThemeState => {
    const override = entry?.override ?? null;
    const preference = override ?? appPreference;
    return {
      preference,
      override,
      effectiveTheme: entry ? entry.effectiveTheme : resolvedTheme(preference),
      highContrast: preferences.highContrast,
    };
  };
  /** `system` and high contrast leave the content on the OS setting, as a pinned scheme would hide it. */
  const contentScheme = (
    preference: ThemePreference,
  ): NativeContentColorScheme =>
    preference === "system" || preferences.highContrast ? "auto" : preference;
  const apply = (entry: WindowEntry) => {
    const preference = entry.override ?? appPreference;
    const effectiveTheme = resolvedTheme(preference);
    entry.native.setDark(effectiveTheme === "dark");
    entry.native.setContentColorScheme(contentScheme(preference));
    // Failed native applications must not masquerade as the effective frame state.
    entry.effectiveTheme = effectiveTheme;
  };
  let releaseWindows: (() => void) | undefined;
  let releaseSignals: (() => void) | undefined;
  try {
    releaseWindows = services?.appearance?.subscribe((native) => {
      const entry: WindowEntry = {
        native,
        override: null,
        supported: true,
        effectiveTheme: null,
      };
      try {
        apply(entry);
      } catch (error) {
        // Older Windows builds can still query OS preferences and receive changes.
        if (!(error instanceof BunawayError) || error.code !== "UNSUPPORTED") {
          throw error;
        }
        entry.supported = false;
      }
      windows.set(native.windowId, entry);
      return () => {
        windows.delete(native.windowId);
      };
    });
    releaseSignals = services?.systemEvents?.subscribe((signal) => {
      if (
        disposed ||
        ![
          "settingChanged",
          "themeChanged",
          "colorsChanged",
          "accentChanged",
          "resume",
        ].includes(signal)
      ) {
        return;
      }
      const next = reader.read();
      const serialized = JSON.stringify(next);
      const changed = serialized !== lastPublished;
      preferences = next;
      // Reapply even for equal snapshots: theme broadcasts can reset DWM attributes.
      const failures: unknown[] = [];
      for (const entry of windows.values()) {
        if (entry.supported) {
          try {
            apply(entry);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (changed) {
        services.systemEvents?.publish(
          "appearance.changed",
          preferences,
          "appearance.getPreferences",
        );
        lastPublished = serialized;
      }
      if (failures.length) {
        throw new AggregateError(failures, "Appearance refresh failed.");
      }
    });
  } catch (error) {
    releaseSignals?.();
    releaseWindows?.();
    throw error;
  }
  const requireWindow = (windowId: string) => {
    const entry = windows.get(windowId);
    if (!entry) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Appearance window is unknown or destroyed.",
      });
    }
    if (!entry.supported) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message:
          "This Windows version does not support native frame appearance.",
      });
    }
    return entry;
  };
  const supported = () => {
    active();
    if (!releaseWindows) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Native frame appearance services are unavailable.",
      });
    }
  };
  /**
   * Change the app-wide preference and apply it to every window without its own override. When a
   * window fails, the previous preference is restored and re-applied to the remaining windows.
   */
  const setAppPreference = (theme: ThemePreference | null) => {
    if (theme === null) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "The app preference cannot be null.",
      });
    }
    const previous = appPreference;
    appPreference = theme;
    try {
      for (const entry of windows.values()) {
        if (entry.override === null) {
          apply(entry);
        }
      }
    } catch (error) {
      appPreference = previous;
      const failures: unknown[] = [
        error,
      ];
      for (const entry of windows.values()) {
        if (entry.override === null && entry.supported) {
          try {
            apply(entry);
          } catch (rollback) {
            failures.push(rollback);
          }
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Appearance change and rollback failed.",
        );
      }
      throw error;
    }
    return state();
  };
  return {
    read() {
      active();
      return reader.read();
    },
    getAccessibilityState() {
      active();
      if (!reader.readAccessibilityState) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Accessibility state is unavailable.",
        });
      }
      return reader.readAccessibilityState();
    },
    getTheme(windowId: string | null) {
      supported();
      return state(windowId === null ? undefined : requireWindow(windowId));
    },
    setTheme(windowId: string | null, theme: ThemePreference | null) {
      supported();
      if (windowId === null) {
        return setAppPreference(theme);
      }
      const entry = requireWindow(windowId);
      const previous = entry.override;
      entry.override = theme;
      try {
        apply(entry);
      } catch (error) {
        entry.override = previous;
        throw error;
      }
      return state(entry);
    },
    dispose() {
      disposed = true;
      attemptAll(
        [
          () => {
            releaseSignals?.();
            releaseSignals = undefined;
          },
          () => {
            releaseWindows?.();
            releaseWindows = undefined;
          },
          () => {
            windows.clear();
            reader.dispose();
          },
        ],
        "Appearance cleanup failed.",
      );
    },
  };
}
