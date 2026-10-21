import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import assert from "node:assert/strict";
import { checkHresult, OLE32, pick, wide } from "@bunaway/plugin/win32";
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

// THUMBBUTTON (x64): dwMask u32 @0, iId u32 @4, iBitmap u32 @8, hIcon @16, szTip[260] WCHAR @24, dwFlags u32 @544.
const THUMB_BUTTON_SIZE = 552;
const THUMB_BUTTON_ICON_OFFSET = 16;
const THUMB_BUTTON_TIP_OFFSET = 24;
const THUMB_BUTTON_FLAGS_OFFSET = 544;
/** `szTip` holds 260 UTF-16 code units including the terminator. */
const THUMB_BUTTON_TIP_UNITS = 260;
const THB_ICON = 0x2;
const THB_TOOLTIP = 0x4;
const THB_FLAGS = 0x8;

/** One THUMBBUTTON slot; an absent `icon` leaves the slot with flags only (hidden, unused). */
export type ThumbnailButtonSlot = {
  id: number;
  icon?: bigint;
  tooltip: string;
  flags: number;
};

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
  private overlay:
    | ((window: bigint, icon: bigint, description: number) => number)
    | undefined;
  private tooltip: ((window: bigint, text: number) => number) | undefined;
  private clip: ((window: bigint, rect: number) => number) | undefined;
  private addButtons:
    | ((window: bigint, count: number, buttons: number) => number)
    | undefined;
  private updateButtons:
    | ((window: bigint, count: number, buttons: number) => number)
    | undefined;

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
      // ITaskbarList3 vtable: ThumbBarAddButtons (15) and ThumbBarUpdateButtons (16) precede
      // ThumbBarSetImageList (17) and SetOverlayIcon.
      this.addButtons = this.bind(15, [
        "u64",
        "u32",
        "ptr",
      ]);
      this.updateButtons = this.bind(16, [
        "u64",
        "u32",
        "ptr",
      ]);
      // ITaskbarList3 vtable: SetThumbnailTooltip follows SetOverlayIcon (18), then SetThumbnailClip.
      this.overlay = this.bind(18, [
        "u64",
        "u64",
        "ptr",
      ]);
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

  /**
   * Show `icon` (an HICON the caller keeps owning) over the taskbar button with an accessibility description,
   * or remove the overlay for 0. The caller keeps `icon` alive while it is shown and destroys it afterwards.
   */
  setOverlayIcon(window: bigint, icon: bigint, description: string): void {
    this.initialize();
    assert(this.overlay);
    const native = icon ? wide(description) : null;
    checkHresult(
      this.overlay(window, icon, native ? ptr(native) : 0),
      "ITaskbarList3.SetOverlayIcon",
    );
  }

  /**
   * Show `slots` as the window's thumbnail toolbar. Windows accepts ThumbBarAddButtons once per taskbar
   * button, so `add` selects it for the first call and ThumbBarUpdateButtons afterwards. The caller keeps
   * every icon HICON alive while it is shown and destroys it afterwards.
   */
  setThumbnailButtons(
    window: bigint,
    slots: readonly ThumbnailButtonSlot[],
    add: boolean,
  ): void {
    this.initialize();
    assert(this.addButtons && this.updateButtons);
    const native = Buffer.alloc(THUMB_BUTTON_SIZE * slots.length);
    slots.forEach((slot, index) => {
      const base = index * THUMB_BUTTON_SIZE;
      let mask = THB_FLAGS;
      if (slot.icon) {
        mask |= THB_ICON | THB_TOOLTIP;
        native.writeBigUInt64LE(slot.icon, base + THUMB_BUTTON_ICON_OFFSET);
        const tip = Buffer.from(slot.tooltip, "utf16le");
        assert(
          tip.length < THUMB_BUTTON_TIP_UNITS * 2,
          "Thumbnail button tooltip is too long",
        );
        tip.copy(native, base + THUMB_BUTTON_TIP_OFFSET);
      }
      native.writeUInt32LE(mask, base);
      native.writeUInt32LE(slot.id, base + 4);
      native.writeUInt32LE(slot.flags, base + THUMB_BUTTON_FLAGS_OFFSET);
    });
    // The buffer lives through the synchronous call; the shell copies the buttons.
    checkHresult(
      (add ? this.addButtons : this.updateButtons)(
        window,
        slots.length,
        ptr(native),
      ),
      add
        ? "ITaskbarList3.ThumbBarAddButtons"
        : "ITaskbarList3.ThumbBarUpdateButtons",
    );
  }

  /** Release the interface and bindings before the UI STA is uninitialized. Safe to repeat. */
  dispose(): void {
    this.release?.();
    this.release = undefined;
    this.object = null;
    this.value = undefined;
    this.state = undefined;
    this.overlay = undefined;
    this.tooltip = undefined;
    this.clip = undefined;
    this.addButtons = undefined;
    this.updateButtons = undefined;
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
