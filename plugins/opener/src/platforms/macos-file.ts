import { dlopen, ptr, read } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { BunawayError } from "@bunaway/protocol";

// Darwin exposes this flag to openat; Node's fs.constants omits it.
const O_CLOEXEC = 0x1000000;

/** Borrow a checked, readable regular file for one synchronous workspace request. */
export type MacosFiles = {
  withFile(path: string, request: () => void): void;
  dispose(): void;
};

function fail(error: unknown): never {
  const code = error instanceof Error ? Reflect.get(error, "code") : error;
  if (code === "ENOENT" || code === 2) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Opener file not found.",
      details: {
        reason: "FILE_NOT_FOUND",
      },
    });
  }
  if (
    [
      "EACCES",
      "EPERM",
      "ELOOP",
      "ENOTDIR",
      1,
      13,
      20,
      62,
    ].includes(code)
  ) {
    throw new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Opener file access denied or path contains a link.",
    });
  }
  throw new BunawayError({
    code: "INTERNAL",
    message: "Opener file check failed.",
  });
}

/** Requires the opened descriptor to be an unlinked regular file still found at `path`. */
function assertStableRegularFile(path: string, descriptor: number): void {
  const file = fstatSync(descriptor);
  if (!file.isFile()) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Opener requires a regular file.",
    });
  }
  const current = lstatSync(path);
  if (
    file.nlink !== 1 ||
    current.dev !== file.dev ||
    current.ino !== file.ino ||
    current.isSymbolicLink()
  ) {
    throw new BunawayError({
      code: "PERMISSION_DENIED",
      message:
        "Opener paths must not contain links or change during validation.",
    });
  }
}

/**
 * Walk from the root with descriptor-relative, non-following opens. Descriptors
 * remain owned until dispatch returns, but POSIX does not prevent renames. The
 * final identity check narrows that race; NSWorkspace still consumes a pathname.
 */
export function createFiles(): MacosFiles {
  const api = dlopen("/usr/lib/libSystem.B.dylib", {
    openat: {
      args: [
        "i32",
        "ptr",
        "i32",
        "u32",
      ],
      returns: "i32",
    },
    __error: {
      args: [],
      returns: "ptr",
    },
  });
  let disposed = false;
  /** Opens each path component relative to its parent without following links; the caller closes `handles`. */
  const openPath = (path: string, handles: number[]): number => {
    let parent = openSync(
      "/",
      constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC,
    );
    handles.push(parent);
    const names = path.slice(1).split("/");
    for (const [index, name] of names.entries()) {
      const leaf = index === names.length - 1;
      const descriptor = api.symbols.openat(
        parent,
        ptr(Buffer.from(`${name}\0`)),
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          O_CLOEXEC |
          (leaf ? constants.O_NONBLOCK : constants.O_DIRECTORY),
        0,
      );
      if (descriptor < 0) {
        const address = api.symbols.__error();
        fail(address ? read.i32(address, 0) : undefined);
      }
      handles.push(descriptor);
      parent = descriptor;
    }
    return parent;
  };
  return {
    withFile(path, request) {
      const handles: number[] = [];
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      try {
        assertStableRegularFile(path, openPath(path, handles));
        request();
      } catch (error) {
        if (error instanceof BunawayError) {
          throw error;
        }
        fail(error);
      } finally {
        for (const handle of handles.reverse()) {
          closeSync(handle);
        }
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      api.close();
    },
  };
}
