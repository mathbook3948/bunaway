import { dlopen } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import { normalizeApplicationPath, normalizeFilePath } from "../path.ts";
import { createShell } from "../shell.ts";
import { normalizeUrl } from "../url.ts";
import { createFiles } from "../windows-file.ts";
import { trashWindowsFile, validateTrashDrive } from "../windows-trash.ts";

const COINIT_APARTMENTTHREADED = 0x2;

/** Own one balanced COM initialization on the adapter's I/O thread. */
function createApartment() {
  const ole = dlopen("ole32.dll", {
    CoInitializeEx: {
      args: [
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    CoUninitialize: {
      args: [],
      returns: "void",
    },
  });
  if (ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED) < 0) {
    ole.close();
    throw new BunawayError({
      code: "INTERNAL",
      message: "Opener could not initialize its COM apartment.",
    });
  }
  return {
    dispose() {
      ole.symbols.CoUninitialize();
      ole.close();
    },
  };
}

/** Prepare the STA and retain each resource until all shell references are released. */
export function initialize() {
  const apartment = createApartment();
  const shell = (() => {
    try {
      return createShell();
    } catch (error) {
      apartment.dispose();
      throw error;
    }
  })();
  const files = (() => {
    try {
      return createFiles();
    } catch (error) {
      try {
        shell.dispose();
      } finally {
        apartment.dispose();
      }
      throw error;
    }
  })();
  return {
    apartment,
    shell,
    files,
    disposed: false,
  };
}

type State = ReturnType<typeof initialize>;

function active(state: State): void {
  if (state.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Opener has been disposed.",
    });
  }
}

export function openUrl(state: State, url: string): null {
  active(state);
  state.shell.open(normalizeUrl(url));
  return null;
}

export function openFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  state.files.withFile(selected, () => state.shell.open(selected));
  return null;
}

export function revealFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  state.files.withFile(selected, () => state.shell.reveal(selected));
  return null;
}

export function trashFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  validateTrashDrive(selected);
  state.files.withTrashFile(selected, (verifyIdentity) =>
    trashWindowsFile(selected, verifyIdentity),
  );
  return null;
}

export function openFileWith(
  state: State,
  path: string,
  application: string,
): null {
  active(state);
  const app = normalizeApplicationPath(application);
  state.files.withFile(app, () => {
    const selected = normalizeFilePath(path);
    state.files.withFile(selected, () => state.shell.open(app, selected));
  });
  return null;
}

export function openUrlWith(
  state: State,
  url: string,
  application: string,
): null {
  active(state);
  const app = normalizeApplicationPath(application);
  state.files.withFile(app, () => state.shell.open(app, normalizeUrl(url)));
  return null;
}

export function dispose(state: State): void {
  if (state.disposed) {
    return;
  }
  state.disposed = true;
  try {
    state.files.dispose();
  } finally {
    try {
      state.shell.dispose();
    } finally {
      state.apartment.dispose();
    }
  }
}
