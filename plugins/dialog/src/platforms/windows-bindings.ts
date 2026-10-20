import {
  CFunction,
  dlopen,
  JSCallback,
  type Pointer,
  ptr,
  read,
  toArrayBuffer,
} from "bun:ffi";
import { OLE32, SHELL32, USER32, pick, wide } from "@bunaway/plugin/win32";
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
const WM_CLOSE = 0x0010;
const WM_QUIT = 0x0012;
const PM_REMOVE = 1;
const TIMER_ID = 1n;
const POLL_INTERVAL_MS = 25;
const FOS_OVERWRITEPROMPT = 0x2;
const FOS_FORCESHOWHIDDEN = 0x10000000;
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
const OLE_WINDOW_IID = guid("00000114-0000-0000-c000-000000000046");
const SHELL_ITEM_IID = guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

/** Throw a generic INTERNAL error carrying only the failing stage and HRESULT when `result` is negative. */
export function check(
  result: number,
  stage: string,
  message = "Windows file dialog failed.",
): void {
  if (result < 0) {
    throw new BunawayError({
      code: "INTERNAL",
      message,
      details: {
        stage,
        hresult: result >>> 0,
      },
    });
  }
}

/** Track Shell Close attempts across timer ticks. An accepted Close supersedes earlier rejected attempts. */
export class DialogCloseRequest {
  private accepted = false;
  private rejection: BunawayError | undefined;

  /** Record one IFileDialog::Close HRESULT and report whether Shell accepted it. */
  record(result: number): boolean {
    if (result >= 0) {
      this.accepted = true;
      this.rejection = undefined;
      return true;
    }
    if (!this.accepted) {
      this.rejection ??= new BunawayError({
        code: "INTERNAL",
        message: "Windows could not close the file dialog.",
        details: {
          hresult: result >>> 0,
        },
      });
    }
    return false;
  }

  /**
   * Settle Show's HRESULT after the modal loop unwinds.
   *
   * Throws a Close rejection that no later Close superseded. Returns the cancelled result when Close was
   * accepted or Show reported cancellation, and undefined when Show's HRESULT should be checked normally.
   */
  settle(showResult: number):
    | {
        cancelled: true;
      }
    | undefined {
    if (this.rejection) {
      throw this.rejection;
    }
    if (this.accepted || showResult >>> 0 === HRESULT_CANCELLED) {
      return {
        cancelled: true,
      };
    }
    return undefined;
  }
}

/**
 * Compute the IFileDialog option flags for a request.
 *
 * Starts from the dialog's GetOptions `defaults` so Windows' path/file existence defaults are kept.
 * Always adds FOS_FORCEFILESYSTEM, FOS_DONTADDTORECENT and FOS_NOTESTFILECREATE (never create a test
 * file). Adds FOS_PICKFOLDERS for selectFolder, FOS_ALLOWMULTISELECT for non-save `multiple`, and
 * FOS_FORCESHOWHIDDEN when `showHiddenFiles` is true. For saveFile, `confirmOverwrite` true sets
 * FOS_OVERWRITEPROMPT, false clears it, and omitting it leaves the OS default untouched.
 * The result is an unsigned 32-bit value because the hidden flag and `~` yield signed numbers.
 */
export function fileDialogOptions(
  kind: DialogKind,
  input: DialogInput,
  defaults: number,
): number {
  let flags =
    defaults | FOS_FORCEFILESYSTEM | FOS_DONTADDTORECENT | FOS_NOTESTFILECREATE;
  if (kind === "selectFolder") {
    flags |= FOS_PICKFOLDERS;
  }
  if (kind !== "saveFile" && input.multiple) {
    flags |= FOS_ALLOWMULTISELECT;
  }
  if (input.showHiddenFiles === true) {
    flags |= FOS_FORCESHOWHIDDEN;
  }
  if (kind === "saveFile") {
    if (input.confirmOverwrite === true) {
      flags |= FOS_OVERWRITEPROMPT;
    } else if (input.confirmOverwrite === false) {
      flags &= ~FOS_OVERWRITEPROMPT;
    }
  }
  return flags >>> 0;
}

