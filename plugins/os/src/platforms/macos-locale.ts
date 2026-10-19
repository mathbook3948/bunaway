import { arch } from "node:os";

/** IMAGE_FILE_MACHINE_AMD64 and IMAGE_FILE_MACHINE_ARM64, the machine values the usage contract uses. */
const MACHINE_AMD64 = 0x8664;
const MACHINE_ARM64 = 0xaa64;

/**
 * A Foundation locale identifier such as `ko_KR` or `en_US@calendar=gregorian` as a BCP 47 tag.
 * Keywords after `@` are dropped and underscores become hyphens, matching the tags the
 * language list uses.
 */
export function localeTag(identifier: string): string {
  const base = identifier.split("@")[0] ?? "";
  return base.replaceAll("_", "-");
}

/**
 * The region subtag of a BCP 47 tag: two letters or three digits after the language and an
 * optional four-letter script, upper-cased. `null` when the locale names no region.
 */
export function regionOf(tag: string): string | null {
  for (const part of tag.split("-").slice(1)) {
    if (/^[A-Za-z]{2}$/.test(part) || /^[0-9]{3}$/.test(part)) {
      return part.toUpperCase();
    }
    if (!/^[A-Za-z]{4}$/.test(part)) {
      return null;
    }
  }
  return null;
}

/**
 * Machine values of the current process and the host. Rosetta only runs x86_64 code on Apple
 * silicon, so a translated process always runs on ARM64; otherwise the process architecture is the
 * host's. `null` for an architecture macOS does not ship on.
 */
export function machines(
  translated: boolean,
  processArch: string = arch(),
): {
  processMachine: number;
  nativeMachine: number;
} | null {
  if (translated) {
    return {
      processMachine: MACHINE_AMD64,
      nativeMachine: MACHINE_ARM64,
    };
  }
  if (processArch === "arm64") {
    return {
      processMachine: 0,
      nativeMachine: MACHINE_ARM64,
    };
  }
  if (processArch === "x64") {
    return {
      processMachine: 0,
      nativeMachine: MACHINE_AMD64,
    };
  }
  return null;
}
