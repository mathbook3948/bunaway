import type { FFIFunction } from "bun:ffi";

/**
 * Shared macOS FFI signatures for platform code that talks to the dynamic loader and the
 * Objective-C runtime. Importing this module opens no library: each adapter calls `dlopen`
 * itself and owns the handle, composing its symbol table with `pick` from `@bunaway/plugin/win32`.
 *
 * Library handles and `RTLD_DEFAULT` are passed as `u64` so the special handles fit, C strings
 * as `cstring` (a NUL-terminated buffer address or a JavaScript string) and runtime pointers as
 * `ptr`, matching the native host.
 */

/** The dynamic loader library every adapter opens first. */
export const LIBSYSTEM_PATH = "/usr/lib/libSystem.B.dylib";

/** The Objective-C runtime library. */
export const OBJC_PATH = "/usr/lib/libobjc.A.dylib";

/** `dlopen` mode: resolve symbols on first use. */
export const RTLD_LAZY = 1;

/** `dlsym` pseudo handle that searches every loaded image, as the 64-bit `u64` it is passed as. */
export const RTLD_DEFAULT = BigInt.asUintN(64, -2n);

/** libSystem.B.dylib: dynamic loading and thread identity. */
export const LIBSYSTEM = {
  dlclose: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  dlopen: {
    args: [
      "cstring",
      "i32",
    ],
    returns: "ptr",
  },
  dlsym: {
    args: [
      "u64",
      "cstring",
    ],
    returns: "ptr",
  },
  pthread_main_np: {
    args: [],
    returns: "i32",
  },
} as const satisfies Record<string, FFIFunction>;

/**
 * libobjc.A.dylib: class and selector lookup. `objc_msgSend` is variadic and stays declared at
 * each call site with the argument shape that call needs.
 */
export const OBJC_RUNTIME = {
  objc_getClass: {
    args: [
      "cstring",
    ],
    returns: "ptr",
  },
  sel_registerName: {
    args: [
      "cstring",
    ],
    returns: "ptr",
  },
} as const satisfies Record<string, FFIFunction>;
