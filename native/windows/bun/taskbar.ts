import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import { checkHresult, OLE32, pick, wide } from "@bunaway/plugin/win32";
import assert from "node:assert/strict";
import { guid } from "./guid.ts";
import type { TaskbarProgress } from "./taskbar-progress.ts";
import type { PixelRect } from "./window-size.ts";

const CLSCTX_INPROC_SERVER = 1;
const PROGRESS_TOTAL = 1_000_000;
const flags = {
  none: 0,
  indeterminate: 1,
  normal: 2,
  error: 4,
  paused: 8,
} as const;

/** Lazily own ITaskbarList3 and its FFI bindings on the UI STA, without WebView COM cache ownership. */
export class Taskbar {
  private object: Pointer | null = null;
  private library: ReturnType<typeof openLibrary> | undefined;
  private readonly bindings: ReturnType<typeof CFunction>[] = [];
  private release: (() => number) | undefined;
  private value:
    | ((window: bigint, completed: bigint, total: bigint) => number)
    | undefined;
  private state: ((window: bigint, flag: number) => number) | undefined;
  private tooltip: ((window: bigint, text: number) => number) | undefined;
  private clip: ((window: bigint, rect: number) => number) | undefined;

  private bind(
    slot: number,
    args: ("u64" | "u32" | "ptr")[],
    returns: "i32" | "u32" = "i32",
  ) {
    assert(this.object);
    const address = read.ptr(read.ptr(this.object), slot * 8);
    assert(address, "Null taskbar COM method");
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
    return (...values: (number | bigint)[]) =>
      Number(binding(object, ...values));
  }

  private initialize() {
    if (this.object) {
      return;
    }
    this.library = openLibrary();
    const out = new BigUint64Array(1);
    const clsid = guid("56fdf344-fd6d-11d0-958a-006097c9a090");
    const iid = guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf");
    try {
      checkHresult(
        this.library.symbols.CoCreateInstance(
          ptr(clsid),
          null,
          CLSCTX_INPROC_SERVER,
          ptr(iid),
          ptr(out),
        ),
        "CoCreateInstance(ITaskbarList3)",
      );
      assert(out[0], "Null taskbar COM object");
      this.object = Number(out[0]) as Pointer;
      this.release = this.bind(2, [], "u32");
      checkHresult(this.bind(3, [])(), "ITaskbarList.HrInit");
      this.value = this.bind(9, [
        "u64",
        "u64",
        "u64",
      ]);
      this.state = this.bind(10, [
        "u64",
        "u32",
      ]);
      // ITaskbarList3 vtable: SetThumbnailTooltip follows SetOverlayIcon (18), then SetThumbnailClip.
      this.tooltip = this.bind(19, [
        "u64",
        "ptr",
      ]);
      this.clip = this.bind(20, [
        "u64",
        "ptr",
      ]);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Set value before state because SetProgressValue clears indeterminate mode. */
  apply(window: bigint, progress: TaskbarProgress): void {
    this.initialize();
    assert(this.state && this.value);
    if ("value" in progress) {
      checkHresult(
        this.value(
          window,
          BigInt(Math.round(progress.value * PROGRESS_TOTAL)),
          BigInt(PROGRESS_TOTAL),
        ),
        "ITaskbarList3.SetProgressValue",
      );
    }
    checkHresult(
      this.state(window, flags[progress.state]),
      "ITaskbarList3.SetProgressState",
    );
  }

  /** Show only `rect` (client-area physical pixels) in the thumbnail; null shows the whole client area. */
  setThumbnailClip(window: bigint, rect: PixelRect | null): void {
    this.initialize();
    assert(this.clip);
    // RECT is four int32 values: left, top, right, bottom. The buffer lives through the synchronous call.
    const native = rect
      ? Buffer.from(
          new Int32Array([
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
          ]).buffer,
        )
      : null;
    checkHresult(
      this.clip(window, native ? ptr(native) : 0),
      "ITaskbarList3.SetThumbnailClip",
    );
  }

  /** Set the thumbnail tooltip text; null restores the default (the window title). */
  setThumbnailToolTip(window: bigint, toolTip: string | null): void {
    this.initialize();
    assert(this.tooltip);
    const native = toolTip === null ? null : wide(toolTip);
    checkHresult(
      this.tooltip(window, native ? ptr(native) : 0),
      "ITaskbarList3.SetThumbnailTooltip",
    );
  }

  /** Release the interface and bindings before the UI STA is uninitialized. Safe to repeat. */
  dispose(): void {
    this.release?.();
    this.release = undefined;
    this.object = null;
    this.value = undefined;
    this.state = undefined;
    this.tooltip = undefined;
    this.clip = undefined;
    for (const binding of this.bindings.splice(0)) {
      binding.close();
    }
    this.library?.close();
    this.library = undefined;
  }
}

function openLibrary() {
  return dlopen("ole32.dll", {
    ...pick(OLE32, "CoCreateInstance"),
  });
}
