import {
  CString,
  dlopen,
  JSCallback,
  linkSymbols,
  type Pointer,
  ptr,
  read,
} from "bun:ffi";

const OBJC = "/usr/lib/libobjc.A.dylib";
const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const WEBKIT = "/System/Library/Frameworks/WebKit.framework/WebKit";
const BLOCK_IS_GLOBAL = 1 << 28;
const BLOCK_HAS_SIGNATURE = 1 << 30;
const NS_WINDOW_STYLE_TITLED = 1n;
const NS_WINDOW_STYLE_CLOSABLE = 2n;
const NS_WINDOW_STYLE_MINIATURIZABLE = 4n;
const NS_WINDOW_STYLE_RESIZABLE = 8n;
const NS_BACKING_STORE_BUFFERED = 2n;

/** Objective-C tagged objects can use all 64 bits and must stay bigint in FFI calls. */
export type ObjcObject = Pointer | bigint;
function pointer(value: ObjcObject | null): ObjcObject | null {
  return value === null || value === 0n ? null : value;
}

/** Objective-C runtime bindings. No project-owned native binary or compiler is required. */
export class Objc {
  private readonly frameworks = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: {
      args: [
        "cstring",
        "i32",
      ],
      returns: "ptr",
    },
  } as const);
  // System framework handles, delegate classes and callbacks live until process exit.
  private readonly systemHandle = this.frameworks.symbols.dlopen(
    ptr(Buffer.from("/usr/lib/libSystem.B.dylib\0")),
    1,
  );
  private readonly objcHandle = this.frameworks.symbols.dlopen(
    ptr(Buffer.from(`${OBJC}\0`)),
    1,
  );
  private readonly appkit = this.frameworks.symbols.dlopen(
    ptr(Buffer.from(`${APPKIT}\0`)),
    1,
  );
  private readonly webkit = this.frameworks.symbols.dlopen(
    ptr(Buffer.from(`${WEBKIT}\0`)),
    1,
  );
  private readonly runtime = dlopen(OBJC, {
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
    objc_allocateClassPair: {
      args: [
        "ptr",
        "cstring",
        "usize",
      ],
      returns: "ptr",
    },
    objc_registerClassPair: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
    class_addMethod: {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "cstring",
      ],
      returns: "bool",
    },
    objc_msgSend: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "ptr",
    },
  } as const);
  private readonly system = dlopen("/usr/lib/libSystem.B.dylib", {
    dlsym: {
      args: [
        "ptr",
        "cstring",
      ],
      returns: "ptr",
    },
    pthread_main_np: {
      args: [],
      returns: "i32",
    },
  } as const);
  private readonly messageAddress = this.system.symbols.dlsym(
    this.objcHandle,
    ptr(Buffer.from("objc_msgSend\0")),
  );
  private readonly messages = linkSymbols({
    send: {
      ptr: this.messageAddress as Pointer,
      args: [
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "ptr",
    },
    window: {
      ptr: this.messageAddress as Pointer,
      args: [
        "ptr",
        "ptr",
        "f64",
        "f64",
        "f64",
        "f64",
        "u64",
        "u64",
        "bool",
      ],
      returns: "ptr",
    },
    webview: {
      ptr: this.messageAddress as Pointer,
      args: [
        "ptr",
        "ptr",
        "f64",
        "f64",
        "f64",
        "f64",
        "ptr",
      ],
      returns: "ptr",
    },
    size: {
      ptr: this.messageAddress as Pointer,
      args: [
        "ptr",
        "ptr",
        "f64",
        "f64",
      ],
      returns: "void",
    },
    event: {
      ptr: this.messageAddress as Pointer,
      args: [
        "ptr",
        "ptr",
        "u64",
        "ptr",
        "ptr",
        "bool",
      ],
      returns: "ptr",
    },
  } as const);
  private readonly selectors = new Map<string, ObjcObject>();
  private readonly callbacks: JSCallback[] = [];
  private readonly blocks: {
    bytes: Buffer;
    descriptor: Buffer;
    signature: Buffer;
  }[] = [];

  constructor() {
    if (!this.appkit || !this.webkit || !this.messageAddress) {
      throw new Error("macOS system frameworks are unavailable.");
    }
    if (!this.system.symbols.pthread_main_np()) {
      throw new Error("AppKit requires Bun's main thread.");
    }
  }

  private cstring(value: string) {
    return Buffer.from(`${value}\0`);
  }
  selector(name: string): ObjcObject {
    let value = this.selectors.get(name);
    if (!value) {
      value =
        pointer(
          this.runtime.symbols.sel_registerName(ptr(this.cstring(name))),
        ) ?? undefined;
      if (!value) {
        throw new Error(`Objective-C selector unavailable: ${name}`);
      }
      this.selectors.set(name, value);
    }
    return value;
  }
  class(name: string): ObjcObject {
    const value = pointer(
      this.runtime.symbols.objc_getClass(ptr(this.cstring(name))),
    );
    if (!value) {
      throw new Error(`Objective-C class unavailable: ${name}`);
    }
    return value;
  }
  /** Send object/integer-only messages. All unused argument registers are zeroed. */
  send(
    object: ObjcObject | null,
    selector: string,
    ...args: (ObjcObject | number | null)[]
  ): ObjcObject | null {
    if (args.length > 6) {
      throw new Error("Too many Objective-C message arguments.");
    }
    // Object addresses and small integer arguments share arm64 general-purpose
    // registers. Assertions stay at this ABI boundary, never on app input.
    const registers = args.map((value) => value as ObjcObject | null);
    return pointer(
      this.messages.symbols.send(
        object,
        this.selector(selector),
        registers[0] ?? null,
        registers[1] ?? null,
        registers[2] ?? null,
        registers[3] ?? null,
        registers[4] ?? null,
        registers[5] ?? null,
      ),
    );
  }
  string(value: string): ObjcObject {
    const result = this.send(
      this.class("NSString"),
      "stringWithUTF8String:",
      ptr(this.cstring(value)),
    );
    if (!result) {
      throw new Error("NSString creation failed.");
    }
    return result;
  }
  text(value: ObjcObject | null): string {
    const bytes = this.send(value, "UTF8String");
    return bytes ? new CString(Number(bytes) as Pointer).toString() : "";
  }
  object(name: string): ObjcObject {
    const value = this.send(this.send(this.class(name), "alloc"), "init");
    if (!value) {
      throw new Error(`Objective-C initialization failed: ${name}`);
    }
    return value;
  }
  /**
   * Drain temporary Cocoa objects after synchronous work, including failure.
   * Only copied JavaScript values or retained native objects may outlive the callback.
   */
  withAutoreleasePool<T>(work: () => T): T {
    const pool = this.object("NSAutoreleasePool");
    try {
      return work();
    } finally {
      this.send(pool, "drain");
    }
  }
  /** Register delegate methods and retain callbacks until all native delegates are detached. */
  delegate(
    methods: {
      selector: string;
      arguments: number;
      returns?: "void" | "bool" | "ptr";
      encoding: string;
      call(...args: (Pointer | null)[]): unknown;
    }[],
  ): ObjcObject {
    const name = `BunawayDelegate${crypto.randomUUID().replaceAll("-", "")}`;
    const type = pointer(
      this.runtime.symbols.objc_allocateClassPair(
        this.class("NSObject"),
        ptr(this.cstring(name)),
        0,
      ),
    );
    if (!type) {
      throw new Error("Objective-C delegate allocation failed.");
    }
    for (const method of methods) {
      const callback = new JSCallback(method.call, {
        args: Array.from(
          {
            length: method.arguments + 2,
          },
          () => "ptr" as const,
        ),
        returns: method.returns ?? "void",
      } as const);
      this.callbacks.push(callback);
      if (
        !this.runtime.symbols.class_addMethod(
          type,
          this.selector(method.selector),
          callback.ptr,
          ptr(this.cstring(method.encoding)),
        )
      ) {
        throw new Error(
          `Objective-C method registration failed: ${method.selector}`,
        );
      }
    }
    this.runtime.symbols.objc_registerClassPair(type);
    const value = this.send(this.send(type, "alloc"), "init");
    if (!value) {
      throw new Error("Delegate initialization failed.");
    }
    return value;
  }
  /**
   * Create a process-owned global Blocks ABI value for WebKit's main-thread completions.
   * Native copies retain this pointer; the buffers and JSCallback live until process exit.
   * No JavaScript copy/dispose callback can run on a foreign native thread.
   */
  block(
    argumentsCount: number,
    call: (...args: (Pointer | null)[]) => void,
  ): Pointer {
    const invoke = new JSCallback(call, {
      args: Array.from(
        {
          length: argumentsCount + 1,
        },
        () => "ptr" as const,
      ),
      returns: "void",
    } as const);
    this.callbacks.push(invoke);
    const signature = this.cstring(`v@?${"@".repeat(argumentsCount)}`);
    const descriptor = Buffer.alloc(24);
    descriptor.writeBigUInt64LE(32n, 8);
    descriptor.writeBigUInt64LE(BigInt(ptr(signature)), 16);
    const bytes = Buffer.alloc(32);
    const blockClass = this.system.symbols.dlsym(
      this.systemHandle,
      ptr(this.cstring("_NSConcreteGlobalBlock")),
    );
    if (!blockClass) {
      throw new Error("Blocks runtime unavailable.");
    }
    bytes.writeBigUInt64LE(BigInt(blockClass), 0);
    bytes.writeUInt32LE(BLOCK_IS_GLOBAL | BLOCK_HAS_SIGNATURE, 8);
    bytes.writeBigUInt64LE(BigInt(invoke.ptr ?? 0), 16);
    bytes.writeBigUInt64LE(BigInt(ptr(descriptor)), 24);
    this.blocks.push({
      bytes,
      descriptor,
      signature,
    });
    return ptr(bytes);
  }
  /** Invoke a native decision block exactly once with its integer decision. */
  decide(block: Pointer | null, decision: number): void {
    if (!block) {
      throw new Error("Missing WebKit decision handler.");
    }
    const address = read.ptr(block, 16) as Pointer;
    // Blocks ABI stores the callable invoke pointer at offset 16 on arm64.
    const invoke = linkSymbols({
      invoke: {
        ptr: address,
        args: [
          "ptr",
          "i64",
        ],
        returns: "void",
      },
    } as const);
    try {
      invoke.symbols.invoke(block, decision);
    } finally {
      invoke.close();
    }
  }
  window(width: number, height: number): ObjcObject {
    // AAPCS64 treats NSRect as a homogeneous aggregate of four doubles.
    // Its fields occupy FP registers independently of the following integer flags.
    const window = pointer(
      this.messages.symbols.window(
        this.send(this.class("NSWindow"), "alloc"),
        this.selector("initWithContentRect:styleMask:backing:defer:"),
        0,
        0,
        width,
        height,
        NS_WINDOW_STYLE_TITLED |
          NS_WINDOW_STYLE_CLOSABLE |
          NS_WINDOW_STYLE_MINIATURIZABLE |
          NS_WINDOW_STYLE_RESIZABLE,
        NS_BACKING_STORE_BUFFERED,
        false,
      ),
    );
    if (!window) {
      throw new Error("NSWindow creation failed.");
    }
    this.send(window, "setReleasedWhenClosed:", 0);
    return window;
  }
  webview(
    width: number,
    height: number,
    configuration: ObjcObject,
  ): ObjcObject {
    const result = pointer(
      this.messages.symbols.webview(
        this.send(this.class("WKWebView"), "alloc"),
        this.selector("initWithFrame:configuration:"),
        0,
        0,
        width,
        height,
        configuration,
      ),
    );
    if (!result) {
      throw new Error("WKWebView creation failed.");
    }
    return result;
  }
  /** Pass NSSize's two doubles in arm64 floating-point registers to a size setter. */
  setSize(
    object: ObjcObject,
    selector: string,
    width: number,
    height: number,
  ): void {
    this.messages.symbols.size(object, this.selector(selector), width, height);
  }
  nextEvent(app: ObjcObject): ObjcObject | null {
    return pointer(
      this.messages.symbols.event(
        app,
        this.selector("nextEventMatchingMask:untilDate:inMode:dequeue:"),
        0xffffffffffffffffn,
        this.send(this.class("NSDate"), "distantPast"),
        this.string("kCFRunLoopDefaultMode"),
        true,
      ),
    );
  }
}
