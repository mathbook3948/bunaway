import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import { checkHresult, OLE32, pick, withWide } from "@bunaway/plugin/win32";
import assert from "node:assert/strict";
import { guid } from "./guid.ts";

/** MSDN samples use CLSCTX_SERVER for AccPropServices. */
const CLSCTX_SERVER = 5;
/** OBJID_CLIENT as the unsigned DWORD that IAccPropServices expects. */
const OBJID_CLIENT = 0xfffffffc;
const CHILDID_SELF = 0;
/** IAccPropServices vtable slots, in oleacc.idl order after IUnknown. */
const SLOT_RELEASE = 2;
const SLOT_SET_HWND_PROP_STR = 7;
const SLOT_CLEAR_HWND_PROPS = 9;

type BindingType = "u64" | "u32" | "i32" | "ptr";

/**
 * Own IAccPropServices and the per-window accessible name annotations applied through it.
 *
 * The object is created lazily on first use and must only be called from the UI STA. The Win32
 * window manager owns the instance. This class does not initialize or release COM: the STA is
 * owned by ui.ts (or by the caller when Windows is used without it), so the instance must be
 * disposed before that owner calls CoUninitialize. IAccPropServices has no getter, so the last applied value of
 * each window is cached in this process and the cache is the source of `get`.
 *
 * COM symbols stay in this module (not win32-bindings) so fixture mocks of win32-bindings do not
 * need AccProp-only exports.
 */
export class AccessibleTitles {
  private object: Pointer | null = null;
  private library: ReturnType<typeof openLibrary> | undefined;
  private readonly bindings: ReturnType<typeof CFunction>[] = [];
  private release: (() => number) | undefined;
  private setName:
    | ((
        window: bigint,
        idObject: number,
        idChild: number,
        property: Pointer,
        text: Pointer,
      ) => number)
    | undefined;
  private clearName:
    | ((
        window: bigint,
        idObject: number,
        idChild: number,
        properties: Pointer,
        count: number,
      ) => number)
    | undefined;
  private readonly cache = new Map<bigint, string>();
  // Native calls read this buffer, so it is a field that outlives each call.
  private readonly nameProperty = guid("608d3df8-8128-4aa7-a428-f55e49267291");

  private bind(slot: number, args: BindingType[], returns: "i32" | "u32") {
    assert(this.object);
    const address = read.ptr(read.ptr(this.object), slot * 8);
    assert(address, "Null accessible title COM method");
    const binding = CFunction({
      ptr: address as Pointer,
      args: [
        "ptr",
        ...args,
      ],
      returns,
    });
    this.bindings.push(binding);
    const object = this.object;
    return (...values: (number | bigint | Pointer)[]) =>
      Number(binding(object, ...values));
  }

  private initialize() {
    if (this.object) {
      return;
    }
    const library = openLibrary();
    this.library = library;
    const out = new BigUint64Array(1);
    const clsid = guid("b5f8350b-0548-48b1-a6ee-88bd00b4a5e7");
    const iid = guid("6e26e776-04f0-495d-80e4-3330352e3169");
    try {
      checkHresult(
        library.symbols.CoCreateInstance(
          ptr(clsid),
          null,
          CLSCTX_SERVER,
          ptr(iid),
          ptr(out),
        ),
        "CoCreateInstance(IAccPropServices)",
      );
      assert(out[0], "Null accessible title COM object");
      this.object = Number(out[0]) as Pointer;
      this.release = this.bind(SLOT_RELEASE, [], "u32");
      // MSAAPROPID is a 16-byte GUID, which the x64 ABI passes by pointer.
      this.setName = this.bind(
        SLOT_SET_HWND_PROP_STR,
        [
          "u64",
          "u32",
          "u32",
          "ptr",
          "ptr",
        ],
        "i32",
      );
      this.clearName = this.bind(
        SLOT_CLEAR_HWND_PROPS,
        [
          "u64",
          "u32",
          "u32",
          "ptr",
          "i32",
        ],
        "i32",
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /**
   * Apply a screen reader name distinct from the caption, or restore the caption with "".
   * The cache changes only after the native call succeeds.
   */
  set(window: bigint, title: string): void {
    if (title === "") {
      this.clear(window);
      return;
    }
    this.initialize();
    assert(this.setName);
    const setName = this.setName;
    checkHresult(
      withWide(title, (text) =>
        setName(
          window,
          OBJID_CLIENT,
          CHILDID_SELF,
          ptr(this.nameProperty),
          text,
        ),
      ),
      "IAccPropServices.SetHwndPropStr",
    );
    this.cache.set(window, title);
  }

  /** Remove the annotation. Without a cached value nothing was applied, so COM is not touched. */
  clear(window: bigint): void {
    if (!this.cache.has(window)) {
      return;
    }
    this.clearNative(window);
    this.cache.delete(window);
  }

  /** Last applied name, or null when none is set. */
  get(window: bigint): string | null {
    return this.cache.get(window) ?? null;
  }

  /**
   * Drop the annotation just before the window is destroyed.
   * The cache entry is removed even when the native call throws, so a failure to clean up never
   * leaves a stale value for a recycled HWND. The caller decides how to report the failure.
   */
  forget(window: bigint): void {
    try {
      this.clear(window);
    } finally {
      this.cache.delete(window);
    }
  }

  private clearNative(window: bigint) {
    assert(this.clearName, "Accessible titles are not initialized");
    checkHresult(
      this.clearName(
        window,
        OBJID_CLIENT,
        CHILDID_SELF,
        ptr(this.nameProperty),
        1,
      ),
      "IAccPropServices.ClearHwndProps",
    );
  }

  /** Release the interface and bindings before the UI STA is uninitialized. Safe to repeat. */
  dispose(): void {
    this.release?.();
    this.release = undefined;
    this.object = null;
    this.setName = undefined;
    this.clearName = undefined;
    for (const binding of this.bindings.splice(0)) {
      binding.close();
    }
    this.library?.close();
    this.library = undefined;
    this.cache.clear();
  }
}

function openLibrary() {
  return dlopen("ole32.dll", {
    ...pick(OLE32, "CoCreateInstance"),
  });
}
