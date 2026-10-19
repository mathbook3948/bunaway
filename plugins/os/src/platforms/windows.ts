import { dlopen, ptr } from "bun:ffi";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import {
  arch,
  cpus,
  freemem,
  hostname,
  release,
  totalmem,
  type,
  version,
} from "node:os";
import { BunawayError } from "@bunaway/protocol";
import type { OSInstance } from "#os/contract";

const LOCALE_NAME_MAX_LENGTH = 85;
const LOCALE_SISO3166CTRYNAME = 0x5a;
const MUI_LANGUAGE_NAME = 0x8;
const MAX_LANGUAGE_BUFFER_CHARS = 128 * (LOCALE_NAME_MAX_LENGTH + 1) + 1;

/** MessageBeep sound types; MB_OK (0x0) plays the sound scheme's Default Beep. */
const BEEP_SOUND_TYPES = {
  default: 0x0,
  info: 0x40,
  warning: 0x30,
  error: 0x10,
} as const;

function failure(): never {
  throw new BunawayError({
    code: "INTERNAL",
    message: "Windows locale query failed.",
  });
}

function openUser32() {
  return dlopen("user32.dll", {
    MessageBeep: {
      args: [
        "u32",
      ],
      returns: "i32",
    },
  });
}

/** Own Kernel32 locale and user32 MessageBeep bindings on the host I/O worker and close them on host shutdown. */
export function initialize(): OSInstance {
  const api = dlopen("kernel32.dll", {
    ...pick(KERNEL32, "GetCurrentProcess"),
    IsWow64Process2: {
      args: [
        "u64",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    GetUserDefaultLocaleName: {
      args: [
        "ptr",
        "i32",
      ],
      returns: "i32",
    },
    GetLocaleInfoEx: {
      args: [
        "ptr",
        "u32",
        "ptr",
        "i32",
      ],
      returns: "i32",
    },
    GetSystemDefaultUILanguage: {
      args: [],
      returns: "u16",
    },
    LCIDToLocaleName: {
      args: [
        "u32",
        "ptr",
        "i32",
        "u32",
      ],
      returns: "i32",
    },
    GetUserPreferredUILanguages: {
      args: [
        "u32",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
  let user32: ReturnType<typeof openUser32>;
  try {
    user32 = openUser32();
  } catch (error) {
    // Do not leak the already opened Kernel32 handle when initialization fails.
    api.close();
    throw error;
  }
  let disposed = false;
  const assertActive = () => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "OS adapter is disposed.",
      });
    }
  };
  const readText = (buffer: Buffer, chars: number) => {
    if (
      chars < 1 ||
      chars > buffer.length / 2 ||
      buffer.readUInt16LE((chars - 1) * 2) !== 0
    ) {
      failure();
    }
    return buffer.toString("utf16le", 0, (chars - 1) * 2);
  };
  function locale() {
    const user = Buffer.alloc(LOCALE_NAME_MAX_LENGTH * 2);
    const locale = readText(
      user,
      api.symbols.GetUserDefaultLocaleName(ptr(user), LOCALE_NAME_MAX_LENGTH),
    );
    const country = Buffer.alloc(4 * 2);
    const countryCode =
      readText(
        country,
        api.symbols.GetLocaleInfoEx(
          ptr(user),
          LOCALE_SISO3166CTRYNAME,
          ptr(country),
          4,
        ),
      ) || null;
    const system = Buffer.alloc(LOCALE_NAME_MAX_LENGTH * 2);
    const language = api.symbols.GetSystemDefaultUILanguage();
    if (language === 0) {
      failure();
    }
    const systemLanguage = readText(
      system,
      api.symbols.LCIDToLocaleName(
        language,
        ptr(system),
        LOCALE_NAME_MAX_LENGTH,
        0,
      ),
    );
    // Size is in WCHARs, includes both trailing NULs, and can change between queries.
    const count = new Uint32Array(1);
    const size = new Uint32Array(1);
    if (
      !api.symbols.GetUserPreferredUILanguages(
        MUI_LANGUAGE_NAME,
        ptr(count),
        null,
        ptr(size),
      )
    ) {
      failure();
    }
    const capacity = size[0] ?? 0;
    if (capacity < 2 || capacity > MAX_LANGUAGE_BUFFER_CHARS) {
      failure();
    }
    const languages = Buffer.alloc(capacity * 2);
    if (
      !api.symbols.GetUserPreferredUILanguages(
        MUI_LANGUAGE_NAME,
        ptr(count),
        ptr(languages),
        ptr(size),
      )
    ) {
      failure();
    }
    const chars = size[0] ?? 0;
    if (
      chars < 2 ||
      chars > capacity ||
      languages.readUInt32LE((chars - 2) * 2) !== 0
    ) {
      failure();
    }
    const preferredLanguages = languages
      .toString("utf16le", 0, (chars - 2) * 2)
      .split("\0")
      .filter(Boolean);
    if (preferredLanguages.length !== count[0]) {
      failure();
    }
    return {
      locale,
      countryCode,
      preferredLanguages,
      systemLanguage,
    };
  }
  return {
    usage() {
      assertActive();
      const processMachine = new Uint16Array(1);
      const nativeMachine = new Uint16Array(1);
      if (
        !api.symbols.IsWow64Process2(
          api.symbols.GetCurrentProcess(),
          ptr(processMachine),
          ptr(nativeMachine),
        )
      ) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows process architecture query failed.",
        });
      }
      const cpu = process.cpuUsage();
      return {
        pid: process.pid,
        logicalCpuCount: cpus().length,
        cpuTime: {
          userMicros: cpu.user,
          systemMicros: cpu.system,
        },
        memory: {
          systemTotalBytes: totalmem(),
          systemFreeBytes: freemem(),
          processResidentBytes: process.memoryUsage.rss(),
        },
        translation: {
          active: processMachine[0] !== 0,
          processMachine: processMachine[0] ?? 0,
          nativeMachine: nativeMachine[0] ?? 0,
        },
      };
    },
    beep(kind: keyof typeof BEEP_SOUND_TYPES) {
      assertActive();
      if (!user32.symbols.MessageBeep(BEEP_SOUND_TYPES[kind])) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows beep failed.",
        });
      }
      return null;
    },
    locale() {
      assertActive();
      return locale();
    },
    info() {
      assertActive();
      return {
        platform: "windows" as const,
        type: type(),
        release: release(),
        version: version(),
        architecture: arch(),
        hostname: hostname(),
        runtime: {
          name: "bun" as const,
          version: Bun.version,
          pid: process.pid,
        },
      };
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        user32.close();
        api.close();
      }
    },
  };
}

export function dispose(instance: OSInstance) {
  instance.dispose();
}
