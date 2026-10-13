import { dlopen, type Pointer, ptr } from "bun:ffi";
import { randomBytes } from "node:crypto";

/** Disposable private Keychains only. Never changes the default/search list, ACLs or signing identities. */
export function keychainFixture() {
  const api = dlopen("/System/Library/Frameworks/Security.framework/Security", {
    SecKeychainCreate: {
      args: [
        "ptr",
        "u32",
        "ptr",
        "bool",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    SecKeychainOpen: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    SecKeychainDelete: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    SecKeychainLock: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    SecKeychainUnlock: {
      args: [
        "ptr",
        "u32",
        "ptr",
        "bool",
      ],
      returns: "i32",
    },
  });
  const core = dlopen(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    {
      CFRelease: {
        args: [
          "ptr",
        ],
        returns: "void",
      },
    },
  );
  const password = randomBytes(32);
  let reference: Pointer | undefined;
  const check = (status: number) => {
    if (status) {
      throw new Error(`Disposable Keychain fixture failed: ${status}`);
    }
  };
  const acquire = (path: string, create: boolean) => {
    if (reference) {
      throw new Error("Fixture already owns a Keychain");
    }
    // Private filenames must never match Apple's login/System special cases.
    if (!path.endsWith("/synthetic.keychain")) {
      throw new Error("Unsafe fixture path");
    }
    const output = Buffer.alloc(8);
    const nativePath = Buffer.from(`${path}\0`);
    const status = create
      ? api.symbols.SecKeychainCreate(
          ptr(nativePath),
          password.length,
          ptr(password),
          false,
          null,
          ptr(output),
        )
      : api.symbols.SecKeychainOpen(ptr(nativePath), ptr(output));
    reference = Number(output.readBigUInt64LE()) as Pointer;
    check(status);
    if (!reference) {
      throw new Error("Fixture Keychain reference is missing");
    }
    return reference;
  };
  return {
    create: (path: string) => acquire(path, true),
    open: (path: string) => acquire(path, false),
    lock() {
      if (!reference) {
        throw new Error("No fixture Keychain");
      }
      check(api.symbols.SecKeychainLock(reference));
    },
    unlock() {
      if (!reference) {
        throw new Error("No fixture Keychain");
      }
      check(
        api.symbols.SecKeychainUnlock(
          reference,
          password.length,
          ptr(password),
          true,
        ),
      );
    },
    dispose(remove: boolean) {
      try {
        if (reference) {
          if (remove) {
            check(api.symbols.SecKeychainDelete(reference));
          }
        }
      } finally {
        if (reference) {
          core.symbols.CFRelease(reference);
        }
        reference = undefined;
        password.fill(0);
        api.close();
        core.close();
      }
    },
  };
}
