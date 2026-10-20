import { failWithCleanup, ResourceOwner } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import {
  DEFAULT_CAPTURE_EDGE_PIXELS,
  MAX_CAPTURE_PNG_BYTES,
  MAX_SOURCE_NAME_CHARS,
  MAX_SOURCE_PIXELS,
  MAX_SOURCES,
  type ScreenCaptureImage,
  type ScreenCaptureInput,
  type ScreenCaptureInstance,
  type ScreenCaptureListInput,
  type ScreenCaptureSource,
} from "#screen-capture/contract";
import { encodePng } from "#screen-capture/platforms/png";

/** A rectangle in physical pixels: top-left corner and size. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What Windows reports about one top-level window at the moment it is read. */
export interface WindowFacts {
  title: string;
  visible: boolean;
  minimized: boolean;
  /** Hidden by the shell, for example because the window lives on another virtual desktop. */
  cloaked: boolean;
  hasOwner: boolean;
  toolWindow: boolean;
  /** `SetWindowDisplayAffinity` value; anything but 0 asks Windows to hide the content from capture. */
  displayAffinity: number;
  hung: boolean;
  pid: number;
  tid: number;
  /** The window rectangle including the invisible resize border. */
  windowRect: Rect;
  /** The visible frame without the shadow border, or null when DWM cannot report it. */
  frameRect: Rect | null;
}

export interface MonitorFacts {
  /** Device name such as `\\.\DISPLAY1`, the same id the host's monitor API uses. */
  deviceName: string;
  bounds: Rect;
}

/** A top-down 32 bits-per-pixel bitmap section; `pixels` views the memory GDI draws into. */
export interface Dib {
  bitmap: bigint;
  pixels: Uint8Array;
}

/**
 * The native calls a capture needs. The real implementation wraps user32, gdi32 and dwmapi;
 * every handle-returning call reports failure as 0n and every BOOL call as false.
 */
export interface CaptureBindings {
  /** Switch the calling thread to per-monitor-v2 awareness and return the previous context, or 0n on failure. */
  setDpiAwareness(): bigint;
  restoreDpiAwareness(previous: bigint): boolean;
  /** Top-level windows in z-order. */
  listWindows(): bigint[];
  shellWindow(): bigint;
  /** Facts of a window, or null when the handle no longer names one. */
  windowFacts(window: bigint): WindowFacts | null;
  listMonitors(): MonitorFacts[];
  getScreenDc(): bigint;
  releaseScreenDc(dc: bigint): boolean;
  createMemoryDc(compatible: bigint): bigint;
  deleteDc(dc: bigint): boolean;
  createDib(compatible: bigint, width: number, height: number): Dib | null;
  selectObject(dc: bigint, object: bigint): bigint;
  deleteObject(object: bigint): boolean;
  /** Finish batched GDI drawing before the bitmap memory is read. */
  flush(): void;
  printWindow(window: bigint, dc: bigint): boolean;
  /** Copy a region, scaling when the sizes differ; `fromScreen` also includes layered windows. */
  blit(
    target: bigint,
    targetSize: Size,
    source: bigint,
    sourceRect: Rect,
    fromScreen: boolean,
  ): boolean;
}

interface Size {
  width: number;
  height: number;
}

type SourceRef =
  | {
      kind: "window";
      window: bigint;
      pid: number;
      tid: number;
    }
  | {
      kind: "screen";
      deviceName: string;
    };

interface Placed {
  id: string;
  ref: SourceRef;
}

/** Reasons carried in `details.reason` so callers can tell apart failures that share an error code. */
const REASON = {
  notFound: "SOURCE_NOT_FOUND",
  unavailable: "SOURCE_UNAVAILABLE",
  protected: "SOURCE_PROTECTED",
  notResponding: "SOURCE_NOT_RESPONDING",
  tooLarge: "CAPTURE_TOO_LARGE",
} as const;
const DISPOSE_MESSAGE = "Screen capture resources failed to release.";
const BYTES_PER_PIXEL = 4;

function fail(
  code: "INVALID_ARGUMENT" | "PERMISSION_DENIED" | "BUSY" | "INTERNAL",
  message: string,
  reason?: string,
): never {
  throw new BunawayError({
    code,
    message,
    ...(reason === undefined
      ? {}
      : {
          details: {
            reason,
          },
        }),
  });
}

function unavailable(): never {
  return fail(
    "INVALID_ARGUMENT",
    "The capture source cannot be captured now.",
    REASON.unavailable,
  );
}

