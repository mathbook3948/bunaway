import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import { OLE32, pick, SHELL32, withWide } from "@bunaway/plugin/win32";
import type { WerBindings } from "#crash-report/platforms/windows-crash-report";

const KF_FLAG_DONT_VERIFY = 0x4000;
const MAX_PATH_WCHAR_BYTES = 32768 * 2;
/** FOLDERID_LocalAppData in the Windows SDK's spelling. */
const LOCAL_APP_DATA = "F1B32785-6FBA-4FCF-9D55-7B8E7F157091";
/** Libraries that may export the Windows Error Reporting local dump calls, in lookup order. */
const WER_LIBRARIES = [
  "kernel32.dll",
  "kernelbase.dll",
  "wer.dll",
];

const werSymbols = {
  WerRegisterAppLocalDump: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  WerUnregisterAppLocalDump: {
    args: [],
    returns: "i32",
  },
} as const;

function knownFolderId(guid: string): Buffer {
  const id = Buffer.from(guid.replaceAll("-", ""), "hex");
  id.writeUInt32LE(id.readUInt32BE(0), 0);
  id.writeUInt16LE(id.readUInt16BE(4), 4);
  id.writeUInt16LE(id.readUInt16BE(6), 6);
  return id;
}

/** The user's local app data directory as the shell reports it, which follows folder redirection. */
export function localAppDataFolder(): string {
  const shell = dlopen("shell32.dll", {
    ...pick(SHELL32, "SHGetKnownFolderPath"),
  });
  try {
    const ole = dlopen("ole32.dll", {
      ...pick(OLE32, "CoTaskMemFree"),
    });
    const output = new BigUint64Array(1);
    try {
      const id = knownFolderId(LOCAL_APP_DATA);
      if (
        shell.symbols.SHGetKnownFolderPath(
          ptr(id),
          KF_FLAG_DONT_VERIFY,
          0n,
          ptr(output),
        ) < 0 ||
        !output[0]
      ) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows could not resolve the local app data directory.",
        });
      }
      // Windows owns this WCHAR allocation; the read is bounded before the text is copied.
      const address = Number(output[0]) as Pointer;
      let length = 0;
      while (length < MAX_PATH_WCHAR_BYTES && read.u16(address, length)) {
        length += 2;
      }
      if (length >= MAX_PATH_WCHAR_BYTES) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows local app data path is too long.",
        });
      }
      return Buffer.from(toArrayBuffer(address, 0, length)).toString("utf16le");
    } finally {
      if (output[0]) {
        ole.symbols.CoTaskMemFree(Number(output[0]) as Pointer);
      }
      ole.close();
    }
  } finally {
    shell.close();
  }
}

/** The loaded Windows Error Reporting calls and the handle that closes them. */
export interface WerLibrary {
  bindings: WerBindings;
  close(): void;
}

/** Load the first library that exports both calls, or fail with UNSUPPORTED on a Windows without them. */
export function openWerLibrary(): WerLibrary {
  for (const name of WER_LIBRARIES) {
    let library: ReturnType<typeof dlopen<typeof werSymbols>>;
    try {
      library = dlopen(name, werSymbols);
    } catch {
      continue;
    }
    return {
      bindings: {
        register: (relativeFolder) =>
          withWide(relativeFolder, (path) =>
            library.symbols.WerRegisterAppLocalDump(path),
          ),
        unregister: () => library.symbols.WerUnregisterAppLocalDump(),
      },
      close: () => library.close(),
    };
  }
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "This Windows version has no application-local crash dumps.",
  });
}