/** Own one COM dialog, its DLLs and vtable bindings. Importing this module allocates no OS resources. */
export function createDialog(
  kind: DialogKind,
  input: DialogInput,
  services: NativeDialogServices,
): DialogDriver {
  const ole = dlopen("ole32.dll", {
    ...pick(
      OLE32,
      "CoInitializeEx",
      "CoUninitialize",
      "CoCreateInstance",
      "CoTaskMemFree",
    ),
  });
  let apartment = false;
  let dialog: Pointer | undefined;
  let dialogWindow: Pointer | undefined;
  let disposed = false;
  const bindings: ReturnType<typeof CFunction>[] = [];
  const user = (() => {
    try {
      return dlopen("user32.dll", {
        ...pick(
          USER32,
          "SendMessageW",
          "SetTimer",
          "KillTimer",
          "PeekMessageW",
        ),
        PostQuitMessage: {
          args: [
            "i32",
          ],
          returns: "void",
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
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      try {
        if (dialogWindow) {
          release(dialogWindow);
        }
      } finally {
        if (dialog) {
          release(dialog);
        }
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
    const flags = fileDialogOptions(kind, input, options[0] ?? 0);
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
        ...pick(SHELL32, "SHCreateItemFromParsingName"),
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
    dialogWindow = outObject(
      (output) =>
        method(object, 0, [
          "ptr",
          "ptr",
        ])(ptr(OLE_WINDOW_IID), output),
      "QueryInterface(IOleWindow)",
    );
    const getWindow = method(dialogWindow, 3, [
      "ptr",
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
    /**
     * Read the selected paths from the finished dialog: one result for a save dialog, otherwise the
     * result array, bounded by the path count and the total UTF-16 length.
     */
    const readResultPaths = (): string[] => {
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
          if (!count[0] || count[0] > (input.multiple ? MAX_DIALOG_PATHS : 1)) {
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
      return paths;
    };
    /**
     * Remove timer messages already queued for the private window. Returns the exit code of a
     * WM_QUIT consumed on the way, which the caller must repost.
     */
    const drainTimerMessages = (hwnd: bigint): number | undefined => {
      const message = Buffer.alloc(48); // MSG on Win64.
      let quitCode: number | undefined;
      while (
        user.symbols.PeekMessageW(
          ptr(message),
          hwnd,
          WM_TIMER,
          WM_TIMER,
          PM_REMOVE,
        )
      ) {
        // PeekMessage retrieves WM_QUIT regardless of the requested filter.
        if (message.readUInt32LE(8) === WM_QUIT) {
          quitCode = message.readInt32LE(16);
        }
      }
      return quitCode;
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
        const closeRequest = new DialogCloseRequest();
        let handling = false;
        let active = true;
        const hwnd = services.createWindow(() => {});
        let callback: JSCallback | undefined;
        let timer = false;
        try {
          callback = new JSCallback(
            () => {
              if (!active || handling) {
                return;
              }
              // COM calls can pump messages. Guard before polling or attempting Close.
              handling = true;
              try {
                try {
                  const interrupted = poll();
                  if (!interrupted) {
                    return;
                  }
                } catch (error) {
                  callbackFailure ??= error;
                }
                if (closeRequest.record(close(E_ABORT))) {
                  // Shell Close can acknowledge cancellation without unwinding Show from a timer.
                  // Resolve only this COM object's HWND and request closure synchronously on its STA.
                  // No queued close message may outlive Show or target a subsequently reused HWND.
                  const window = new BigUint64Array(1);
                  if (getWindow(ptr(window)) >= 0 && window[0]) {
                    user.symbols.SendMessageW(window[0], WM_CLOSE, 0n, 0n);
                  }
                }
              } catch (error) {
                // Never propagate exceptions through a native TIMERPROC stack.
                callbackFailure ??= error;
              } finally {
                handling = false;
              }
            },
            {
              args: [
                "u64",
                "u32",
                "u64",
                "u32",
              ],
              returns: "void",
            },
          );
          if (
            !user.symbols.SetTimer(
              hwnd,
              TIMER_ID,
              POLL_INTERVAL_MS,
              callback.ptr,
            )
          ) {
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
          const cancelled = closeRequest.settle(result);
          if (cancelled) {
            return cancelled;
          }
          check(result, "Show");
          const paths = readResultPaths();
          return {
            cancelled: false,
            paths,
          };
        } finally {
          active = false;
          if (timer) {
            user.symbols.KillTimer(hwnd, TIMER_ID);
          }
          // KillTimer leaves queued callback pointers. Drain this private HWND before releasing ours.
          const quitCode = drainTimerMessages(hwnd);
          try {
            services.destroyWindow(hwnd);
          } finally {
            callback?.close();
            if (quitCode !== undefined) {
              user.symbols.PostQuitMessage(quitCode);
            }
          }
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
