import {
  CFunction,
  dlopen,
  type Pointer,
  ptr,
  read,
  toArrayBuffer,
} from "bun:ffi";
import type { NativeDialogServices } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import {
  type DialogInput,
  type DialogKind,
  MAX_DIALOG_PATH_UNITS,
  MAX_DIALOG_PATHS,
  MAX_DIALOG_RESULT_UNITS,
} from "#dialog/contract";
import type { DialogDriver } from "#dialog/platforms/windows";

const HRESULT_CANCELLED = 0x800704c7;
const E_ABORT = -2147467260;
const WM_TIMER = 0x0113;
const TIMER_ID = 1n;
const POLL_INTERVAL_MS = 25;
const FOS_FORCEFILESYSTEM = 0x40;
const FOS_PICKFOLDERS = 0x20;
const FOS_ALLOWMULTISELECT = 0x200;
const FOS_DONTADDTORECENT = 0x02000000;
const FOS_NOTESTFILECREATE = 0x10000;
const SIGDN_FILESYSPATH = 0x80058000;
const CLSCTX_INPROC_SERVER = 1;
const COINIT_APARTMENTTHREADED = 2;
// Canonical GUIDs from Microsoft win32metadata ShObjIdl_core.h. Only the first three fields are little-endian.
function guid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}
const OPEN_CLASS = guid("dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7");
const SAVE_CLASS = guid("c0b4e2f3-ba21-4773-8dba-335ec946eb8b");
const OPEN_IID = guid("d57c7288-d4ad-4768-be02-9d969532d960");
const SAVE_IID = guid("84bccd23-5fde-4cdb-aea4-af64b83d78ab");
const SHELL_ITEM_IID = guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

function check(result: number, stage: string): void {
  if (result < 0) {
    throw new BunawayError({
      code: "INTERNAL",
      message: "Windows file dialog failed.",
      details: {
        stage,
        hresult: result >>> 0,
      },
    });
  }
}

