import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";

const POINTER_BYTES = 8;
const VARIANT_BYTES = 24;
const VARIANT_VALUE_OFFSET = 8;
const DISPPARAMS_BYTES = 24;
const EXCEPINFO_BYTES = 64;
const EXCEPINFO_SCODE_OFFSET = 56;
const VT_I4 = 3;
const VT_BSTR = 8;
const CLSCTX_SHELL_WINDOWS = 0x1 | 0x4;
const SWC_DESKTOP = 8;
const SWFO_NEEDDISPATCH = 1;
const SVGIO_BACKGROUND = 0;
const DISPATCH_METHOD = 1;
const SW_SHOWNORMAL = 1;
const HRESULT_ACCESS_DENIED = 0x80070005;
const HRESULT_FILE_NOT_FOUND = 0x80070002;
const HRESULT_PATH_NOT_FOUND = 0x80070003;
const COM_SLOT = {
  queryInterface: 0,
  release: 2,
  queryService: 3,
  getIdsOfNames: 5,
  invoke: 6,
  getApplication: 7,
  findWindow: 15,
  queryActiveView: 15,
  getItemObject: 15,
} as const;

function guid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}

const CLSID_SHELL_WINDOWS = guid("9ba05972-f6a8-11cf-a442-00a0c90a8f39");
const IID_SHELL_WINDOWS = guid("85cb6900-4d95-11cf-960c-0080c7f4ee85");
const IID_SERVICE_PROVIDER = guid("6d5140c1-7436-11ce-8034-00aa006009fa");
const SID_TOP_LEVEL_BROWSER = guid("4c96be40-915c-11cf-99d3-00aa004ae837");
const IID_SHELL_BROWSER = guid("000214e2-0000-0000-c000-000000000046");
const IID_DISPATCH = guid("00020400-0000-0000-c000-000000000046");
const IID_FOLDER_VIEW = guid("e7a1af80-4d96-11cf-960c-0080c7f4ee85");
const IID_NULL = Buffer.alloc(16);

function launchFailed(): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: "Windows Explorer could not accept the shell request.",
  });
}

function checkResult(result: number): void {
  if (result < 0) {
    throw launchFailed();
  }
}

/** Preserve file-specific failures when Windows reports them synchronously. */
function checkFileResult(result: number): void {
  const hresult = result >>> 0;
  if (hresult === HRESULT_ACCESS_DENIED) {
    throw new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Windows denied the file request.",
    });
  }
  if (
    hresult === HRESULT_FILE_NOT_FOUND ||
    hresult === HRESULT_PATH_NOT_FOUND
  ) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Opener file not found.",
      details: {
        reason: "FILE_NOT_FOUND",
      },
    });
  }
  checkResult(result);
}

/**
 * Load the COM libraries for a launcher used on the UI host's initialized STA.
 * Dispose the returned object after its adapter stops.
 */