function protectedWindow(): never {
  return fail(
    "PERMISSION_DENIED",
    "The window excludes itself from capture.",
    REASON.protected,
  );
}

function refKey(ref: SourceRef): string {
  return ref.kind === "window"
    ? `window:${ref.window}:${ref.pid}:${ref.tid}`
    : `screen:${ref.deviceName}`;
}

/** Cut a name to the contract limit without leaving half of a surrogate pair. */
export function truncateName(name: string): string {
  if (name.length <= MAX_SOURCE_NAME_CHARS) {
    return name;
  }
  const last = name.charCodeAt(MAX_SOURCE_NAME_CHARS - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return name.slice(0, MAX_SOURCE_NAME_CHARS - (splitsPair ? 1 : 0));
}

/** Fit `source` into the box without enlarging it, keeping the aspect ratio and at least one pixel per side. */
export function fitSize(
  source: Size,
  maxWidth: number,
  maxHeight: number,
): Size {
  const scale = Math.min(maxWidth / source.width, maxHeight / source.height, 1);
  return {
    width: Math.min(maxWidth, Math.max(1, Math.round(source.width * scale))),
    height: Math.min(maxHeight, Math.max(1, Math.round(source.height * scale))),
  };
}

function checked(done: boolean, what: string): void {
  if (!done) {
    throw new Error(`${what} failed.`);
  }
}

function toBounds(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
}

/**
 * Lists monitors and top-level windows and captures one as a PNG. Source ids are random session
 * ids mapped to the native source, so a recycled window handle never reaches another window.
 * Calls run on the host I/O worker one at a time, which is the only concurrency limit.
 */
export class WindowsScreenCapture implements ScreenCaptureInstance {
  private readonly sources = new Map<string, SourceRef>();
  private disposed = false;

  constructor(
    private readonly native: CaptureBindings,
    private readonly appPid: number,
    /** Releases the native libraries behind `native`; called once, when the adapter is disposed. */
    private readonly releaseNative: () => void = () => undefined,
  ) {}

  listSources(input: ScreenCaptureListInput): ScreenCaptureSource[] {
    this.assertActive();
    return this.inDpiScope(() => {
      const listed: ScreenCaptureSource[] = [];
      const placed: Placed[] = [];
      if (input.types.includes("screen")) {
        this.collectScreens(listed, placed);
      }
      if (input.types.includes("window")) {
        this.collectWindows(listed, placed);
      }
      if (listed.length > MAX_SOURCES) {
        fail("INTERNAL", "Too many capture sources.");
      }
      this.replaceListed(input, placed);
      return listed;
    });
  }

  captureSource(input: ScreenCaptureInput): ScreenCaptureImage {
    this.assertActive();
    const ref = this.sources.get(input.id);
    if (ref === undefined) {
      return fail(
        "INVALID_ARGUMENT",
        "Unknown capture source.",
        REASON.notFound,
      );
    }
    const maxWidth = input.maxWidth ?? DEFAULT_CAPTURE_EDGE_PIXELS;
    const maxHeight = input.maxHeight ?? DEFAULT_CAPTURE_EDGE_PIXELS;
    const { pixels, size } = this.inDpiScope(() =>
      ref.kind === "window"
        ? this.captureWindow(ref, maxWidth, maxHeight)
        : this.captureScreen(ref, maxWidth, maxHeight),
    );
    const png = encodePng(pixels, size.width, size.height);
    if (png.length > MAX_CAPTURE_PNG_BYTES) {
      fail(
        "INVALID_ARGUMENT",
        "The captured image exceeds the size limit.",
        REASON.tooLarge,
      );
    }
    return {
      mime: "image/png",
      data: png.toString("base64"),
      width: size.width,
      height: size.height,
    };
  }

  /** Refuse later calls, forget every source id and release the native libraries; repeating does nothing. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.sources.clear();
    this.releaseNative();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Screen capture adapter is disposed.",
      });
    }
  }

  /** Run `work` with per-monitor-v2 awareness so every rectangle and bitmap size is in physical pixels. */
  private inDpiScope<T>(work: () => T): T {
    const previous = this.native.setDpiAwareness();
    if (previous === 0n) {
      fail("INTERNAL", "Screen capture could not set DPI awareness.");
    }
    let result: T;
    try {
      result = work();
    } catch (error) {
      failWithCleanup(
        error,
        () =>
          checked(
            this.native.restoreDpiAwareness(previous),
            "Restoring DPI awareness",
          ),
        DISPOSE_MESSAGE,
      );
    }
    checked(
      this.native.restoreDpiAwareness(previous),
      "Restoring DPI awareness",
    );
    return result;
  }

  /** Keep the id of a source that is still present so an id from an earlier listing stays usable. */
  private idFor(ref: SourceRef): string {
    const key = refKey(ref);
    for (const [id, known] of this.sources) {
      if (refKey(known) === key) {
        return id;
      }
    }
    return crypto.randomUUID();
  }

  private replaceListed(input: ScreenCaptureListInput, placed: Placed[]): void {
    for (const [id, ref] of this.sources) {
      if (input.types.includes(ref.kind)) {
        this.sources.delete(id);
      }
    }
    for (const { id, ref } of placed) {
      this.sources.set(id, ref);
    }
  }

  private collectScreens(
    listed: ScreenCaptureSource[],
    placed: Placed[],
  ): void {
    this.native.listMonitors().forEach((monitor, index) => {
      const ref: SourceRef = {
        kind: "screen",
        deviceName: monitor.deviceName,
      };
      const id = this.idFor(ref);
      placed.push({
        id,
        ref,
      });
      listed.push({
        id,
        kind: "screen",
        name: `Screen ${index + 1}`,
        bounds: toBounds(monitor.bounds),
        ownedByApp: false,
        minimized: false,
        monitorId: truncateName(monitor.deviceName),
      });
    });
  }

  private collectWindows(
    listed: ScreenCaptureSource[],
    placed: Placed[],
  ): void {
    const shell = this.native.shellWindow();
    for (const window of this.native.listWindows()) {
      const facts = this.native.windowFacts(window);
      if (facts === null || window === shell || !isListed(facts)) {
        continue;
      }
      const ref: SourceRef = {
        kind: "window",
        window,
        pid: facts.pid,
        tid: facts.tid,
      };
      const id = this.idFor(ref);
      placed.push({
        id,
        ref,
      });
      listed.push({
        id,
        kind: "window",
        name: truncateName(facts.title),
        bounds: toBounds(facts.frameRect ?? facts.windowRect),
        ownedByApp: facts.pid === this.appPid,
        minimized: facts.minimized,
      });
    }
  }

  private captureScreen(
    ref: Extract<
      SourceRef,
      {
        kind: "screen";
      }
    >,
    maxWidth: number,
    maxHeight: number,
  ) {
    const monitor = this.native
      .listMonitors()
      .find((candidate) => candidate.deviceName === ref.deviceName);
    if (monitor === undefined) {
      fail("INVALID_ARGUMENT", "The monitor is gone.", REASON.notFound);
    }
    if (monitor.bounds.width <= 0 || monitor.bounds.height <= 0) {
      unavailable();
    }
    const size = fitSize(monitor.bounds, maxWidth, maxHeight);
    return this.drawInto(size, (screen, target) => {
      checked(
        this.native.blit(target, size, screen, monitor.bounds, true),
        "Screen copy",
      );
    });
  }

  private captureWindow(
    ref: Extract<
      SourceRef,
      {
        kind: "window";
      }
    >,
    maxWidth: number,
    maxHeight: number,
  ) {
    const facts = this.native.windowFacts(ref.window);
    if (facts === null || facts.pid !== ref.pid || facts.tid !== ref.tid) {
      fail("INVALID_ARGUMENT", "The window is gone.", REASON.notFound);
    }
    if (!facts.visible || facts.minimized || facts.cloaked) {
      unavailable();
    }
    if (facts.displayAffinity !== 0) {
      protectedWindow();
    }
    if (facts.hung) {
      fail("BUSY", "The window is not responding.", REASON.notResponding);
    }
    const full = facts.windowRect;
    if (full.width <= 0 || full.height <= 0) {
      unavailable();
    }
    if (full.width * full.height > MAX_SOURCE_PIXELS) {
      fail(
        "INVALID_ARGUMENT",
        "The window is too large to capture.",
        REASON.tooLarge,
      );
    }
    const visible = cropToVisibleFrame(full, facts.frameRect);
    const size = fitSize(visible, maxWidth, maxHeight);
    return this.drawInto(size, (screen, target, owner) => {
      // The window renders at full size into its own bitmap, then the visible part is copied scaled.
      const memory = this.memoryDc(owner, screen);
      this.dibIn(owner, screen, memory, full);
      const printed = this.native.printWindow(ref.window, memory);
      this.native.flush();
      // The window may have closed or asked for exclusion while it was drawn; do not return that
      // content. The window state is checked before a failed draw is reported, because a window
      // that is destroyed, hidden or protected mid-draw makes the draw fail.
      const after = this.native.windowFacts(ref.window);
      if (after === null || after.pid !== ref.pid || after.tid !== ref.tid) {
        fail("INVALID_ARGUMENT", "The window is gone.", REASON.notFound);
      }
      if (after.displayAffinity !== 0) {
        protectedWindow();
      }
      if (!after.visible || after.minimized || after.cloaked) {
        unavailable();
      }
      checked(printed, "PrintWindow");
      checked(
        this.native.blit(target, size, memory, visible, false),
        "Window copy",
      );
    });
  }

  /**
   * Own the screen DC and a target bitmap of `size`, let `draw` fill it, and return a private copy
   * of its pixels after every GDI object is released. `draw` may acquire more objects from `owner`.
   */
  private drawInto(
    size: Size,
    draw: (screen: bigint, target: bigint, owner: ResourceOwner) => void,
  ) {
    const owner = new ResourceOwner("Screen capture GDI");
    let pixels: Uint8Array;
    try {
      const screen = owner.acquire(
        () => this.nonZero(this.native.getScreenDc(), "GetDC"),
        (dc) => checked(this.native.releaseScreenDc(dc), "ReleaseDC"),
      );
      const targetDc = this.memoryDc(owner, screen);
      const target = this.dibIn(owner, screen, targetDc, size);
      draw(screen, targetDc, owner);
      this.native.flush();
      // Copy before release: the view points into memory GDI frees with the bitmap.
      pixels = target.pixels.slice(
        0,
        size.width * size.height * BYTES_PER_PIXEL,
      );
    } catch (error) {
      failWithCleanup(error, () => owner.dispose(), DISPOSE_MESSAGE);
    }
    owner.dispose();
    return {
      pixels,
      size,
    };
  }

  private nonZero(handle: bigint, what: string): bigint {
    if (handle === 0n) {
      throw new Error(`${what} failed.`);
    }
    return handle;
  }

  private memoryDc(owner: ResourceOwner, compatible: bigint): bigint {
    return owner.acquire(
      () =>
        this.nonZero(
          this.native.createMemoryDc(compatible),
          "CreateCompatibleDC",
        ),
      (dc) => checked(this.native.deleteDc(dc), "DeleteDC"),
    );
  }

  /** Create a bitmap of the rectangle's size and select it into `dc`; both are released in reverse order. */
  private dibIn(
    owner: ResourceOwner,
    compatible: bigint,
    dc: bigint,
    area: Size,
  ): Dib {
    const dib = owner.acquire(
      () => {
        const created = this.native.createDib(
          compatible,
          area.width,
          area.height,
        );
        if (created === null || created.bitmap === 0n) {
          throw new Error("CreateDIBSection failed.");
        }
        return created;
      },
      (created) =>
        checked(this.native.deleteObject(created.bitmap), "DeleteObject"),
    );
    owner.acquire(
      () =>
        this.nonZero(this.native.selectObject(dc, dib.bitmap), "SelectObject"),
      (previous) =>
        checked(
          this.native.selectObject(dc, previous) !== 0n,
          "SelectObject restore",
        ),
    );
    return dib;
  }
}

/** Whether a window belongs in the list: an ordinary visible, titled, top-level window. */
function isListed(facts: WindowFacts): boolean {
  return (
    facts.visible &&
    !facts.hasOwner &&
    !facts.toolWindow &&
    !facts.cloaked &&
    facts.title !== ""
  );
}

/**
 * The part of the window rectangle to copy, relative to the window's own bitmap. The visible frame
 * leaves out the invisible resize border; without a frame the whole rectangle is used.
 */
function cropToVisibleFrame(full: Rect, frame: Rect | null): Rect {
  if (frame === null) {
    return {
      x: 0,
      y: 0,
      width: full.width,
      height: full.height,
    };
  }
  const left = Math.min(Math.max(frame.x - full.x, 0), full.width);
  const top = Math.min(Math.max(frame.y - full.y, 0), full.height);
  const right = Math.min(
    Math.max(frame.x + frame.width - full.x, left),
    full.width,
  );
  const bottom = Math.min(
    Math.max(frame.y + frame.height - full.y, top),
    full.height,
  );
  if (right - left <= 0 || bottom - top <= 0) {
    return unavailable();
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}
