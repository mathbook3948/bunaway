import type { FFIType, Pointer } from "bun:ffi";
import {
  CFunction,
  dlopen,
  JSCallback,
  ptr,
  read,
  toArrayBuffer,
} from "bun:ffi";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import pin from "../../../runtime/build-manifests/windows-x64.json";
import type { ProbeWorkerData, ToUI } from "./worker.ts";

const WM_SIZE = 0x5;
const WM_CLOSE = 0x10;
const WM_QUIT = 0x12;
const WM_CANCELMODE = 0x1f;
const WM_ENTERSIZEMOVE = 0x231;
const WM_EXITSIZEMOVE = 0x232;
const WM_TIMER = 0x113;
const WM_SYSCOMMAND = 0x112;
const WS_OVERLAPPEDWINDOW = 0xcf0000;
const SW_SHOW = 5;
const SWP_NOMOVE = 0x2;
const SWP_NOZORDER = 0x4;
const SYNCHRONIZE = 0x100000;
const SC_SIZE = 0xf000n;
const SC_MOVE = 0xf010n;
const WMSZ_BOTTOMRIGHT = 0x8n;
const MODAL_TIMER_ID = 123n;

export async function runProbe(uiWorker: ProbeWorkerData | null = null) {
  const viewId = uiWorker?.viewId ?? "single";
  const input = uiWorker?.value ?? 21;
  const counters = uiWorker ? new Int32Array(uiWorker.counters) : undefined;

  // Standalone feasibility gate. Deliberately not a framework entry point.
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(Bun.version, pin.bun.version);
  assert.equal(Bun.revision, pin.bun.sourceRevision);
  const log = (event: string, data: object = {}) =>
    console.log(
      JSON.stringify({
        event,
        viewId,
        ...data,
      }),
    );
  const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le");
  const hr = (value: number, operation: string) => {
    if (value < 0) {
      throw new Error(`${operation}: 0x${(value >>> 0).toString(16)}`);
    }
  };
  const kernel = dlopen("kernel32.dll", {
    GetModuleHandleW: {
      args: [
        "ptr",
      ],
      returns: "u64",
    },
    GetCurrentThreadId: {
      args: [],
      returns: "u32",
    },
    GetLastError: {
      args: [],
      returns: "u32",
    },
    OpenProcess: {
      args: [
        "u32",
        "i32",
        "u32",
      ],
      returns: "u64",
    },
    WaitForSingleObject: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
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
    CoTaskMemFree: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
  });
  const user = dlopen("user32.dll", {
    RegisterClassExW: {
      args: [
        "ptr",
      ],
      returns: "u16",
    },
    UnregisterClassW: {
      args: [
        "ptr",
        "u64",
      ],
      returns: "i32",
    },
    CreateWindowExW: {
      args: [
        "u32",
        "ptr",
        "ptr",
        "u32",
        "i32",
        "i32",
        "i32",
        "i32",
        "u64",
        "u64",
        "u64",
        "ptr",
      ],
      returns: "u64",
    },
    DefWindowProcW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
    ShowWindow: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i32",
    },
    DestroyWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetClientRect: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    SetWindowPos: {
      args: [
        "u64",
        "u64",
        "i32",
        "i32",
        "i32",
        "i32",
        "u32",
      ],
      returns: "i32",
    },
    PeekMessageW: {
      args: [
        "ptr",
        "u64",
        "u32",
        "u32",
        "u32",
      ],
      returns: "i32",
    },
    TranslateMessage: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    DispatchMessageW: {
      args: [
        "ptr",
      ],
      returns: "i64",
    },
    SendMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
    PostMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i32",
    },
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
  const loader = dlopen(
    resolve(
      import.meta.dir,
      "../bun/vendor/sdk/build/native/x64/WebView2Loader.dll",
    ),
    {
      CreateCoreWebView2EnvironmentWithOptions: {
        args: [
          "ptr",
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    },
  );
  const thread = kernel.symbols.GetCurrentThreadId();
  log("runtime", {
    version: Bun.version,
    revision: Bun.revision,
    pid: process.pid,
    thread,
  });
  if (uiWorker) {
    assert(parentPort);
    assert.equal(
      process.pid,
      uiWorker.pid,
      "UI must share the backend process",
    );
    assert.notEqual(
      thread,
      uiWorker.thread,
      "UI must own a separate OS thread",
    );
    log("worker-identity", {
      pid: process.pid,
      backendThread: uiWorker.thread,
      uiThread: thread,
    });
  }

  type Arg = number | bigint | null;
  type Abi = FFIType | "ptr" | "i32" | "u32" | "i64" | "u64";
  type NativeCall = ((...values: Arg[]) => number) & {
    close(): void;
  };
  const methods = new Map<string, NativeCall>();
  function method(
    object: Pointer,
    slot: number,
    args: Abi[] = [],
    returns: Abi = "i32",
  ) {
    const address = read.ptr(read.ptr(object), slot * 8);
    assert(address, "Null COM method");
    const key = `${address}:${args}:${returns}`;
    let binding = methods.get(key);
    if (!binding) {
      binding = CFunction({
        ptr: address as Pointer,
        args: [
          "ptr",
          ...args,
        ],
        returns,
      }) as NativeCall;
      methods.set(key, binding);
    }
    return (...values: Arg[]) => binding(object, ...values);
  }
  const addRef = (object: Pointer) => method(object, 1, [], "u32")();
  const release = (object: Pointer) => method(object, 2, [], "u32")();
  function getString(object: Pointer, slot: number) {
    const out = new BigUint64Array(1);
    hr(
      method(object, slot, [
        "ptr",
      ])(ptr(out)),
      "get string",
    );
    const address = Number(out[0]) as Pointer;
    if (!address) {
      return "";
    }
    try {
      let bytes = 0;
      while (bytes < 2 * 1024 * 1024 && read.u16(address, bytes)) {
        bytes += 2;
      }
      assert(bytes < 2 * 1024 * 1024, "String limit exceeded");
      return Buffer.from(toArrayBuffer(address, 0, bytes)).toString("utf16le");
    } finally {
      ole.symbols.CoTaskMemFree(address);
    }
  }
  function guid(value: string) {
    const result = Buffer.from(value.replaceAll("-", ""), "hex");
    result.subarray(0, 4).reverse();
    result.subarray(4, 6).reverse();
    result.subarray(6, 8).reverse();
    return result;
  }
  const unknown = guid("00000000-0000-0000-c000-000000000046");
  let callbackDepth = 0;
  let maxCallbackDepth = 0;
  let invokeDepth = 0;
  let maxInvokeDepth = 0;
  let failure: unknown;
  let closing = false;
  type ComHandler = {
    name: string;
    object: BigUint64Array;
    vtable: BigUint64Array;
    callbacks: JSCallback[];
    pointer: Pointer;
    readonly refs: number;
    readonly calls: number;
    dropOwner(): void;
    dispose(): void;
  };
  const handlers: ComHandler[] = [];
  // COM retains these objects. Keep the vtable, object and trampolines strongly
  // reachable until COM releases its last reference AND the callback has returned.
  function handler(
    name: string,
    iid: string,
    args: Abi[],
    invoke: (...values: Arg[]) => void,
  ): ComHandler {
    let refs = 1;
    let calls = 0;
    const interfaceId = guid(iid);
    const object = new BigUint64Array(1);
    const wrap =
      (fn: (...values: Arg[]) => number) =>
      (...values: Arg[]) => {
        callbackDepth++;
        maxCallbackDepth = Math.max(callbackDepth, maxCallbackDepth);
        try {
          assert.equal(
            kernel.symbols.GetCurrentThreadId(),
            thread,
            `${name} foreign thread`,
          );
          assert(refs > 0, `${name} used after Release`);
          return fn(...values);
        } catch (error) {
          failure ??= error;
          closing = true;
          return -2147467259; // E_FAIL; never unwind JS exceptions through COM.
        } finally {
          callbackDepth--;
        }
      };
    const query = new JSCallback(
      wrap((_self, requested, out) => {
        if (!out) {
          return -2147467261; // E_POINTER
        }
        const output = new DataView(toArrayBuffer(out as Pointer, 0, 8));
        output.setBigUint64(0, 0n, true);
        if (!requested) {
          return -2147467261;
        }
        const id = Buffer.from(toArrayBuffer(requested as Pointer, 0, 16));
        if (!id.equals(unknown) && !id.equals(interfaceId)) {
          return -2147467262;
        }
        output.setBigUint64(0, BigInt(ptr(object)), true);
        refs++;
        return 0;
      }),
      {
        args: [
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    );
    const retain = new JSCallback(
      wrap(() => ++refs),
      {
        args: [
          "ptr",
        ],
        returns: "u32",
      },
    );
    const drop = new JSCallback(
      wrap(() => --refs),
      {
        args: [
          "ptr",
        ],
        returns: "u32",
      },
    );
    const call = new JSCallback(
      wrap((_self, ...values) => {
        calls++;
        invokeDepth++;
        maxInvokeDepth = Math.max(maxInvokeDepth, invokeDepth);
        try {
          invoke(...values);
        } finally {
          invokeDepth--;
        }
        return 0;
      }),
      {
        args: [
          "ptr",
          ...args,
        ],
        returns: "i32",
      },
    );
    const callbacks = [
      query,
      retain,
      drop,
      call,
    ];
    const vtable = new BigUint64Array(
      callbacks.map((callback) => BigInt(callback.ptr ?? 0)),
    );
    object[0] = BigInt(ptr(vtable));
    const result = {
      name,
      object,
      vtable,
      callbacks,
      pointer: ptr(object),
      get refs() {
        return refs;
      },
      get calls() {
        return calls;
      },
      dropOwner() {
        assert(refs > 0);
        refs--;
      },
      dispose() {
        assert.equal(refs, 0, `${name} outstanding COM refs`);
        for (const callback of callbacks) {
          callback.close();
        }
      },
    };
    handlers.push(result);
    return result;
  }

  let hwnd = 0n;
  let controller: Pointer | undefined;
  let webview: Pointer | undefined;
  let environment: Pointer | undefined;
  let environment5: Pointer | undefined;
  let browserPid = 0;
  let browserProcess = 0n;
  let closeStarted = 0;
  let browserSignalled = false;
  let browserSignalMs: number | undefined;
  let browserEventMs: number | undefined;
  let browserExited = false;
  let browserExitToken: bigint | undefined;
  let resized = false;
  let modalEntered = false;
  let modalExited = false;
  let modalTimer = false;
  let registered = false;
  let initialized = false;
  const rect = new Int32Array(4);
  function resize() {
    if (!controller || closing) {
      return;
    }
    assert(user.symbols.GetClientRect(hwnd, ptr(rect)));
    // Win64 ABI passes a 16-byte RECT by address, unlike an 8-byte event token.
    hr(
      method(controller, 6, [
        "ptr",
      ])(ptr(rect)),
      "put_Bounds",
    );
    const actual = new Int32Array(4);
    hr(
      method(controller, 5, [
        "ptr",
      ])(ptr(actual)),
      "get_Bounds",
    );
    assert.deepEqual(actual, rect);
    resized = true;
  }
  const wndProc = new JSCallback(
    (window: bigint, message: number, wparam: bigint, lparam: bigint) => {
      try {
        assert.equal(
          kernel.symbols.GetCurrentThreadId(),
          thread,
          "WndProc foreign thread",
        );
        if (message === WM_ENTERSIZEMOVE) {
          modalEntered = true;
          if (counters) {
            Atomics.store(counters, 0, 1);
          }
        }
        if (message === WM_EXITSIZEMOVE) {
          if (counters) {
            Atomics.store(counters, 0, 0);
          }
          modalExited = true;
        }
        if (message === WM_TIMER && wparam === MODAL_TIMER_ID) {
          modalTimer = true;
          user.symbols.KillTimer(window, MODAL_TIMER_ID);
          user.symbols.PostMessageW(window, WM_CANCELMODE, 0n, 0n);
          return 0n;
        }
        if (message === WM_CLOSE) {
          closing = true;
          return 0n;
        } // defer teardown past WndProc
        if (message === WM_SIZE) {
          resize();
        }
        return user.symbols.DefWindowProcW(window, message, wparam, lparam);
      } catch (error) {
        failure ??= error;
        closing = true;
        return 0n;
      }
    },
    {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
  );
  const instance = kernel.symbols.GetModuleHandleW(null);
  const className = wide(`bunaway-ffi-${process.pid}-${viewId}`);
  const title = wide("Bunaway — direct Bun FFI probe");
  const wc = Buffer.alloc(80); // sizeof(WNDCLASSEXW), Windows x64
  wc.writeUInt32LE(80, 0);
  wc.writeBigUInt64LE(BigInt(wndProc.ptr ?? 0), 8);
  wc.writeBigUInt64LE(instance, 24);
  wc.writeBigUInt64LE(BigInt(ptr(className)), 64);
  let ticks = 0;
  let promises = 0;
  let network = 0;
  let roundtrip = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let pendingWork: Promise<void> | undefined;
  let lateWork: Promise<void> | undefined;
  let dropped = 0;
  let modalPing = false;
  let lateReply = false;
  let backendReply = false;
  const receive = (message: ToUI) => {
    if (message.viewId !== viewId) {
      return;
    }
    try {
      assert.equal(
        callbackDepth,
        0,
        "Worker delivery must leave the native callback stack",
      );
      if (message.kind === "modal-ping") {
        assert(modalExited, "Worker message reentered the native modal loop");
        modalPing = true;
        log("ui-message-delay", {
          elapsedMs: Date.now() - message.sentAt,
        });
      } else {
        assert.equal(message.kind, "result");
        if (message.id === "roundtrip") {
          assert(!backendReply, "Duplicate backend result");
          assert.equal(message.value, input * 2);
          backendReply = true;
        } else {
          assert.equal(message.id, "late");
          assert(
            !lateReply && closing && !webview,
            "Late test must run after native teardown",
          );
          assert.equal(message.value, 99);
          lateReply = true;
        }
        sendResult(message.value);
      }
    } catch (error) {
      failure ??= error;
      closing = true;
    }
  };
  parentPort?.on("message", receive);
  function sendResult(value: number) {
    if (closing || !webview) {
      dropped++;
      return;
    }
    hr(
      method(webview, 32, [
        "ptr",
      ])(
        ptr(
          wide(
            JSON.stringify({
              value,
            }),
          ),
        ),
      ),
      "PostWebMessageAsJson",
    );
  }
  const registrations: {
    slot: number;
    token: bigint;
  }[] = [];
  function on(slot: number, callback: ReturnType<typeof handler>) {
    assert(webview);
    const token = new BigInt64Array(1);
    hr(
      method(webview, slot, [
        "ptr",
        "ptr",
      ])(callback.pointer, ptr(token)),
      "add event",
    );
    registrations.push({
      slot: slot + 1,
      token: token[0] ?? 0n,
    });
  }
  const messageHandler = handler(
    "message",
    "57213f19-00e6-49fa-8e07-898ea01ecbd2",
    [
      "ptr",
      "ptr",
    ],
    (_sender, args) => {
      if (closing) {
        return;
      }
      assert.equal(getString(args as Pointer, 3), "about:blank");
      const message = JSON.parse(getString(args as Pointer, 4));
      if (message.kind === "rendered") {
        assert.equal(message.value, String(input * 2));
        roundtrip = true;
        log("web-roundtrip", {
          value: message.value,
        });
      } else {
        assert.deepEqual(message, {
          kind: "invoke",
          value: input,
        });
        if (uiWorker) {
          parentPort?.postMessage({
            kind: "invoke",
            viewId,
            value: message.value,
          });
          return;
        }
        // Leave the native callback stack before running asynchronous application work.
        setTimeout(() => {
          pendingWork = (async () => {
            assert.equal(callbackDepth, 0);
            assert(server);
            const result = await fetch(server.url);
            assert.equal(await result.text(), "network-ok");
            network++;
            const value = await Promise.resolve(message.value * 2);
            sendResult(value);
          })().catch((error) => {
            failure ??= error;
            closing = true;
          });
        }, 0);
      }
    },
  );
  const navigationHandler = handler(
    "navigation",
    "d33a35bf-1c49-4f98-93ab-006e0533fe1c",
    [
      "ptr",
      "ptr",
    ],
    (_sender, args) => {
      const success = new Int32Array(1);
      const status = new Int32Array(1);
      hr(
        method(args as Pointer, 3, [
          "ptr",
        ])(ptr(success)),
        "get_IsSuccess",
      );
      hr(
        method(args as Pointer, 4, [
          "ptr",
        ])(ptr(status)),
        "get_WebErrorStatus",
      );
      log("navigation", {
        success: success[0],
        status: status[0],
        source: webview ? getString(webview, 4) : "closed",
      });
    },
  );
  const browserExitHandler = handler(
    "browser-exit",
    "fa504257-a216-4911-a860-fe8825712861",
    [
      "ptr",
      "ptr",
    ],
    (_sender, args) => {
      const pid = new Uint32Array(1);
      const kind = new Int32Array(1);
      hr(
        method(args as Pointer, 3, [
          "ptr",
        ])(ptr(kind)),
        "get_BrowserProcessExitKind",
      );
      hr(
        method(args as Pointer, 4, [
          "ptr",
        ])(ptr(pid)),
        "get_BrowserProcessId",
      );
      assert.equal(
        pid[0],
        browserPid,
        "Browser exit belongs to a different environment",
      );
      browserExited = true;
      browserEventMs = closeStarted
        ? performance.now() - closeStarted
        : undefined;
      log("browser-exited", {
        pid: pid[0],
        kind: kind[0],
      });
      assert.equal(kind[0], 0, "Browser did not exit normally");
    },
  );
  const controllerHandler = handler(
    "controller",
    "6c4819f3-c9b7-4260-8127-c9f5bde7f68c",
    [
      "i32",
      "ptr",
    ],
    (result, created) => {
      hr(Number(result), "controller completion");
      assert(created);
      const out = new BigUint64Array(1);
      hr(
        method(created as Pointer, 25, [
          "ptr",
        ])(ptr(out)),
        "get_CoreWebView2",
      );
      const createdWebview = Number(out[0]) as Pointer;
      assert(createdWebview, "get_CoreWebView2 returned null");
      const pid = new Uint32Array(1);
      hr(
        method(createdWebview, 37, [
          "ptr",
        ])(ptr(pid)),
        "get_BrowserProcessId",
      );
      browserPid = pid[0] ?? 0;
      browserProcess = kernel.symbols.OpenProcess(SYNCHRONIZE, 0, browserPid);
      assert(browserProcess, `OpenProcess: ${kernel.symbols.GetLastError()}`);
      log("browser-process", {
        pid: browserPid,
      });
      if (closing) {
        try {
          closeStarted = performance.now();
          hr(method(created as Pointer, 24)(), "late controller Close");
        } finally {
          release(createdWebview);
        }
        return;
      }
      controller = created as Pointer;
      addRef(controller);
      webview = createdWebview;
      resize();
      hr(
        method(controller, 4, [
          "i32",
        ])(1),
        "put_IsVisible",
      );
      on(34, messageHandler);
      on(15, navigationHandler);
      // A fixed trusted document with no external resource access; no framework permissions.
      const html = wide(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><title>FFI probe</title><h1>Bun FFI → WebView2</h1><output id="result">Waiting</output><script>chrome.webview.addEventListener('message', e => { document.querySelector('output').textContent = String(e.data.value); requestAnimationFrame(() => chrome.webview.postMessage({kind:'rendered', value:document.querySelector('output').textContent})); }); chrome.webview.postMessage({kind:'invoke', value:${input}});</script>`,
      );
      hr(
        method(webview, 6, [
          "ptr",
        ])(ptr(html)),
        "NavigateToString",
      );
      log("webview-created");
    },
  );
  const environmentHandler = handler(
    "environment",
    "4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d",
    [
      "i32",
      "ptr",
    ],
    (result, created) => {
      hr(Number(result), "environment completion");
      assert(created);
      environment = created as Pointer;
      addRef(environment);
      const out = new BigUint64Array(1);
      const iid = guid("319e423d-e0d7-4b8d-9254-ae9475de9b17");
      hr(
        method(environment, 0, [
          "ptr",
          "ptr",
        ])(ptr(iid), ptr(out)),
        "QueryInterface(Environment5)",
      );
      environment5 = Number(out[0]) as Pointer;
      assert(environment5);
      const token = new BigInt64Array(1);
      hr(
        method(environment5, 12, [
          "ptr",
          "ptr",
        ])(browserExitHandler.pointer, ptr(token)),
        "add_BrowserProcessExited",
      );
      browserExitToken = token[0] ?? 0n;
      log("webview-runtime", {
        version: getString(environment, 5),
      });
      if (closing) {
        return;
      }
      hr(
        method(environment, 3, [
          "u64",
          "ptr",
        ])(hwnd, controllerHandler.pointer),
        "CreateCoreWebView2Controller",
      );
    },
  );
  const profile = resolve(
    import.meta.dir,
    "../../../build/windows-ffi-probe",
    `profile-${process.pid}-${viewId}`,
  );
  mkdirSync(profile, {
    recursive: true,
  });
  log("profile", {
    path: profile,
  });
  const profileName = wide(profile);
  const message = Buffer.alloc(48); // sizeof(MSG), Windows x64
  let lastPump = 0;
  let maxPumpGapMs = 0;
  let pumpCount = 0;
  function observeBrowserProcess() {
    if (!closeStarted || !browserProcess || browserSignalled) {
      return;
    }
    const wait = kernel.symbols.WaitForSingleObject(browserProcess, 0);
    assert(wait === 0 || wait === 258, `WaitForSingleObject: ${wait}`);
    if (wait === 0) {
      browserSignalled = true;
      browserSignalMs = performance.now() - closeStarted;
      log("browser-handle-signalled", {
        pid: browserPid,
        elapsedMs: browserSignalMs,
      });
    }
  }
  function pump() {
    assert.equal(
      invokeDepth,
      0,
      "Do not nest a message pump inside a COM Invoke",
    );
    if (closeStarted) {
      const now = performance.now();
      if (lastPump) {
        maxPumpGapMs = Math.max(maxPumpGapMs, now - lastPump);
      }
      lastPump = now;
      pumpCount++;
      observeBrowserProcess();
    }
    for (
      let count = 0;
      count < 64 && user.symbols.PeekMessageW(ptr(message), 0n, 0, 0, 1);
      count++
    ) {
      if (message.readUInt32LE(8) === WM_QUIT) {
        closing = true;
        break;
      }
      user.symbols.TranslateMessage(ptr(message));
      user.symbols.DispatchMessageW(ptr(message));
    }
  }
  const deadline = Date.now() + 15000;
  const earlyClose =
    uiWorker?.earlyClose ?? process.argv.includes("--early-close");
  try {
    hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
    initialized = true;
    // Exercise synchronous IUnknown and signed HRESULT conversion before WebView
    // owns any handler. A threadsafe/asynchronous callback cannot satisfy this.
    const queried = new BigUint64Array(1);
    hr(
      method(messageHandler.pointer, 0, [
        "ptr",
        "ptr",
      ])(ptr(unknown), ptr(queried)),
      "QueryInterface(IUnknown)",
    );
    assert.equal(queried[0], BigInt(messageHandler.pointer));
    assert.equal(addRef(messageHandler.pointer), 3);
    assert.equal(release(messageHandler.pointer), 2);
    assert.equal(release(messageHandler.pointer), 1);
    const unsupported = guid("00000000-0000-0000-0000-000000000001");
    assert.equal(
      method(messageHandler.pointer, 0, [
        "ptr",
        "ptr",
      ])(ptr(unsupported), ptr(queried)),
      -2147467262,
    );
    assert.equal(queried[0], 0n);
    log("abi-pass", {
      hresult: "E_NOINTERFACE",
      synchronousReferences: true,
    });
    assert(
      user.symbols.RegisterClassExW(ptr(wc)),
      `RegisterClassExW: ${kernel.symbols.GetLastError()}`,
    );
    registered = true;
    hwnd = user.symbols.CreateWindowExW(
      0,
      ptr(className),
      ptr(title),
      WS_OVERLAPPEDWINDOW,
      100,
      100,
      640,
      480,
      0n,
      0n,
      instance,
      null,
    );
    assert(hwnd, `CreateWindowExW: ${kernel.symbols.GetLastError()}`);
    user.symbols.ShowWindow(hwnd, SW_SHOW);
    log("window-created", {
      hwnd: hwnd.toString(),
    });
    timer = setInterval(() => {
      ticks++;
      void Promise.resolve().then(() => promises++);
    }, 10);
    if (!uiWorker) {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("network-ok"),
      });
    }
    log("environment-start");
    hr(
      loader.symbols.CreateCoreWebView2EnvironmentWithOptions(
        null,
        ptr(profileName),
        null,
        environmentHandler.pointer,
      ),
      "CreateCoreWebView2EnvironmentWithOptions",
    );
    if (earlyClose) {
      user.symbols.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
    }
    while (!closing && Date.now() < deadline) {
      // ponytail: bounded polling adds up to 5 ms latency; a native wake integration
      // is needed if idle CPU or Win32 modal loops fail the framework gate.
      pump();
      if (closing) {
        break;
      }
      if (roundtrip && ticks >= 20) {
        Bun.gc(true); // Native callbacks/vtables must survive collection while registered.
        resized = false;
        assert(
          user.symbols.SetWindowPos(
            hwnd,
            0n,
            0,
            0,
            800,
            600,
            SWP_NOMOVE | SWP_NOZORDER,
          ),
        );
        assert(resized);
        if (!uiWorker) {
          lateWork = Bun.sleep(20).then(() => sendResult(99));
        }
        log("basic-checks", {
          ticks,
          promises,
          network,
          resized,
          maxCallbackDepth,
          maxInvokeDepth,
        });
        if (
          (uiWorker && viewId !== "first") ||
          process.argv.includes("--modal")
        ) {
          const before = ticks;
          const started = performance.now();
          assert(user.symbols.SetTimer(hwnd, MODAL_TIMER_ID, 300, null));
          const modalKind = uiWorker?.resize ? "size" : "move";
          // Enter the native modal loop to measure UI-thread scheduling.
          user.symbols.SendMessageW(
            hwnd,
            WM_SYSCOMMAND,
            uiWorker?.resize ? SC_SIZE | WMSZ_BOTTOMRIGHT : SC_MOVE,
            0n,
          );
          const elapsedMs = performance.now() - started;
          log("modal-check", {
            modalKind,
            modalEntered,
            modalExited,
            modalTimer,
            elapsedMs,
            bunTicks: ticks - before,
          });
          assert(
            modalEntered && modalExited && modalTimer,
            "Native move loop was not exercised",
          );
          if (counters) {
            const duringModal = {
              ticks: Atomics.load(counters, 1),
              promises: Atomics.load(counters, 2),
              network: Atomics.load(counters, 3),
            };
            log("backend-during-modal", duringModal);
            assert(
              Object.values(duringModal).every((value) => value > 0),
              "Backend stalled during modal loop",
            );
            const pingDeadline = Date.now() + 2000;
            while (!modalPing && !failure && Date.now() < pingDeadline) {
              await Bun.sleep(5);
            }
            assert(
              modalPing,
              "Queued UI message was not delivered after the modal loop",
            );
          } else {
            assert(
              ticks > before,
              "Bun timers stalled inside the Win32 move/size modal loop",
            );
          }
        }
        assert(user.symbols.PostMessageW(hwnd, WM_CLOSE, 0n, 0n));
      }
      await Bun.sleep(5);
    }
    if (failure) {
      throw failure;
    }
    if (!earlyClose) {
      assert(roundtrip, "WebView roundtrip did not complete");
      assert(
        ticks >= 20 && promises >= 20,
        "UI Bun event loop stalled outside modal loop",
      );
      assert(
        uiWorker ? backendReply : network === 1,
        "Backend roundtrip incomplete",
      );
      assert.equal(maxInvokeDepth, 1, "COM Invoke reentered");
    }
  } catch (error) {
    failure ??= error;
  } finally {
    closing = true;
    clearInterval(timer);
    await pendingWork;
    await lateWork;
    await server?.stop(true);
    if (lateWork) {
      assert.equal(dropped, 1);
      log("late-response-dropped");
    }
    if (webview) {
      for (const { slot, token } of registrations) {
        hr(
          method(webview, slot, [
            "i64",
          ])(token),
          "remove event",
        );
      }
    }
    if (controller) {
      closeStarted = performance.now();
      hr(method(controller, 24)(), "Close");
    }
    if (webview) {
      log("release-webview", {
        remaining: release(webview),
      });
      webview = undefined;
    }
    if (controller) {
      log("release-controller", {
        remaining: release(controller),
      });
      controller = undefined;
    }
    // An environment/controller completion can arrive after a close request.
    // Continue pumping on the owning STA until COM has released all handlers.
    const drainDeadline = Date.now() + 10000;
    while (
      handlers.some(
        (callback) => callback !== browserExitHandler && callback.refs > 1,
      ) &&
      Date.now() < drainDeadline
    ) {
      pump();
      await Bun.sleep(5);
    }
    // Match the host's Close -> DestroyWindow order. Keep the STA and environment,
    // not the parent HWND, alive while waiting for browser shutdown.
    if (hwnd) {
      assert(user.symbols.DestroyWindow(hwnd));
      hwnd = 0n;
    }
    if (registered) {
      assert(user.symbols.UnregisterClassW(ptr(className), instance));
      registered = false;
    }
    log("window-closed");
    parentPort?.postMessage({
      kind: "window-closed",
      viewId,
    });
    // Keep the STA pumping and the environment alive until the browser and its
    // associated runtime processes finish; releasing COM alone is not an exit ack.
    // Observe a slow exit for diagnosis, but keep the acceptance limit at 5 s.
    const browserDeadline = Date.now() + 15000;
    while (browserPid && !browserExited && Date.now() < browserDeadline) {
      pump();
      await Bun.sleep(5);
    }
    observeBrowserProcess();
    const shutdownMs =
      browserEventMs ?? (closeStarted ? performance.now() - closeStarted : 0);
    log("browser-shutdown", {
      pid: browserPid,
      exited: browserExited,
      elapsedMs: shutdownMs,
      browserSignalMs,
      browserEventMs,
      maxPumpGapMs,
      pumpCount,
    });
    if (browserPid && (!browserExited || shutdownMs > 5000)) {
      failure ??= new Error(
        "BrowserProcessExited did not arrive within 5 seconds",
      );
    }
    if (environment5 && browserExitToken !== undefined) {
      hr(
        method(environment5, 13, [
          "i64",
        ])(browserExitToken),
        "remove_BrowserProcessExited",
      );
    }
    if (environment5) {
      release(environment5);
      environment5 = undefined;
    }
    if (environment) {
      release(environment);
      environment = undefined;
    }
    const callsAfterClose = handlers.map((callback) => callback.calls);
    for (let count = 0; count < 10; count++) {
      pump();
      await Bun.sleep(5);
    }
    assert.deepEqual(
      handlers.map((callback) => callback.calls),
      callsAfterClose,
      "Invoke after native detach",
    );
    log("callbacks-quiescent");
    wndProc.close();
    for (const callback of handlers) {
      callback.dropOwner();
    }
    log("callback-references", {
      handlers: handlers.map(({ name, refs, calls }) => ({
        name,
        refs,
        calls,
      })),
    });
    // Fail rather than free code still retained by COM.
    for (const callback of handlers) {
      callback.dispose();
    }
    if (initialized) {
      ole.symbols.CoUninitialize();
    }
    if (browserProcess) {
      assert(kernel.symbols.CloseHandle(browserProcess));
    }
    for (const binding of methods.values()) {
      binding.close();
    }
    loader.close();
    user.close();
    ole.close();
    kernel.close();
  }
  if (uiWorker) {
    try {
      parentPort?.postMessage({
        kind: "native-closed",
        viewId,
      });
      const lateDeadline = Date.now() + 2000;
      while (!lateReply && Date.now() < lateDeadline) {
        await Bun.sleep(5);
      }
      if (!lateReply || dropped !== 1) {
        failure ??= new Error(
          "Late backend response was not discarded after native teardown",
        );
      } else {
        log("worker-late-response-dropped");
      }
      // Cleanup acknowledgement is separate from a passing test; a slow first
      // window must not prevent us exercising the surviving window's route.
      parentPort?.postMessage({
        kind: "done",
        viewId,
      });
    } finally {
      parentPort?.off("message", receive);
    }
  }
  if (failure) {
    throw failure;
  }
  log(earlyClose ? "early-close-pass" : "basic-pass");
}

if (import.meta.main) {
  await runProbe();
}