export function createShell() {
  const ole = dlopen("ole32.dll", {
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
  const automation = (() => {
    try {
      return dlopen("oleaut32.dll", {
        SysAllocStringLen: {
          args: [
            "ptr",
            "u32",
          ],
          returns: "ptr",
        },
        SysFreeString: {
          args: [
            "ptr",
          ],
          returns: "void",
        },
      });
    } catch (error) {
      ole.close();
      throw error;
    }
  })();
  let disposed = false;
  return {
    /**
     * Ask Explorer to open a target; all COM work must remain on the creating STA.
     * Calls after disposal throw a `CANCELLED` error.
     */
    open(target: string): void {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      const methods: ReturnType<typeof CFunction>[] = [];
      const releases: (() => void)[] = [];
      const strings: Pointer[] = [];
      const exception = Buffer.alloc(EXCEPINFO_BYTES);
      const method = (
        object: Pointer,
        slot: number,
        args: ("ptr" | "i32" | "u32" | "u16")[],
      ) => {
        const address = read.ptr(read.ptr(object), slot * POINTER_BYTES);
        if (!address) {
          throw launchFailed();
        }
        const binding = CFunction({
          ptr: address as Pointer,
          args: [
            "ptr",
            ...args,
          ],
          returns: "i32",
        });
        methods.push(binding);
        return (...values: (number | null)[]) =>
          Number(binding(object, ...values));
      };
      const objectFrom = (invoke: (out: Pointer) => number): Pointer => {
        const output = new BigUint64Array(1);
        checkResult(invoke(ptr(output)));
        if (!output[0]) {
          // FindWindowSW can return S_FALSE when Explorer has no desktop.
          throw launchFailed();
        }
        const object = Number(output[0]) as Pointer;
        const release = method(object, COM_SLOT.release, []);
        releases.push(() => release());
        return object;
      };
      const query = (object: Pointer, iid: Buffer) =>
        objectFrom((out) =>
          method(object, COM_SLOT.queryInterface, [
            "ptr",
            "ptr",
          ])(ptr(iid), out),
        );
      const string = (value: string): Pointer => {
        const wide = Buffer.from(`${value}\0`, "utf16le");
        const result = automation.symbols.SysAllocStringLen(
          ptr(wide),
          value.length,
        );
        if (!result) {
          throw launchFailed();
        }
        // Bun types also allow bigint pointer results on 64-bit platforms.
        const address = Number(result) as Pointer;
        strings.push(address);
        return address;
      };
      try {
        // Resolve the desktop's application object, rather than creating a new
        // Shell.Application in our process. Explorer must own the launched process
        // so it cannot inherit the app's kill-on-close Job or process mitigations.
        // https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643
        const windows = objectFrom((out) =>
          ole.symbols.CoCreateInstance(
            ptr(CLSID_SHELL_WINDOWS),
            null,
            CLSCTX_SHELL_WINDOWS,
            ptr(IID_SHELL_WINDOWS),
            out,
          ),
        );
        const location = Buffer.alloc(VARIANT_BYTES);
        location.writeUInt16LE(VT_I4, 0); // CSIDL_DESKTOP is zero.
        const root = Buffer.alloc(VARIANT_BYTES);
        const hwnd = new Int32Array(1);
        const desktop = objectFrom((out) =>
          method(windows, COM_SLOT.findWindow, [
            "ptr",
            "ptr",
            "i32",
            "ptr",
            "i32",
            "ptr",
          ])(
            ptr(location),
            ptr(root),
            SWC_DESKTOP,
            ptr(hwnd),
            SWFO_NEEDDISPATCH,
            out,
          ),
        );
        const provider = query(desktop, IID_SERVICE_PROVIDER);
        const browser = objectFrom((out) =>
          method(provider, COM_SLOT.queryService, [
            "ptr",
            "ptr",
            "ptr",
          ])(ptr(SID_TOP_LEVEL_BROWSER), ptr(IID_SHELL_BROWSER), out),
        );
        const view = objectFrom((out) =>
          method(browser, COM_SLOT.queryActiveView, [
            "ptr",
          ])(out),
        );
        const dispatchView = objectFrom((out) =>
          method(view, COM_SLOT.getItemObject, [
            "u32",
            "ptr",
            "ptr",
          ])(SVGIO_BACKGROUND, ptr(IID_DISPATCH), out),
        );
        const folderView = query(dispatchView, IID_FOLDER_VIEW);
        const shell = objectFrom((out) =>
          method(folderView, COM_SLOT.getApplication, [
            "ptr",
          ])(out),
        );

        // Invoke avoids passing VARIANT structs by value, which Bun FFI does not
        // support. Win64 VARIANTs occupy 24 bytes; IDispatch arguments are reversed.
        const name = Buffer.from("ShellExecute\0", "utf16le");
        const names = new BigUint64Array([
          BigInt(ptr(name)),
        ]);
        const dispatchId = new Int32Array(1);
        checkResult(
          method(shell, COM_SLOT.getIdsOfNames, [
            "ptr",
            "ptr",
            "u32",
            "u32",
            "ptr",
          ])(ptr(IID_NULL), ptr(names), 1, 0, ptr(dispatchId)),
        );
        const isUrl = /^https?:\/\//i.test(target);
        const argumentCount = isUrl ? 5 : 1;
        const argumentsBuffer = Buffer.alloc(argumentCount * VARIANT_BYTES);
        let values = [
          string(target),
        ];
        if (isUrl) {
          argumentsBuffer.writeUInt16LE(VT_I4, 0);
          argumentsBuffer.writeInt32LE(SW_SHOWNORMAL, VARIANT_VALUE_OFFSET);
          const empty = string("");
          values = [
            string("open"),
            empty,
            empty,
            ...values,
          ];
        }
        // File calls omit optional arguments so the registered default verb is used.
        for (const [index, value] of values.entries()) {
          const offset = (index + (isUrl ? 1 : 0)) * VARIANT_BYTES;
          argumentsBuffer.writeUInt16LE(VT_BSTR, offset);
          argumentsBuffer.writeBigUInt64LE(
            BigInt(value),
            offset + VARIANT_VALUE_OFFSET,
          );
        }
        const parameters = Buffer.alloc(DISPPARAMS_BYTES);
        // Win64 DISPPARAMS: rgvarg at 0, cArgs at 16, no named arguments.
        parameters.writeBigUInt64LE(BigInt(ptr(argumentsBuffer)), 0);
        parameters.writeUInt32LE(argumentCount, 16);
        const result = method(shell, COM_SLOT.invoke, [
          "i32",
          "ptr",
          "u32",
          "u16",
          "ptr",
          "ptr",
          "ptr",
          "ptr",
        ])(
          dispatchId[0] ?? 0,
          ptr(IID_NULL),
          0,
          DISPATCH_METHOD,
          ptr(parameters),
          null,
          ptr(exception),
          null,
        );
        if (result < 0 && !isUrl) {
          // DISP_E_EXCEPTION carries the underlying HRESULT in EXCEPINFO.scode.
          checkFileResult(
            exception.readInt32LE(EXCEPINFO_SCODE_OFFSET) || result,
          );
        }
        checkResult(result);
      } finally {
        // EXCEPINFO's source, description and help-file strings belong to us,
        // including when Invoke returns DISP_E_EXCEPTION.
        for (const offset of [
          8,
          16,
          24,
        ]) {
          const address = exception.readBigUInt64LE(offset);
          if (address) {
            automation.symbols.SysFreeString(Number(address) as Pointer);
          }
        }
        for (const value of strings) {
          automation.symbols.SysFreeString(value);
        }
        for (const release of releases.reverse()) {
          release();
        }
        for (const binding of methods) {
          binding.close();
        }
      }
    },
    /** Request selection of a single file by PIDL, releasing it on every outcome. */
    reveal(target: string): void {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      const shell = dlopen("shell32.dll", {
        SHParseDisplayName: {
          args: [
            "ptr",
            "ptr",
            "ptr",
            "u32",
            "ptr",
          ],
          returns: "i32",
        },
        SHOpenFolderAndSelectItems: {
          args: [
            "ptr",
            "u32",
            "ptr",
            "u32",
          ],
          returns: "i32",
        },
      });
      const item = new BigUint64Array(1);
      try {
        checkFileResult(
          shell.symbols.SHParseDisplayName(
            ptr(Buffer.from(`${target}\0`, "utf16le")),
            null,
            ptr(item),
            0,
            null,
          ),
        );
        if (!item[0]) {
          throw launchFailed();
        }
        // With zero children, the absolute PIDL identifies the item to select in its parent.
        checkFileResult(
          shell.symbols.SHOpenFolderAndSelectItems(
            Number(item[0]) as Pointer,
            0,
            null,
            0,
          ),
        );
      } finally {
        if (item[0]) {
          ole.symbols.CoTaskMemFree(Number(item[0]) as Pointer);
        }
        shell.close();
      }
    },
    /** Release the loaded COM libraries after no more launches can run. */
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      automation.close();
      ole.close();
    },
  };
}
