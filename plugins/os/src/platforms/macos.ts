import { dlopen, type Pointer, ptr } from "bun:ffi";
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
import { ResourceOwner } from "@bunaway/plugin";
import {
  COREFOUNDATION,
  COREFOUNDATION_PATH,
  LIBSYSTEM_PATH,
} from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { OSInstance } from "#os/contract";
import { localeTag, machines, regionOf } from "#os/platforms/macos-locale";

const AUDIO_TOOLBOX =
  "/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox";
const UTF8_ENCODING = 0x08000100;
/** Longest language list the contract accepts. */
const MAX_LANGUAGES = 128;
/** Bytes for one locale text: the contract allows 85 characters, each at most four UTF-8 bytes. */
const TEXT_BUFFER_BYTES = 85 * 4 + 1;
/** `kSystemSoundID_UserPreferredAlert`: the alert sound chosen in System Settings. */
const USER_PREFERRED_ALERT = 0x1000;

/** Bun types a returned `ptr` as a number or a bigint address. */
type NativePointer = Pointer | bigint;

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

function unsupportedGpus(): never {
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "Graphics adapter queries are not supported on macOS.",
  });
}

function unsupportedAppProcesses(): never {
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "App process queries are not supported on macOS.",
  });
}

function unsupportedMediaAccess(): never {
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "Media access status queries are not supported on macOS.",
  });
}

function unsupportedPrinters(): never {
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "Printer queries are not supported on macOS.",
  });
}

/**
 * Own CoreFoundation, libSystem and AudioToolbox bindings on the host I/O worker and close them
 * on host shutdown. Every read copies values into JavaScript and releases the CoreFoundation
 * objects it created; nothing is cached, so locale changes show on the next call.
 */
export function initialize(): OSInstance {
  const owner = new ResourceOwner("macOS os adapter release failed.");
  const close = (library: { close(): void }) => library.close();
  const core = owner.acquire(
    () =>
      dlopen(COREFOUNDATION_PATH, {
        ...pick(COREFOUNDATION, "CFRelease"),
        CFArrayGetCount: {
          args: [
            "ptr",
          ],
          returns: "i64",
        },
        CFArrayGetValueAtIndex: {
          args: [
            "ptr",
            "i64",
          ],
          returns: "ptr",
        },
        CFLocaleCopyCurrent: {
          args: [],
          returns: "ptr",
        },
        CFLocaleCopyPreferredLanguages: {
          args: [],
          returns: "ptr",
        },
        CFLocaleGetIdentifier: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
        CFStringGetCString: {
          args: [
            "ptr",
            "ptr",
            "i64",
            "u32",
          ],
          returns: "bool",
        },
      } as const),
    close,
  );
  const system = owner.acquire(
    () =>
      dlopen(LIBSYSTEM_PATH, {
        sysctlbyname: {
          args: [
            "cstring",
            "ptr",
            "ptr",
            "ptr",
            "u64",
          ],
          returns: "i32",
        },
      } as const),
    close,
  );
  const audio = owner.acquire(
    () =>
      dlopen(AUDIO_TOOLBOX, {
        AudioServicesPlayAlertSound: {
          args: [
            "u32",
          ],
          returns: "void",
        },
      } as const),
    close,
  );
  const text = Buffer.alloc(TEXT_BUFFER_BYTES);
  const assertActive = () => {
    if (owner.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "OS adapter is disposed.",
      });
    }
  };
  /** A borrowed CFString as JavaScript text. */
  const stringOf = (value: NativePointer | null): string => {
    if (
      !value ||
      !core.symbols.CFStringGetCString(
        value,
        ptr(text),
        TEXT_BUFFER_BYTES,
        UTF8_ENCODING,
      )
    ) {
      return failure("macOS locale text is unavailable.");
    }
    return text.toString("utf8", 0, text.indexOf(0));
  };
  /** Run `read` on a CoreFoundation object this call owns and release it afterwards. */
  const owned = <T>(
    object: NativePointer | null,
    message: string,
    read: (object: NativePointer) => T,
  ): T => {
    if (!object) {
      return failure(message);
    }
    try {
      return read(object);
    } finally {
      core.symbols.CFRelease(object);
    }
  };
  const translated = () => {
    const value = new Int32Array(1);
    const size = new BigUint64Array(1);
    size[0] = 4n;
    // The key is absent on Intel Macs and on releases without Rosetta; that means not translated.
    if (
      system.symbols.sysctlbyname(
        "sysctl.proc_translated",
        ptr(value),
        ptr(size),
        null,
        0n,
      ) !== 0
    ) {
      return false;
    }
    return value[0] === 1;
  };
  function locale() {
    const identifier = owned(
      core.symbols.CFLocaleCopyCurrent(),
      "macOS current locale is unavailable.",
      (current) => stringOf(core.symbols.CFLocaleGetIdentifier(current)),
    );
    const preferredLanguages = owned(
      core.symbols.CFLocaleCopyPreferredLanguages(),
      "macOS preferred languages are unavailable.",
      (list) => {
        const count = Math.min(
          Number(core.symbols.CFArrayGetCount(list)),
          MAX_LANGUAGES,
        );
        const languages: string[] = [];
        for (let index = 0; index < count; index++) {
          languages.push(
            stringOf(core.symbols.CFArrayGetValueAtIndex(list, index)),
          );
        }
        return languages;
      },
    );
    const tag = localeTag(identifier);
    return {
      locale: tag,
      countryCode: regionOf(tag),
      preferredLanguages,
      // macOS has no separate system UI language; the first preferred language is what the
      // system resolves its own UI to.
      systemLanguage: preferredLanguages[0] ?? tag,
    };
  }
  return {
    info() {
      assertActive();
      return {
        platform: "macos" as const,
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
    usage() {
      assertActive();
      const active = translated();
      const found = machines(active);
      if (!found) {
        return failure("macOS process architecture is unsupported.");
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
          active,
          ...found,
        },
      };
    },
    locale() {
      assertActive();
      return locale();
    },
    listPrinters() {
      assertActive();
      return unsupportedPrinters();
    },
    getDefaultPrinter() {
      assertActive();
      return unsupportedPrinters();
    },
    listGpus() {
      assertActive();
      return unsupportedGpus();
    },
    listAppProcesses() {
      assertActive();
      return unsupportedAppProcesses();
    },
    getMediaAccessStatus() {
      assertActive();
      return unsupportedMediaAccess();
    },
    beep() {
      assertActive();
      audio.symbols.AudioServicesPlayAlertSound(USER_PREFERRED_ALERT);
      return null;
    },
    dispose() {
      owner.dispose();
    },
  };
}

export function dispose(instance: OSInstance) {
  instance.dispose();
}
