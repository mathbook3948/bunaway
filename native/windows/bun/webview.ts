import { dlopen, type Pointer, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { WindowSpec } from "./channel.ts";
import {
  addRef,
  type ComHandler,
  disposeHandlers,
  getObject,
  getString,
  handler,
  method,
  query,
  release,
} from "./com.ts";
import { viewDirName } from "./view-profile.ts";
import { webAsset } from "./web-assets.ts";
import { hr, kernel, user, wide, withWide } from "./win32-bindings.ts";

const embedded = Bun.embeddedFiles.some(
  (file) => (file as File).name === "app.json",
);
const streams = dlopen("shlwapi.dll", {
  SHCreateMemStream: {
    args: [
      "ptr",
      "u32",
    ],
    returns: "ptr",
  },
});

/** Normalize HTTP(S) URLs to an origin; return empty for unsupported or malformed URLs. */
export function originOf(text: string): string {
  try {
    const url = new URL(text);
    if (
      ![
        "https:",
        "http:",
      ].includes(url.protocol) ||
      url.username ||
      url.password ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(url.hostname)
    ) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}
// Slots/IIDs are from the pinned WebView2 SDK 1.0.4129.50, Win64 COM ABI.
/** Own one WebView2 instance, its COM callbacks, and the child-process shutdown drain. */
export class WebView {
  webview: Pointer | undefined;
  private controller: Pointer | undefined;
  private environment: Pointer | undefined;
  private environment5: Pointer | undefined;
  private browserToken: bigint | undefined;
  private readonly events: {
    slot: number;
    token: bigint;
    callback: ComHandler;
  }[] = [];
  private readonly completions: ComHandler[] = [];
  private creating = 0;
  private closing = false;
  private detached = false;
  private browserExited = false;
  private finished = false;
  private quiescence:
    | {
        deadline: number;
        calls: number[];
      }
    | undefined;
  private browserHandle = 0n;
  private readonly processHandles = new Map<number, bigint>();
  private closedAt = 0;
  private readonly profile: Buffer;
  private readonly loader;
  failure: unknown;

  /** Begin async WebView2 creation; ready fires after the controller is configured and shown. */
  constructor(
    readonly hwnd: bigint,
    readonly spec: WindowSpec,
    assets: string,
    dataRoot: string,
    loaderPath: string,
    private readonly origins: readonly string[],
    private readonly hooks: {
      message(source: string, raw: string): void;
      revoke(reason: string): void;
      sameDocument(source: string): void;
      close(force?: boolean): void;
      ready(): void;
      log(event: string, data?: object): void;
    },
    legacyProfile = false,
    private readonly devtools = false,
  ) {
    const profile = resolve(
      dataRoot,
      "webview",
      ...(legacyProfile
        ? []
        : [
            viewDirName(spec.view),
          ]),
    );
    mkdirSync(profile, {
      recursive: true,
    });
    this.profile = wide(profile);
    this.loader = dlopen(loaderPath, {
      CreateCoreWebView2EnvironmentWithOptions: {
        args: [
          "ptr",
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    });
    const browser = handler(
      "browser-exit",
      "fa504257-a216-4911-a860-fe8825712861",
      [
        "ptr",
        "ptr",
      ],
      () => {
        this.browserExited = true;
      },
    );
    const controller = handler(
      "controller",
      "6c4819f3-c9b7-4260-8127-c9f5bde7f68c",
      [
        "i32",
        "ptr",
      ],
      (result, created) => {
        this.creating--;
        if (this.closing && (Number(result) < 0 || !created)) {
          return;
        }
        hr(Number(result), "Controller completion");
        assert(created);
        this.controller = created as Pointer;
        addRef(this.controller);
        this.webview = getObject(this.controller, 25);
        const pid = new Uint32Array(1);
        hr(
          method(this.webview, 37, [
            "ptr",
          ])(ptr(pid)),
          "get_BrowserProcessId",
        );
        this.browserHandle = kernel.symbols.OpenProcess(
          0x100000,
          0,
          pid[0] ?? 0,
        );
        assert(this.browserHandle, "OpenProcess browser");
        this.processHandles.set(pid[0] ?? 0, this.browserHandle);
        this.hooks.log("webview-ready", {
          browserPid: pid[0],
        });
        if (this.closing) {
          return;
        }
        this.configure(assets);
        this.resize();
        hr(
          method(this.controller, 4, [
            "i32",
          ])(1),
          "put_IsVisible",
        );
        this.hooks.ready();
      },
    );
    const environment = handler(
      "environment",
      "4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d",
      [
        "i32",
        "ptr",
      ],
      (result, created) => {
        this.creating--;
        if (this.closing && (Number(result) < 0 || !created)) {
          return;
        }
        hr(Number(result), "Environment completion");
        assert(created);
        this.environment = created as Pointer;
        addRef(this.environment);
        // Environment8 extends Environment5; require process inventory before starting a view.
        this.environment5 = query(
          this.environment,
          "d6eb91dd-c3d2-45e5-bd29-6dc2bc4de9cf",
        );
        const token = new BigInt64Array(1);
        hr(
          method(this.environment5, 12, [
            "ptr",
            "ptr",
          ])(browser.pointer, ptr(token)),
          "add_BrowserProcessExited",
        );
        this.browserToken = token[0] ?? 0n;
        if (this.closing) {
          return;
        }
        this.creating++;
        const resultCode = method(this.environment, 3, [
          "u64",
          "ptr",
        ])(hwnd, controller.pointer);
        if (resultCode < 0) {
          this.creating--;
        }
        hr(resultCode, "CreateController");
      },
    );
    this.completions.push(environment, controller, browser);
    this.creating++;
    const result = this.loader.symbols.CreateCoreWebView2EnvironmentWithOptions(
      null,
      ptr(this.profile),
      null,
      environment.pointer,
    );
    if (result < 0) {
      this.creating--;
      this.failure = new Error(`CreateEnvironment: ${result}`);
    }
  }

  /** Retain an event callback until detach removes its subscription and finish drains it. */
  private on(slot: number, iid: string, invoke: (args: Pointer) => void) {
    assert(this.webview);
    const callback = handler(
      `event-${slot}`,
      iid,
      [
        "ptr",
        "ptr",
      ],
      (_sender, args) => {
        if (!this.closing) {
          invoke(args as Pointer);
        }
      },
    );
    const token = new BigInt64Array(1);
    hr(
      method(this.webview, slot, [
        "ptr",
        "ptr",
      ])(callback.pointer, ptr(token)),
      "add event",
    );
    this.events.push({
      slot: slot + 1,
      token: token[0] ?? 0n,
      callback,
    });
  }

  /** Apply browser settings and origin/resource policy before the view is shown. */
  private configure(assets: string) {
    assert(this.webview);
    const webview = this.webview;
    const settings = getObject(this.webview, 3);
    try {
      for (const [slot, value] of [
        [
          6,
          1,
        ],
        [
          8,
          0,
        ],
        [
          10,
          0,
        ],
        [
          12,
          this.devtools ? 1 : 0,
        ], // AreDevToolsEnabled
        [
          14,
          0,
        ],
        [
          16,
          0,
        ],
        [
          18,
          0,
        ],
      ] as const) {
        hr(
          method(settings, slot, [
            "i32",
          ])(value),
          "WebView setting",
        );
      }
      const settings4 = query(settings, "cb56846c-4168-4d53-b04f-03b6d6796ff2");
      try {
        for (const [slot, value] of [
          [
            24,
            this.devtools ? 1 : 0,
          ], // AreBrowserAcceleratorKeysEnabled
          [
            26,
            0,
          ], // IsPasswordAutosaveEnabled
          [
            28,
            0,
          ], // IsGeneralAutofillEnabled
        ] as const) {
          hr(
            method(settings4, slot, [
              "i32",
            ])(value),
            "WebView setting4",
          );
        }
      } finally {
        release(settings4);
      }
    } finally {
      release(settings);
    }
    if (!embedded) {
      const webview3 = query(
        this.webview,
        "a0d6df20-3b92-416d-aa0c-437a9c727857",
      );
      try {
        hr(
          withWide("app.bunaway.local", (host) =>
            withWide(resolve(assets, "web"), (folder) =>
              method(webview3, 71, [
                "ptr",
                "ptr",
                "i32",
              ])(host, folder, 2),
            ),
          ),
          "SetVirtualHostNameToFolderMapping",
        ); // DENY_CORS
      } finally {
        release(webview3);
      }
    }
    // Include worker-originated requests when serving embedded web resources.
    const filters = embedded
      ? query(webview, "db75dfc7-a857-4632-a398-6969dde26c0a")
      : undefined;
    try {
      for (const pattern of [
        "http://*/*",
        "https://*/*",
      ]) {
        hr(
          withWide(pattern, (address) =>
            filters
              ? method(filters, 123, [
                  "ptr",
                  "i32",
                  "u32",
                ])(address, 0, 0xffffffff)
              : method(webview, 57, [
                  "ptr",
                  "i32",
                ])(address, 0),
          ),
          "Resource filter",
        );
      }
    } finally {
      if (filters) {
        release(filters);
      }
    }
    const navigation = (args: Pointer, frame: boolean) => {
      const uri = getString(args, 3);
      if (!this.origins.includes(originOf(uri))) {
        hr(
          method(args, 8, [
            "i32",
          ])(1),
          "Cancel navigation",
        );
        this.hooks.log(frame ? "web-resource-blocked" : "navigation-blocked", {
          uri,
          ...(frame
            ? {
                reason: "frame-navigation",
              }
            : {}),
        });
      } else if (!frame) {
        this.hooks.revoke("navigation");
      }
    };
    this.on(7, "9adbe429-f36d-432b-9ddc-f8881fbd76e3", (args) =>
      navigation(args, false),
    );
    this.on(17, "9adbe429-f36d-432b-9ddc-f8881fbd76e3", (args) =>
      navigation(args, true),
    );
    this.on(11, "3c067f9f-5388-4772-8b48-79f7ef1ab37c", (args) => {
      const newDocument = new Int32Array(1);
      hr(
        method(args, 3, [
          "ptr",
        ])(ptr(newDocument)),
        "get_IsNewDocument",
      );
      if (!newDocument[0] && this.webview) {
        this.hooks.sameDocument(getString(this.webview, 4));
      }
    });
    this.on(15, "d33a35bf-1c49-4f98-93ab-006e0533fe1c", (args) => {
      const success = new Int32Array(1);
      hr(
        method(args, 3, [
          "ptr",
        ])(ptr(success)),
        "get_IsSuccess",
      );
      this.hooks.log("navigation-completed", {
        success: !!success[0],
        uri: this.webview ? getString(this.webview, 4) : "",
      });
    });
    // ICoreWebView2 receives top-level messages only; no FrameWebMessageReceived handlers are installed.
    this.on(34, "57213f19-00e6-49fa-8e07-898ea01ecbd2", (args) =>
      this.hooks.message(getString(args, 3), getString(args, 4)),
    );
    this.on(44, "d4c185fe-c81c-4989-97af-2d3fa7ab5651", (args) => {
      hr(
        method(args, 6, [
          "i32",
        ])(1),
        "Handle new window",
      );
      this.hooks.log("new-window-blocked");
    });
    this.on(23, "15e1c6a3-c72a-4df3-91d7-d097fbec6bfd", (args) => {
      hr(
        method(args, 7, [
          "i32",
        ])(2),
        "Deny permission",
      );
      const args3 = query(args, "e61670bc-3dce-4177-86d2-c629ae3cb6ac");
      try {
        hr(
          method(args3, 12, [
            "i32",
          ])(0),
          "Disable persistent permission decision",
        );
      } finally {
        release(args3);
      }
      this.hooks.log("permission-request-denied");
    });
    this.on(59, "5c19e9e0-092f-486b-affa-ca8231913039", () =>
      this.hooks.close(),
    );
    this.on(25, "79e0aea4-990b-42d9-aa1d-0fcc2e5bc7f1", (args) => {
      const kind = new Int32Array(1);
      hr(
        method(args, 3, [
          "ptr",
        ])(ptr(kind)),
        "get_ProcessFailedKind",
      );
      this.hooks.log("webview-process-failed", {
        kind: kind[0],
      });
      this.hooks.revoke("process-failed");
      if (kind[0] === 0) {
        this.hooks.close(true);
      } else {
        setTimeout(() => {
          if (!this.closing) {
            this.navigate();
          }
        }, 0);
      }
    });
    this.on(55, "ab00b74c-15f1-4646-80e8-e76341d25d71", (args) => {
      const request = getObject(args, 3);
      let uri: string;
      let resource: ReturnType<typeof webAsset> | undefined;
      try {
        uri = getString(request, 3);
        if (
          embedded &&
          originOf(uri) === "https://app.bunaway.local" &&
          this.origins.includes(originOf(uri))
        ) {
          const headers = getObject(request, 9);
          let range = "";
          try {
            const contains = new Int32Array(1);
            hr(
              withWide("Range", (name) =>
                method(headers, 5, [
                  "ptr",
                  "ptr",
                ])(name, ptr(contains)),
              ),
              "Has Range header",
            );
            if (contains[0]) {
              range = getString(headers, 3, "Range");
            }
          } finally {
            release(headers);
          }
          resource = webAsset(assets, uri, getString(request, 5), range);
        }
      } finally {
        release(request);
      }
      if (!resource && this.origins.includes(originOf(uri))) {
        return;
      }
      assert(this.environment);
      const environment = this.environment;
      const response = new BigUint64Array(1);
      const stream = resource?.body.length
        ? streams.symbols.SHCreateMemStream(
            ptr(resource.body),
            resource.body.length,
          )
        : null;
      if (resource?.body.length) {
        assert(stream, "Create asset stream");
      }
      try {
        hr(
          withWide(resource?.reason ?? "Forbidden", (reason) =>
            withWide(
              resource?.headers ?? "Content-Type: text/plain",
              (headers) =>
                method(environment, 4, [
                  "ptr",
                  "i32",
                  "ptr",
                  "ptr",
                  "ptr",
                ])(
                  stream,
                  resource?.status ?? 403,
                  reason,
                  headers,
                  ptr(response),
                ),
            ),
          ),
          "Create resource response",
        );
      } finally {
        if (stream) {
          release(Number(stream) as Pointer);
        }
      }
      const object = Number(response[0]) as Pointer;
      try {
        hr(
          method(args, 5, [
            "ptr",
          ])(object),
          "Set resource response",
        );
      } finally {
        release(object);
      }
      if (!resource) {
        this.hooks.log("web-resource-blocked", {
          uri,
        });
      }
    });
  }

  navigate() {
    const webview = this.webview;
    if (webview && !this.closing) {
      hr(
        withWide(this.spec.home, (address) =>
          method(webview, 5, [
            "ptr",
          ])(address),
        ),
        "Navigate",
      );
    }
  }
  source() {
    return this.webview ? getString(this.webview, 4) : "";
  }
  send(text: string) {
    const webview = this.webview;
    if (webview && !this.closing) {
      hr(
        withWide(text, (address) =>
          method(webview, 32, [
            "ptr",
          ])(address),
        ),
        "PostWebMessageAsJson",
      );
    }
  }
  resize() {
    if (!this.controller || this.closing) {
      return;
    }
    const rect = new Int32Array(4);
    assert(user.symbols.GetClientRect(this.hwnd, ptr(rect)));
    hr(
      method(this.controller, 6, [
        "ptr",
      ])(ptr(rect)),
      "put_Bounds",
    );
  }
  requestClose() {
    this.closing = true;
  }
  /**
   * Ignore events and detach the controller outside COM callbacks.
   * Returns false while async creation is pending; finish drains remaining resources later.
   */
  detach(): boolean {
    this.closing = true;
    if (this.creating) {
      return false;
    }
    if (this.detached) {
      return true;
    }
    this.closedAt = performance.now();
    // Capture process handles before controller closure to track WebView2 children.
    if (this.environment) {
      const env8 = query(
        this.environment,
        "d6eb91dd-c3d2-45e5-bd29-6dc2bc4de9cf",
      );
      try {
        const collection = getObject(env8, 18);
        try {
          const count = new Uint32Array(1);
          hr(
            method(collection, 3, [
              "ptr",
            ])(ptr(count)),
            "get process count",
          );
          assert((count[0] ?? 0) <= 1024, "Unexpected WebView process count");
          for (let index = 0; index < (count[0] ?? 0); index++) {
            const out = new BigUint64Array(1);
            hr(
              method(collection, 4, [
                "u32",
                "ptr",
              ])(index, ptr(out)),
              "Get process info",
            );
            const processInfo = Number(out[0]) as Pointer;
            assert(processInfo);
            try {
              const pid = new Uint32Array(1);
              const kind = new Int32Array(1);
              hr(
                method(processInfo, 3, [
                  "ptr",
                ])(ptr(pid)),
                "get process id",
              );
              hr(
                method(processInfo, 4, [
                  "ptr",
                ])(ptr(kind)),
                "get process kind",
              );
              if (!pid[0] || this.processHandles.has(pid[0])) {
                continue;
              }
              const handle = kernel.symbols.OpenProcess(0x100000, 0, pid[0]);
              if (!handle) {
                assert.equal(
                  kernel.symbols.GetLastError(),
                  87,
                  "Capture WebView process handle",
                );
                continue;
              }
              this.processHandles.set(pid[0], handle);
              this.hooks.log("webview-process-captured", {
                pid: pid[0],
                kind: kind[0],
              });
              if (kind[0] === 0 && !this.browserHandle) {
                this.browserHandle = handle;
              }
            } finally {
              release(processInfo);
            }
          }
        } finally {
          release(collection);
        }
      } finally {
        release(env8);
      }
    }
    if (this.webview) {
      for (const { slot, token } of this.events) {
        hr(
          method(this.webview, slot, [
            "i64",
          ])(token),
          "remove event",
        );
      }
    }
    if (this.controller) {
      hr(method(this.controller, 24)(), "Close");
    }
    if (this.webview) {
      release(this.webview);
    }
    if (this.controller) {
      release(this.controller);
    }
    this.webview = undefined;
    this.controller = undefined;
    this.detached = true;
    return true;
  }
  /** Poll shutdown until children and callbacks drain, returning true after disposal. */
  finish(): boolean {
    if (this.finished) {
      return true;
    }
    if (!this.detached) {
      return false;
    }
    if (
      this.browserHandle &&
      (!this.browserExited ||
        kernel.symbols.WaitForSingleObject(this.browserHandle, 0) !== 0)
    ) {
      this.checkShutdownDeadline();
      return false;
    }
    if (this.completions.slice(0, 2).some((callback) => callback.refs > 1)) {
      return false;
    }
    if (this.environment5 && this.browserToken !== undefined) {
      hr(
        method(this.environment5, 13, [
          "i64",
        ])(this.browserToken),
        "remove_BrowserProcessExited",
      );
    }
    if (this.environment5) {
      release(this.environment5);
    }
    if (this.environment) {
      release(this.environment);
    }
    this.environment5 = undefined;
    this.environment = undefined;
    // Environment references can own runtime-side resources. Release them after
    // BrowserProcessExited, then keep the STA/trampolines alive while children drain.
    if (
      [
        ...this.processHandles.values(),
      ].some((handle) => kernel.symbols.WaitForSingleObject(handle, 0) !== 0)
    ) {
      this.checkShutdownDeadline();
      return false;
    }
    const callbacks = [
      ...this.events.map(({ callback }) => callback),
      ...this.completions,
    ];
    assert(
      callbacks.every((callback) => callback.refs === 1),
      "Outstanding COM reference",
    );
    // Keep this view's trampolines alive through bounded STA pumping before reuse or disposal.
    if (!this.quiescence) {
      this.quiescence = {
        deadline: performance.now() + 50,
        calls: callbacks.map((callback) => callback.calls),
      };
      return false;
    }
    assert.deepEqual(
      callbacks.map((callback) => callback.calls),
      this.quiescence.calls,
      "Invoke after native detach",
    );
    if (performance.now() < this.quiescence.deadline) {
      return false;
    }
    for (const handle of this.processHandles.values()) {
      assert(kernel.symbols.CloseHandle(handle));
    }
    const processes = this.processHandles.size;
    this.processHandles.clear();
    this.browserHandle = 0n;
    disposeHandlers([
      ...this.events.map(({ callback }) => callback),
      ...this.completions,
    ]);
    this.events.length = 0;
    this.completions.length = 0;
    this.loader.close();
    this.finished = true;
    this.hooks.log("view-cleaned", {
      processes,
      elapsedMs: this.closedAt ? performance.now() - this.closedAt : 0,
    });
    return true;
  }
  /** Throw with live-process diagnostics when tracked WebView processes remain past the 30-second deadline. */
  private checkShutdownDeadline() {
    if (performance.now() - this.closedAt > 30000) {
      throw new Error(
        `WebView cleanup timed out: ${JSON.stringify({
          browserExited: this.browserExited,
          live: [
            ...this.processHandles,
          ]
            .filter(
              ([, handle]) =>
                kernel.symbols.WaitForSingleObject(handle, 0) !== 0,
            )
            .map(([pid]) => pid),
        })}`,
      );
    }
  }
}