/** Own one COM dialog, its DLLs and vtable bindings. Importing this module allocates no OS resources. */
export function createDialog(
  kind: DialogKind,
  input: DialogInput,
  services: NativeDialogServices,
): DialogDriver {
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
    CoCreateInstance: {
      args: [
        "ptr",
        "ptr",
        "u32",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    CoTaskMemFree: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
  });
  let apartment = false;
  let dialog: Pointer | undefined;
  let disposed = false;
  const bindings: ReturnType<typeof CFunction>[] = [];
  const user = (() => {
    try {
      return dlopen("user32.dll", {
        SetTimer: {
          args: [
            "u64",
            "u64",
            "u32",
            "ptr",
          ],
          returns: "u64",
        },
        KillTimer: {
          args: [
            "u64",
            "u64",
          ],
          returns: "i32",
        },
      });
    } catch (error) {
      ole.close();
      throw error;
    }
  })();
  const method = (
    object: Pointer,
    slot: number,
    args: ("ptr" | "u32" | "i32" | "u64")[] = [],
  ) => {
    const address = read.ptr(read.ptr(object), slot * 8);
    if (!address) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Invalid dialog COM interface.",
      });
    }
    // COM vtables are native-owned Win64 pointers, valid until the matching Release.
    const binding = CFunction({
      ptr: address as Pointer,
      args: [
        "ptr",
        ...args,
      ],
      returns: "i32",
    });
    bindings.push(binding);
    return (...values: (number | bigint | null)[]) =>
      Number(binding(object, ...values));
  };
  const release = (object: Pointer) => {
    method(object, 2)();
  };
  const outObject = (
    call: (output: Pointer) => number,
    stage: string,
  ): Pointer => {
    const output = new BigUint64Array(1);
    check(call(ptr(output)), stage);
    if (!output[0]) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Missing dialog COM result.",
      });
    }
    return Number(output[0]) as Pointer;
  };
  const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le");
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      if (dialog) {
        release(dialog);
      }
    } finally {
      for (const binding of bindings) {
        binding.close();
      }
      if (apartment) {
        ole.symbols.CoUninitialize();
      }
      user.close();
      ole.close();
    }
  };
  try {
    check(
      ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED),
      "CoInitializeEx",
    );
    apartment = true;
    const save = kind === "saveFile";
    dialog = outObject(
      (output) =>
        ole.symbols.CoCreateInstance(
          ptr(save ? SAVE_CLASS : OPEN_CLASS),
          null,
          CLSCTX_INPROC_SERVER,
          ptr(save ? SAVE_IID : OPEN_IID),
          output,
        ),
      "CoCreateInstance",
    );
    const object = dialog;
    const options = new Uint32Array(1);
    check(
      method(object, 10, [
        "ptr",
      ])(ptr(options)),
      "GetOptions",
    );
    // Preserve Windows' path/file existence and overwrite confirmation defaults. Never create a test file.
    let flags =
      (options[0] ?? 0) |
      FOS_FORCEFILESYSTEM |
      FOS_DONTADDTORECENT |
      FOS_NOTESTFILECREATE;
    if (kind === "selectFolder") {
      flags |= FOS_PICKFOLDERS;
    }
    if (!save && input.multiple) {
      flags |= FOS_ALLOWMULTISELECT;
    }
    check(
      method(object, 9, [
        "u32",
      ])(flags),
      "SetOptions",
    );
    for (const [slot, value] of [
      [
        17,
        input.title,
      ],
      [
        15,
        input.defaultFileName,
      ],
      [
        22,
        input.defaultExtension,
      ],
    ] as const) {
      if (value !== undefined) {
        const buffer = wide(value);
        check(
          method(object, slot, [
            "ptr",
          ])(ptr(buffer)),
          "Set dialog text",
        );
      }
    }
    if (input.filters) {
      const strings = input.filters.flatMap((filter) => [
        wide(filter.name),
        wide(
          filter.extensions
            .map((extension) => (extension === "*" ? "*.*" : `*.${extension}`))
            .join(";"),
        ),
      ]);
      const filters = new BigUint64Array(
        strings.map((buffer) => BigInt(ptr(buffer))),
      );
      check(
        method(object, 4, [
          "u32",
          "ptr",
        ])(input.filters.length, ptr(filters)),
        "SetFileTypes",
      );
      // Keep buffers alive through the native copy, including the nested string pointers.
      for (const buffer of strings) {
        void buffer.byteLength;
      }
    }
    if (input.defaultDirectory !== undefined) {
      const shell = dlopen("shell32.dll", {
        SHCreateItemFromParsingName: {
          args: [
            "ptr",
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
      });
      try {
        const path = wide(input.defaultDirectory);
        const folder = outObject(
          (output) =>
            shell.symbols.SHCreateItemFromParsingName(
              ptr(path),
              null,
              ptr(SHELL_ITEM_IID),
              output,
            ),
          "Default directory",
        );
        try {
          check(
            method(object, 12, [
              "ptr",
            ])(folder),
            "SetFolder",
          );
        } finally {
          release(folder);
        }
      } finally {
        shell.close();
      }
    }
    const show = method(object, 3, [
      "u64",
    ]);
    const close = method(object, 23, [
      "i32",
    ]);
    const pathOf = (item: Pointer): string => {
      const output = new BigUint64Array(1);
      check(
        method(item, 5, [
          "u32",
          "ptr",
        ])(SIGDN_FILESYSPATH, ptr(output)),
        "GetDisplayName",
      );
      const address = Number(output[0]) as Pointer;
      if (!address) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Missing selected path.",
        });
      }
      try {
        let units = 0;
        while (units <= MAX_DIALOG_PATH_UNITS && read.u16(address, units * 2)) {
          units++;
        }
        if (!units || units > MAX_DIALOG_PATH_UNITS) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Selected path exceeds the dialog limit.",
          });
        }
        return Buffer.from(toArrayBuffer(address, 0, units * 2)).toString(
          "utf16le",
        );
      } finally {
        ole.symbols.CoTaskMemFree(address);
      }
    };
    return {
      show(owner, poll) {
        if (disposed) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Dialog is disposed.",
          });
        }
        let callbackFailure: unknown;
        let closing = false;
        let pollReported = false;
        const hwnd = services.createWindow((message) => {
          if (message !== WM_TIMER || closing) {
            return;
          }
          try {
            const report = !pollReported;
            pollReported = true;
            if (report) console.log("dialog poll enter");
            const interrupted = poll();
            if (report) console.log("dialog poll returned", interrupted);
            if (!interrupted) {
              return;
            }
          } catch (error) {
            console.error("dialog poll failed", error);
            callbackFailure ??= error;
          }
          // Timer WndProc stays on this STA. Never throw through Windows' callback stack.
          console.log("dialog Close enter");
          const result = close(E_ABORT);
          console.log("dialog Close returned", result);
          if (result >= 0) {
            closing = true;
          } else {
            callbackFailure ??= new BunawayError({
              code: "INTERNAL",
              message: "Windows could not close the file dialog.",
            });
          }
        });
        let timer = false;
        try {
          if (!user.symbols.SetTimer(hwnd, TIMER_ID, POLL_INTERVAL_MS, null)) {
            throw new BunawayError({
              code: "INTERNAL",
              message: "Dialog cancellation timer failed.",
            });
          }
          timer = true;
          const result = show(owner);
          if (callbackFailure) {
            throw callbackFailure;
          }
          if (closing || result >>> 0 === HRESULT_CANCELLED) {
            return {
              cancelled: true,
            };
          }
          check(result, "Show");
          const paths: string[] = [];
          if (save) {
            const item = outObject(
              (output) =>
                method(object, 20, [
                  "ptr",
                ])(output),
              "GetResult",
            );
            try {
              paths.push(pathOf(item));
            } finally {
              release(item);
            }
          } else {
            const items = outObject(
              (output) =>
                method(object, 27, [
                  "ptr",
                ])(output),
              "GetResults",
            );
            try {
              const count = new Uint32Array(1);
              check(
                method(items, 7, [
                  "ptr",
                ])(ptr(count)),
                "GetCount",
              );
              if (
                !count[0] ||
                count[0] > (input.multiple ? MAX_DIALOG_PATHS : 1)
              ) {
                throw new BunawayError({
                  code: "INTERNAL",
                  message: "Selected path count exceeds the dialog limit.",
                });
              }
              let total = 0;
              for (let index = 0; index < count[0]; index++) {
                const item = outObject(
                  (output) =>
                    method(items, 8, [
                      "u32",
                      "ptr",
                    ])(index, output),
                  "GetItemAt",
                );
                try {
                  const path = pathOf(item);
                  total += path.length;
                  if (total > MAX_DIALOG_RESULT_UNITS) {
                    throw new BunawayError({
                      code: "INTERNAL",
                      message: "Selected paths exceed the dialog result limit.",
                    });
                  }
                  paths.push(path);
                } finally {
                  release(item);
                }
              }
            } finally {
              release(items);
            }
          }
          return {
            cancelled: false,
            paths,
          };
        } finally {
          if (timer) {
            user.symbols.KillTimer(hwnd, TIMER_ID);
          }
          // Destroying the HWND invalidates queued WM_TIMER messages before DLL disposal.
          services.destroyWindow(hwnd);
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
