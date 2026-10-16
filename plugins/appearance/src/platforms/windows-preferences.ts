import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import type { AppearancePreferences } from "#appearance/contract";

const HKEY_CURRENT_USER = 0xffffffff80000001n;
const PERSONALIZE_KEY =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
const RRF_RT_REG_DWORD = 0x10;
const RRF_SUBKEY_WOW6464KEY = 0x10000;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_UNSUPPORTED_TYPE = 1630;
const SPI_GETHIGHCONTRAST = 0x42;
const SPI_GETSCREENREADER = 0x46;
const SPI_GETCLIENTAREAANIMATION = 0x1042;
const HCF_HIGHCONTRASTON = 1;
const HIGHCONTRASTW_SIZE = 16;
const COLOR_WINDOW = 5;
const COLOR_WINDOWTEXT = 8;
const COLOR_HIGHLIGHT = 13;
const COLOR_HIGHLIGHTTEXT = 14;
const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le");

function failure(
  message: string,
  code: "INTERNAL" | "PERMISSION_DENIED" = "INTERNAL",
): never {
  throw new BunawayError({
    code,
    message,
  });
}

/** Read user preferences without changing the registry, OS settings or renderer state. */
export function initialize() {
  const registry = dlopen("advapi32.dll", {
    RegGetValueW: {
      args: [
        "u64",
        "ptr",
        "ptr",
        "u32",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
  const loadUser = () =>
    dlopen("user32.dll", {
      SystemParametersInfoW: {
        args: [
          "u32",
          "u32",
          "ptr",
          "u32",
        ],
        returns: "i32",
      },
      GetSysColor: {
        args: [
          "i32",
        ],
        returns: "u32",
      },
    });
  const loadDwm = () =>
    dlopen("dwmapi.dll", {
      DwmGetColorizationColor: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    });
  let user: ReturnType<typeof loadUser>;
  let dwm: ReturnType<typeof loadDwm>;
  try {
    user = loadUser();
    try {
      dwm = loadDwm();
    } catch (error) {
      user.close();
      throw error;
    }
  } catch (error) {
    registry.close();
    throw error;
  }
  let disposed = false;
  function preference(name: string): number | null {
    const key = wide(PERSONALIZE_KEY);
    const value = wide(name);
    const data = Buffer.alloc(4);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(4);
    const status = registry.symbols.RegGetValueW(
      HKEY_CURRENT_USER,
      ptr(key),
      ptr(value),
      RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
      null,
      ptr(data),
      ptr(size),
    );
    if (
      status === ERROR_FILE_NOT_FOUND ||
      status === ERROR_PATH_NOT_FOUND ||
      status === ERROR_UNSUPPORTED_TYPE
    ) {
      return null;
    }
    if (status !== 0) {
      failure(
        "Windows appearance preference query failed.",
        status === ERROR_ACCESS_DENIED ? "PERMISSION_DENIED" : "INTERNAL",
      );
    }
    return size.readUInt32LE() === 4 ? data.readUInt32LE() : null;
  }
  function setting(action: number): boolean {
    const value = Buffer.alloc(4);
    if (!user.symbols.SystemParametersInfoW(action, 0, ptr(value), 0)) {
      failure("Windows accessibility preference query failed.");
    }
    return value.readUInt32LE() !== 0;
  }
  return {
    read(): AppearancePreferences {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Appearance adapter is disposed.",
        });
      }
      const highContrastInfo = Buffer.alloc(HIGHCONTRASTW_SIZE);
      highContrastInfo.writeUInt32LE(HIGHCONTRASTW_SIZE);
      if (
        !user.symbols.SystemParametersInfoW(
          SPI_GETHIGHCONTRAST,
          HIGHCONTRASTW_SIZE,
          ptr(highContrastInfo),
          0,
        )
      ) {
        failure("Windows high contrast query failed.");
      }
      const highContrast = Boolean(
        highContrastInfo.readUInt32LE(4) & HCF_HIGHCONTRASTON,
      );
      const accent = Buffer.alloc(4);
      const opaque = Buffer.alloc(4);
      if (dwm.symbols.DwmGetColorizationColor(ptr(accent), ptr(opaque)) < 0) {
        failure("Windows accent color query failed.");
      }
      const appsLight = booleanPreference(preference("AppsUseLightTheme"));
      const systemLight = booleanPreference(preference("SystemUsesLightTheme"));
      function theme(light: boolean | null) {
        if (light === null) {
          return null;
        }
        return light ? "light" : "dark";
      }
      return {
        appsTheme: theme(appsLight),
        systemTheme: theme(systemLight),
        accentColor: `#${(accent.readUInt32LE() & 0xffffff).toString(16).padStart(6, "0")}`,
        highContrast,
        forcedColors: highContrast,
        reducedMotion: !setting(SPI_GETCLIENTAREAANIMATION),
        transparencyEnabled: booleanPreference(
          preference("EnableTransparency"),
        ),
        screenReaderEnabled: setting(SPI_GETSCREENREADER),
        colors: {
          window: colorRef(user.symbols.GetSysColor(COLOR_WINDOW)),
          windowText: colorRef(user.symbols.GetSysColor(COLOR_WINDOWTEXT)),
          highlight: colorRef(user.symbols.GetSysColor(COLOR_HIGHLIGHT)),
          highlightText: colorRef(
            user.symbols.GetSysColor(COLOR_HIGHLIGHTTEXT),
          ),
        },
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      dwm.close();
      user.close();
      registry.close();
    },
  };
}

export function dispose(instance: ReturnType<typeof initialize>) {
  instance.dispose();
}

/** Registry preferences use 0/1; absent or unexpected values remain unknown. */
export function booleanPreference(value: number | null): boolean | null {
  if (value === 0) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  return null;
}
/** Format Win32 COLORREF (BGR bytes) as an RGB CSS color. */
export function colorRef(value: number): string {
  const red = value & 0xff;
  const green = (value >>> 8) & 0xff;
  const blue = (value >>> 16) & 0xff;
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, "0")}`;
}
