import { dlopen, type Pointer, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkHresult,
  hresultText,
  wide,
  withWide,
} from "@bunaway/plugin/win32";
import type {
  NativeContentColorScheme,
  NativeMenuEditRole,
} from "@bunaway/plugin-api/native";
import { BunawayError, type WireError } from "@bunaway/protocol";
import type { WindowSpec } from "./channel.ts";
import { readClipboardText } from "./clipboard-text.ts";
import {
  abandonHandlers,
  addRef,
  type ComHandler,
  disposeHandlers,
  getObject,
  getString,
  handler,
  method,
  query,
  reclaimHandlers,
  release,
} from "./com.ts";
import { viewDirName } from "./view-profile.ts";
import { webAsset } from "./web-assets.ts";
import { setProfileColorScheme } from "./webview-color-scheme.ts";
import {
  callDevToolsProtocolMethod,
  DevToolsStartError,
} from "./webview-devtools.ts";
import { WebViewDownloads } from "./webview-downloads.ts";
import { EditCommandCalls } from "./webview-edit-calls.ts";
import {
  type EditCommandReport,
  editCommandEvaluateParameters,
  focusTargetEvaluateParameters,
  interpretEditCommandResult,
} from "./webview-edit-command.ts";
import { enableCustomTitlebar } from "./webview-titlebar.ts";
import { kernel, user } from "./win32-bindings.ts";

const embedded = Bun.embeddedFiles.some(
  (file) => (file as File).name === "manifest.json",
);
// COREWEBVIEW2_WEB_ERROR_STATUS from the pinned WebView2 SDK.
const WEB_ERROR_OPERATION_CANCELED = 14;
// x64 GUITHREADINFO: cbSize, flags, then hwndActive@8 and hwndFocus@16, ending with rcCaret.
const GUI_THREAD_INFO_SIZE = 72;
const GUI_THREAD_INFO_FOCUS_OFFSET = 16;
// ICoreWebView2Controller::MoveFocus and COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC.
const WEBVIEW_CONTROLLER_MOVE_FOCUS_SLOT = 12;
/** ICoreWebView2Controller::add_AcceleratorKeyPressed; its remove slot follows. */
const WEBVIEW_CONTROLLER_ACCELERATOR_KEY_SLOT = 19;
const MOVE_FOCUS_REASON_PROGRAMMATIC = 0;
// ICoreWebView2Controller2::put_DefaultBackgroundColor takes a COREWEBVIEW2_COLOR (A, R, G, B bytes).
const WEBVIEW_CONTROLLER2_IID = "c979903e-d4ca-4228-92eb-47ee3fa96eab";
const WEBVIEW_CONTROLLER2_PUT_DEFAULT_BACKGROUND_COLOR_SLOT = 27;
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
/** A profile has one environment, separate controllers and one final native process drain. */
type EnvironmentGroup = {
  members: Set<WebView>;
  waiting: Set<WebView>;
  environment?: Pointer;
  drainer?: WebView;
};
const environments = new Map<string, EnvironmentGroup>();

/** The failure text reported for an edit role whose DevTools call did not start. */
function describeDevToolsFailure(error: unknown): string {
  if (error instanceof DevToolsStartError) {
    return hresultText(error.hresult);
  }
  return error instanceof Error ? error.message : String(error);
}
// Slots/IIDs are from the pinned WebView2 SDK 1.0.4129.50, Win64 COM ABI.
/** Own one controller and its callbacks; profile peers share an environment and its final process drain. */
export class WebView {
  webview: Pointer | undefined;
  private controller: Pointer | undefined;
  private environment: Pointer | undefined;
  private environment5: Pointer | undefined;
  /** Requested content scheme, undefined until requested; applied once the controller exists. */
  private colorScheme: NativeContentColorScheme | undefined;
  private colorSchemeUnsupportedLogged = false;
  /** Requested opaque `#rrggbb` document background, applied as soon as a controller exists. */
  private backgroundColor: string | undefined;
  private browserToken: bigint | undefined;
  private readonly events: {
    target: Pointer;
    slot: number;
    token: bigint;
    callback: ComHandler;
  }[] = [];
  private readonly completions: ComHandler[] = [];
  /** In-flight editing-command completions; released ones are pruned on the next command. */
  private readonly editCalls = new EditCommandCalls<ComHandler>({
    dispose: disposeHandlers,
    abandon: abandonHandlers,
    reclaim: reclaimHandlers,
  });
  private creating = 0;
  private closing = false;
  private detached = false;
  private browserExited = false;
  private browserFailed = false;
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
  private readonly profilePath: string;
  private readonly group: EnvironmentGroup;
  private readonly loader;
  failure: unknown;
  private navigationId: bigint | undefined;
  private downloads: WebViewDownloads | undefined;
  private loading = false;
  private stoppedNavigationId: bigint | undefined;
  private readonly creationStarted = performance.now();
  private creationPhase = "environment-waiting";
  private phaseStarted = this.creationStarted;

  /** Snapshot startup progress without querying COM or changing the preparation deadline. */
  creationSnapshot() {
    const now = performance.now();
    return {
      phase: this.creationPhase,
      elapsedMs: Math.round(now - this.creationStarted),
      phaseElapsedMs: Math.round(now - this.phaseStarted),
      pendingCreations: this.creating,
      closing: this.closing,
    };
  }

  /** Fixed creation milestones remain bounded even when the native completion arrives during cleanup. */
  private creationStage(stage: string, result?: number): void {
    // A synchronous request return must not overwrite a reentrant completion's phase.
    if (!stage.endsWith("-returned")) {
      this.creationPhase = stage;
      this.phaseStarted = performance.now();
    }
    this.hooks.log("webview-creation", {
      stage,
      ...this.creationSnapshot(),
      ...(result === undefined
        ? {}
        : {
            result,
          }),
    });
  }

  /** Begin async WebView2 creation; ready fires after configuration, independently of HWND visibility. */
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
      /** Optional: only the window host publishes document titles. */
      titleChanged?(title: string): void;
      close(force?: boolean): void;
      ready(): void;
      documentComplete(error: WireError | null): void;
      /** Every key event the controller reports (the page still handles it), so the window's menu bar sees keys while the page has focus. */
      key?(kind: number, virtualKey: number): void;
      log(event: string, data?: object): void;
    },
    legacyProfile = false,
    private readonly devtools = false,
    profilePath?: string,
  ) {
    this.backgroundColor = spec.window.backgroundColor;
    const profile =
      profilePath ??
      resolve(
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
    this.profilePath = profile;
    const existing = environments.get(profile);
    if (!WebView.canUseEnvironment(existing)) {
      this.loader.close();
      throw new BunawayError({
        code: "BUSY",
        message: "WebView profile cleanup is still in progress.",
      });
    }
    this.group = existing ?? {
      members: new Set(),
      waiting: new Set(),
    };
    this.group.members.add(this);
    environments.set(profile, this.group);
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
        this.creationStage("controller-completed", Number(result));
        try {
          if (this.closing && (Number(result) < 0 || !created)) {
            return;
          }
          checkHresult(Number(result), "Controller completion");
          assert(created);
          this.controller = created as Pointer;
          addRef(this.controller);
          this.webview = getObject(this.controller, 25);
          const pid = new Uint32Array(1);
          checkHresult(
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
            browserVersion: this.environment
              ? getString(this.environment, 5)
              : "",
          });
          if (this.closing) {
            return;
          }
          this.applyBackgroundColor();
          this.configure(assets);
          this.applyRequestedColorScheme();
          this.resize();
          checkHresult(
            method(this.controller, 4, [
              "i32",
            ])(1),
            "put_IsVisible",
          );
          this.creationStage("configured");
          this.hooks.ready();
        } catch (error) {
          this.failure = error;
          this.hooks.close(true);
        }
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
        this.creationStage("environment-completed", Number(result));
        if (Number(result) < 0 || !created) {
          for (const member of this.group.waiting) {
            member.creating--;
            member.failure = new Error(`Environment completion: ${result}`);
          }
          this.group.waiting.clear();
          return;
        }
        // Keep a group reference even when the first window closes before its siblings.
        this.group.environment = created as Pointer;
        addRef(this.group.environment);
        for (const member of this.group.waiting) {
          member.receiveEnvironment(this.group.environment);
        }
        this.group.waiting.clear();
      },
    );
    this.completions.push(environment, controller, browser);
    this.creating++;
    if (this.group.environment) {
      this.receiveEnvironment(this.group.environment);
    } else {
      this.group.waiting.add(this);
      if (!existing) {
        this.creationStage("environment-requested");
        const result =
          this.loader.symbols.CreateCoreWebView2EnvironmentWithOptions(
            null,
            ptr(this.profile),
            null,
            environment.pointer,
          );
        this.creationStage("environment-returned", result);
        if (result < 0) {
          this.creating--;
          this.group.waiting.delete(this);
          this.failure = new Error(`CreateEnvironment: ${result}`);
        }
      } else if (existing.waiting.size === 1) {
        // A synchronously failed environment cannot acquire fresh controllers.
        this.creating--;
        this.group.waiting.delete(this);
        this.failure = new Error("Shared WebView environment creation failed.");
      }
    }
  }

  /** Each member retains the same environment but owns its own controller and callback tokens. */
  private receiveEnvironment(environment: Pointer): void {
    this.creating--;
    this.creationStage("environment-received");
    this.environment = environment;
    addRef(environment);
    try {
      this.environment5 = query(
        environment,
        "d6eb91dd-c3d2-45e5-bd29-6dc2bc4de9cf",
      );
      const browser = this.completions[2];
      const controller = this.completions[1];
      assert(browser && controller);
      const token = new BigInt64Array(1);
      checkHresult(
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
      this.creationStage("controller-requested");
      const result = method(environment, 3, [
        "u64",
        "ptr",
      ])(this.hwnd, controller.pointer);
      this.creationStage("controller-returned", result);
      if (result < 0) {
        this.creating--;
      }
      checkHresult(result, "CreateController");
    } catch (error) {
      this.failure = error;
    }
  }

  /**
   * Retain an event callback until detach removes its subscription and finish drains it.
   * The subscription lives on `target`, which is the WebView unless a controller event is wanted.
   */
  private on(
    slot: number,
    iid: string,
    invoke: (args: Pointer) => void,
    target = this.webview,
  ) {
    assert(target);
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
    checkHresult(
      method(target, slot, [
        "ptr",
        "ptr",
      ])(callback.pointer, ptr(token)),
      "add event",
    );
    this.events.push({
      target,
      slot: slot + 1,
      token: token[0] ?? 0n,
      callback,
    });
  }

  /** Apply browser settings and origin/resource policy before the view is shown. */
  private configure(assets: string) {
    assert(this.webview);
    const webview = this.webview;
    // Default deny applies even when an app does not register the optional window plugin.
    this.downloads = new WebViewDownloads(
      webview,
      (url, source) =>
        this.origins.includes(originOf(url)) &&
        this.origins.includes(originOf(source)),
      (callback) => this.completions.push(callback),
      () => !this.closing,
      (error) => {
        this.failure = error;
        this.hooks.close(true);
      },
      (url) =>
        this.hooks.log("download-rejected", {
          url,
        }),
    );
    const settings = getObject(this.webview, 3);
    try {
      if (this.spec.window.titlebar === "custom") {
        enableCustomTitlebar(settings);
      }
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
        checkHresult(
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
          checkHresult(
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
        checkHresult(
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
        checkHresult(
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
        checkHresult(
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
        this.loading = true;
        const id = new BigUint64Array(1);
        checkHresult(
          method(args, 9, [
            "ptr",
          ])(ptr(id)),
          "get_NavigationId(starting)",
        );
        if (this.navigationId !== id[0]) {
          this.navigationId = id[0];
          this.downloads?.operations.revokePending();
          this.stoppedNavigationId = undefined;
          this.hooks.revoke("navigation");
        }
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
      checkHresult(
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
      const id = new BigUint64Array(1);
      checkHresult(
        method(args, 5, [
          "ptr",
        ])(ptr(id)),
        "get_NavigationId(completed)",
      );
      if (id[0] !== this.navigationId) {
        return;
      }
      this.loading = false;
      const stopped = this.stoppedNavigationId === id[0];
      this.stoppedNavigationId = undefined;
      const success = new Int32Array(1);
      checkHresult(
        method(args, 3, [
          "ptr",
        ])(ptr(success)),
        "get_IsSuccess",
      );
      this.hooks.log("navigation-completed", {
        success: !!success[0],
        uri: this.webview ? getString(this.webview, 4) : "",
      });
      let error: WireError | null = null;
      if (!success[0]) {
        const status = new Int32Array(1);
        checkHresult(
          method(args, 4, [
            "ptr",
          ])(ptr(status)),
          "get_WebErrorStatus",
        );
        this.hooks.log("navigation-error", {
          status: status[0],
        });
        error = {
          code:
            stopped || status[0] === WEB_ERROR_OPERATION_CANCELED
              ? "CANCELLED"
              : "INTERNAL",
          message: "Document navigation did not complete.",
        };
      }
      this.hooks.documentComplete(error);
    });
    // add_DocumentTitleChanged: the handler reads get_DocumentTitle (slot 48) of the sender.
    this.on(46, "f5f2b923-958e-4042-8f5f-a2b3d6ba1a0b", () => {
      if (this.webview) {
        this.hooks.titleChanged?.(getString(this.webview, 48));
      }
    });
    // ICoreWebView2 receives top-level messages only; no FrameWebMessageReceived handlers are installed.
    this.on(34, "57213f19-00e6-49fa-8e07-898ea01ecbd2", (args) =>
      this.hooks.message(getString(args, 3), getString(args, 4)),
    );
    this.on(44, "d4c185fe-c81c-4989-97af-2d3fa7ab5651", (args) => {
      checkHresult(
        method(args, 6, [
          "i32",
        ])(1),
        "Handle new window",
      );
      this.hooks.log("new-window-blocked");
    });
    this.on(23, "15e1c6a3-c72a-4df3-91d7-d097fbec6bfd", (args) => {
      checkHresult(
        method(args, 7, [
          "i32",
        ])(2),
        "Deny permission",
      );
      const args3 = query(args, "e61670bc-3dce-4177-86d2-c629ae3cb6ac");
      try {
        checkHresult(
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
    if (this.controller) {
      // ICoreWebView2Controller::add_AcceleratorKeyPressed; the page keeps handling the key.
      this.on(
        WEBVIEW_CONTROLLER_ACCELERATOR_KEY_SLOT,
        "b29c7e28-fa79-41a8-8e44-65811c76dcb2",
        (args) => {
          const kind = new Int32Array(1);
          const key = new Uint32Array(1);
          checkHresult(
            method(args, 3, [
              "ptr",
            ])(ptr(kind)),
            "get_KeyEventKind",
          );
          checkHresult(
            method(args, 4, [
              "ptr",
            ])(ptr(key)),
            "get_VirtualKey",
          );
          this.hooks.key?.(kind[0] ?? 0, key[0] ?? 0);
        },
        this.controller,
      );
    }
    this.on(25, "79e0aea4-990b-42d9-aa1d-0fcc2e5bc7f1", (args) => {
      const kind = new Int32Array(1);
      checkHresult(
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
        this.browserFailed = true;
        this.hooks.close(true);
      } else {
        this.downloads?.operations.revokePending();
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
            checkHresult(
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
        checkHresult(
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
        checkHresult(
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

  /** Startup and recovery navigation use the same policy check as public navigation. */
  navigate() {
    const webview = this.webview;
    if (webview && !this.closing) {
      checkHresult(
        withWide(this.spec.home, (address) =>
          method(webview, 5, [
            "ptr",
          ])(address),
        ),
        "Navigate",
      );
    }
  }
  /** Request a print dialog, leaving printer selection and submission to the user. */
  showPrintUI(kind: "browser" | "system") {
    if (this.closing) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "WebView is closed.",
      });
    }
    if (!this.webview) {
      throw new BunawayError({
        code: "BUSY",
        message: "WebView is not ready.",
      });
    }
    // ICoreWebView2_16, from pinned SDK 1.0.4129.50. Older runtimes need an explicit capability error.
    const printing = query(
      this.webview,
      "0eb34dc9-9f91-41e1-8639-95cd5943906b",
      true,
    );
    if (!printing) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message:
          "The installed WebView2 runtime does not provide print dialogs.",
      });
    }
    try {
      checkHresult(
        method(printing, 114, [
          "i32",
        ])(kind === "browser" ? 0 : 1),
        "ShowPrintUI",
      );
    } finally {
      release(printing);
    }
  }

  /** Download service readiness is independent of the document/SDK handshake. */
  downloadOperations() {
    if (this.closing) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "WebView is closed.",
      });
    }
    if (!this.downloads) {
      throw new BunawayError({
        code: "BUSY",
        message: "WebView is not ready.",
      });
    }
    return this.downloads.operations;
  }

  /** Reject before COM access when the controller is unavailable or closing. */
  private requireWebView(): Pointer {
    if (this.closing) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "WebView is closed.",
      });
    }
    if (!this.webview || !this.controller) {
      throw new BunawayError({
        code: "BUSY",
        message: "WebView is not ready.",
      });
    }
    return this.webview;
  }

  /** Start navigation without expanding allowed origins; redirects still pass NavigationStarting. */
  navigateTo(url: string) {
    if (!this.origins.includes(originOf(url)) || url.includes("\0")) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "WebView navigation origin denied.",
      });
    }
    const webview = this.requireWebView();
    checkHresult(
      withWide(url, (address) =>
        method(webview, 5, [
          "ptr",
        ])(address),
      ),
      "Navigate",
    );
  }

  /** Move keyboard focus into the page, e.g. after a native popup closed; it does not activate the window. */
  moveFocusToContent(): void {
    this.requireWebView();
    assert(this.controller);
    checkHresult(
      method(this.controller, WEBVIEW_CONTROLLER_MOVE_FOCUS_SLOT, [
        "i32",
      ])(MOVE_FOCUS_REASON_PROGRAMMATIC),
      "MoveFocus",
    );
  }

  /**
   * Run an editing command in the page's focused document through the DevTools protocol.
   *
   * The command runs as `document.execCommand` from a `Runtime.evaluate` call, so it does not
   * depend on the keyboard layout, produces no key events and never injects input into another
   * application. The call works with the DevTools UI disabled. Focus is followed from the top
   * document into nested same-origin frames; a cross-origin frame is skipped. Paste inserts the
   * clipboard's plain text instead (see `pasteClipboardText`).
   *
   * Returns false, doing nothing, while the WebView is closing or not ready. Completion is
   * observed on the next pump; a refused focus move, a refused command and protocol failures
   * after the call started (for example a navigating page) are reported through `report`. A
   * failure to start the call throws. While this view tracks MAX_IN_FLIGHT_EDIT_CALLS calls, or
   * more than MAX_ABANDONED_COMPLETIONS abandoned handlers are still held, a command starts no
   * DevTools call and is reported as skipped (`busy`).
   */
  executeEditCommand(
    command: NativeMenuEditRole,
    report: EditCommandReport,
  ): boolean {
    if (this.closing || !this.webview || !this.controller) {
      return false;
    }
    const webview = this.webview;
    // Release finished calls and reclaim abandoned handlers first, so only what is still pending
    // counts toward the limits. This is the only prune of a command; the calls below skip it.
    this.editCalls.prune();
    if (this.editCalls.isBusy()) {
      report.skipped("busy");
      return true;
    }
    // A closed popup normally returns focus to the page; restore it when the host did not.
    // A minimized or hidden window can refuse; the command may still apply, so continue and
    // report the refusal separately from the command's own outcome.
    if (!this.hasInputFocus()) {
      try {
        this.moveFocusToContent();
      } catch (error) {
        report.focusFailed(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (command === "paste") {
      this.pasteClipboardText(webview, report);
      return true;
    }
    this.editCalls.start(
      command,
      (isActive) =>
        callDevToolsProtocolMethod(
          webview,
          "Runtime.evaluate",
          JSON.stringify(editCommandEvaluateParameters(command)),
          ({ hresult, json }) => {
            // A late completion after cleanup or abandonment must touch no view or host state.
            if (!isActive()) {
              return;
            }
            const verdict = interpretEditCommandResult(hresult, json);
            if (verdict.kind === "failed") {
              report.failed(verdict.reason);
            } else if (verdict.kind === "skipped") {
              report.skipped(verdict.reason);
            } else {
              report.executed?.(verdict.result);
            }
          },
        ),
      {
        prune: false,
      },
    );
    return true;
  }

  /**
   * Insert the clipboard's plain text into the focused document.
   *
   * `execCommand("paste")` is refused for host-triggered calls, so the host reads CF_UNICODETEXT
   * once and inserts it with `Input.insertText`, which fires beforeinput (`insertText`) instead
   * of a paste event. A first `Runtime.evaluate` locates the focused document with the same
   * frame rules as other roles; the insertion starts from its completion, only while the view
   * is live and open and the limits of `executeEditCommand` still allow a call. Both calls are
   * tracked, and neither prunes: the first follows the caller's prune and the second starts
   * inside a COM callback. Focus is checked before the text is inserted, so focus that
   * moves to a cross-origin frame in between can still receive the text.
   */
  private pasteClipboardText(webview: Pointer, report: EditCommandReport) {
    const clipboard = readClipboardText();
    if (clipboard.kind !== "text") {
      report.skipped(
        {
          empty: "clipboard-empty",
          unavailable: "clipboard-unavailable",
          "too-large": "clipboard-too-large",
        }[clipboard.kind],
      );
      return;
    }
    this.editCalls.start(
      "paste",
      (isActiveTarget) =>
        callDevToolsProtocolMethod(
          webview,
          "Runtime.evaluate",
          JSON.stringify(focusTargetEvaluateParameters()),
          ({ hresult, json }) => {
            if (!isActiveTarget() || this.closing) {
              return;
            }
            const verdict = interpretEditCommandResult(hresult, json);
            if (verdict.kind === "failed") {
              report.failed(verdict.reason);
              return;
            }
            if (verdict.kind === "skipped") {
              report.skipped(verdict.reason);
              return;
            }
            // Other commands may have filled the limits since the first call started.
            if (this.editCalls.isBusy()) {
              report.skipped("busy");
              return;
            }
            try {
              this.editCalls.start(
                "paste",
                (isActiveInsert) =>
                  callDevToolsProtocolMethod(
                    webview,
                    "Input.insertText",
                    JSON.stringify({
                      text: clipboard.text,
                    }),
                    ({ hresult: inserted }) => {
                      if (!isActiveInsert()) {
                        return;
                      }
                      if (inserted < 0) {
                        report.failed(hresultText(inserted));
                      } else {
                        report.executed?.(verdict.result);
                      }
                    },
                  ),
                {
                  prune: false,
                },
              );
            } catch (error) {
              // Starting inside a COM callback must not unwind into native code. The refused
              // call's handler stays tracked and is released by a later prune.
              report.failed(describeDevToolsFailure(error));
            }
          },
        ),
      {
        prune: false,
      },
    );
  }

  /** Read actual browser URL, title, history availability, controller zoom and input focus. */
  getState() {
    const webview = this.requireWebView();
    return {
      url: getString(webview, 4),
      title: getString(webview, 48),
      loading: this.loading,
      canGoBack: this.historyAvailable(38),
      canGoForward: this.historyAvailable(39),
      zoomFactor: this.zoomFactor(),
      focused: this.hasInputFocus(),
    };
  }

  /**
   * Whether this window is the OS foreground window and keyboard focus sits inside its WebView.
   *
   * The controller is parented to the top-level `hwnd`, so the foreground comparison uses it
   * directly. WebView2 renders in child HWNDs that may belong to another (browser) process, but
   * IsChild only walks the window tree and ignores process boundaries. A zero thread id asks for
   * the foreground thread's GUI state. Reading never moves focus.
   */
  private hasInputFocus(): boolean {
    if (user.symbols.GetForegroundWindow() !== this.hwnd) {
      return false;
    }
    const info = new DataView(new ArrayBuffer(GUI_THREAD_INFO_SIZE));
    info.setUint32(0, GUI_THREAD_INFO_SIZE, true);
    // Without foreground GUI thread info the focus window cannot be confirmed.
    if (!user.symbols.GetGUIThreadInfo(0, ptr(info.buffer))) {
      return false;
    }
    const focusWindow = info.getBigUint64(GUI_THREAD_INFO_FOCUS_OFFSET, true);
    return (
      focusWindow !== 0n &&
      focusWindow !== this.hwnd &&
      user.symbols.IsChild(this.hwnd, focusWindow) !== 0
    );
  }

  private historyAvailable(slot: 38 | 39): boolean {
    const value = new Int32Array(1);
    checkHresult(
      method(this.requireWebView(), slot, [
        "ptr",
      ])(ptr(value)),
      "Read history availability",
    );
    return value[0] !== 0;
  }

  /** Reload revokes the old document when its NavigationStarting event is accepted. */
  reload() {
    checkHresult(method(this.requireWebView(), 31, [])(), "Reload");
  }

  /** Stop completes through the existing NavigationCompleted cancellation path. */
  stop() {
    const webview = this.requireWebView();
    const previous = this.stoppedNavigationId;
    // WebView2 can report CONNECTION_ABORTED for Stop. Preserve explicit caller cancellation.
    this.stoppedNavigationId = this.loading ? this.navigationId : undefined;
    try {
      checkHresult(method(webview, 43, [])(), "Stop");
    } catch (error) {
      this.stoppedNavigationId = previous;
      throw error;
    }
  }

  goBack(): boolean {
    if (!this.historyAvailable(38)) {
      return false;
    }
    checkHresult(method(this.requireWebView(), 40, [])(), "GoBack");
    return true;
  }

  goForward(): boolean {
    if (!this.historyAvailable(39)) {
      return false;
    }
    checkHresult(method(this.requireWebView(), 41, [])(), "GoForward");
    return true;
  }

  private zoomFactor(): number {
    this.requireWebView();
    assert(this.controller);
    const value = new Float64Array(1);
    checkHresult(
      method(this.controller, 7, [
        "ptr",
      ])(ptr(value)),
      "get_ZoomFactor",
    );
    return value[0] ?? 1;
  }

  /** Zoom is controlled through this controller; report browser normalization rather than the input. */
  setZoomFactor(factor: number): number {
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Zoom factor must be between 0.25 and 5.",
      });
    }
    this.requireWebView();
    assert(this.controller);
    checkHresult(
      method(this.controller, 8, [
        "f64",
      ])(factor),
      "put_ZoomFactor",
    );
    return this.zoomFactor();
  }

  /** A policy grant cannot turn on developer tools in a production host. */
  openDevTools() {
    if (!this.devtools) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "DevTools are disabled by the host.",
      });
    }
    checkHresult(method(this.requireWebView(), 51, [])(), "OpenDevToolsWindow");
  }

  /** Acquire the audio extension only for an open, initialized controller. */
  private audioInterface() {
    if (this.closing) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "WebView is closed.",
      });
    }
    if (!this.webview) {
      throw new BunawayError({
        code: "BUSY",
        message: "WebView is not ready.",
      });
    }
    // ICoreWebView2_8, SDK 1.0.4129.50; required by the supported WebView2 runtime.
    return query(this.webview, "e9632730-6e1e-43ab-b7b8-7b2c9e62e094");
  }
  /** Report actual browser playback independently of its controller's mute setting. */
  getAudioState() {
    const audio = this.audioInterface();
    try {
      const muted = new Int32Array(1);
      const playing = new Int32Array(1);
      checkHresult(
        method(audio, 83, [
          "ptr",
        ])(ptr(muted)),
        "get_IsMuted",
      );
      checkHresult(
        method(audio, 87, [
          "ptr",
        ])(ptr(playing)),
        "get_IsDocumentPlayingAudio",
      );
      return {
        muted: muted[0] !== 0,
        playing: playing[0] !== 0,
      };
    } finally {
      release(audio);
    }
  }
  /** Mute this controller without changing the document or its media permission policy. */
  setAudioMuted(muted: boolean) {
    const audio = this.audioInterface();
    try {
      checkHresult(
        method(audio, 84, [
          "i32",
        ])(muted ? 1 : 0),
        "put_IsMuted",
      );
    } finally {
      release(audio);
    }
  }
  /**
   * Remember the content color scheme and apply it as soon as a controller exists. A closing view
   * keeps the request without touching the profile; a runtime without profile color schemes is
   * logged and skipped so the window frame change still succeeds.
   */
  setColorScheme(scheme: NativeContentColorScheme): void {
    this.colorScheme = scheme;
    this.applyColorScheme();
  }
  /** Apply a scheme requested before the controller existed; a failure must not abort creation. */
  private applyRequestedColorScheme(): void {
    // An explicit auto still applies: the shared profile may have been pinned by another window.
    if (this.colorScheme === undefined) {
      return;
    }
    try {
      this.applyColorScheme();
    } catch (error) {
      this.hooks.log("color-scheme-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  /**
   * Apply an opaque document background. A color requested before the controller exists is kept
   * and applied when it completes. A failed `put` throws and keeps the previous color; if only the read-back fails, the controller may already hold the new color while the remembered color stays unchanged.
   */
  setBackgroundColor(color: string): void {
    if (this.controller && !this.closing) {
      this.putBackgroundColor(color);
    }
    this.backgroundColor = color;
  }
  private applyBackgroundColor(): void {
    if (this.backgroundColor !== undefined) {
      this.putBackgroundColor(this.backgroundColor);
    }
  }
  /**
   * Set the controller's default background and read it back, which catches a mismatched put/get slot.
   * The controller returns the stored value unchanged, so the read-back cannot detect a wrong byte
   * order; a misplaced alpha byte is rejected by put, which accepts only 0 or 255.
   */
  private putBackgroundColor(color: string): void {
    const controller = this.controller;
    assert(controller);
    const rgb = Number.parseInt(color.slice(1), 16);
    // COREWEBVIEW2_COLOR is the bytes A, R, G, B in memory, so the little-endian u32 is B, G, R, A from the top.
    const packed =
      (0xff |
        (((rgb >> 16) & 0xff) << 8) |
        (((rgb >> 8) & 0xff) << 16) |
        ((rgb & 0xff) << 24)) >>>
      0;
    const controller2 = query(controller, WEBVIEW_CONTROLLER2_IID);
    try {
      checkHresult(
        method(
          controller2,
          WEBVIEW_CONTROLLER2_PUT_DEFAULT_BACKGROUND_COLOR_SLOT,
          [
            "u32",
          ],
        )(packed),
        "put_DefaultBackgroundColor",
      );
      const stored = new Uint32Array(1);
      checkHresult(
        method(
          controller2,
          WEBVIEW_CONTROLLER2_PUT_DEFAULT_BACKGROUND_COLOR_SLOT - 1,
          [
            "ptr",
          ],
        )(ptr(stored)),
        "get_DefaultBackgroundColor",
      );
      assert.equal(
        stored[0],
        packed,
        "WebView2 did not keep the requested background color.",
      );
    } finally {
      release(controller2);
    }
  }
  private applyColorScheme(): void {
    if (!this.webview || this.closing || this.colorScheme === undefined) {
      return;
    }
    if (
      !setProfileColorScheme(this.webview, this.colorScheme) &&
      !this.colorSchemeUnsupportedLogged
    ) {
      this.colorSchemeUnsupportedLogged = true;
      this.hooks.log("color-scheme-unsupported");
    }
  }
  source() {
    return this.webview ? getString(this.webview, 4) : "";
  }
  send(text: string) {
    const webview = this.webview;
    if (webview && !this.closing) {
      checkHresult(
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
    checkHresult(
      method(this.controller, 6, [
        "ptr",
      ])(ptr(rect)),
      "put_Bounds",
    );
  }
  requestClose() {
    this.closing = true;
  }
  /** Old controllers can finish before the last shared owner; retain replacement reservations until its drain completes. */
  canReuseProfile(): boolean {
    return WebView.canUseEnvironment(environments.get(this.profilePath));
  }
  /** A live controller can share its environment; an entirely closing group must drain first. */
  private static canUseEnvironment(
    group: EnvironmentGroup | undefined,
  ): boolean {
    return (
      !group ||
      (!group.drainer &&
        [
          ...group.members,
        ].some((member) => !member.closing))
    );
  }
  /**
   * Record handles of the WebView2 browser and helper processes so teardown can wait for them.
   * Does nothing before the environment exists; a failed query throws and aborts detaching.
   */
  private captureProcessHandles(): void {
    if (!this.environment) {
      return;
    }
    const env8 = query(
      this.environment,
      "d6eb91dd-c3d2-45e5-bd29-6dc2bc4de9cf",
    );
    try {
      const collection = getObject(env8, 18);
      try {
        const count = new Uint32Array(1);
        checkHresult(
          method(collection, 3, [
            "ptr",
          ])(ptr(count)),
          "get process count",
        );
        assert((count[0] ?? 0) <= 1024, "Unexpected WebView process count");
        for (let index = 0; index < (count[0] ?? 0); index++) {
          const out = new BigUint64Array(1);
          checkHresult(
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
            checkHresult(
              method(processInfo, 3, [
                "ptr",
              ])(ptr(pid)),
              "get process id",
            );
            checkHresult(
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
    this.downloads?.detach(this.isBrowserUnavailable());
    // Capture process handles before controller closure to track WebView2 children.
    this.captureProcessHandles();
    if (this.webview) {
      for (const { target, slot, token } of this.events) {
        checkHresult(
          method(target, slot, [
            "i64",
          ])(token),
          "remove event",
        );
      }
    }
    if (this.controller) {
      checkHresult(method(this.controller, 24)(), "Close");
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
    if (
      [
        ...this.group.members,
      ].every((member) => member.detached)
    ) {
      this.group.drainer = this;
    }
    return true;
  }
  /** Owned process evidence permits releasing failed downloads without calling a dead broker. */
  isBrowserUnavailable(): boolean {
    return (
      this.browserFailed ||
      this.browserExited ||
      (this.browserHandle !== 0n &&
        kernel.symbols.WaitForSingleObject(this.browserHandle, 0) === 0)
    );
  }
  /** Poll shutdown until children and callbacks drain, returning true after disposal. */
  finish(): boolean {
    if (this.finished) {
      return true;
    }
    if (!this.detached) {
      return false;
    }
    const drainsGroup = this.group.drainer === this;
    if (
      drainsGroup &&
      [
        ...this.group.members,
      ].some((member) => member !== this && !member.finished)
    ) {
      return false;
    }
    if (
      drainsGroup &&
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
    // WebView2 may keep an in-flight editing-command completion; wait a bounded time for its
    // release, then abandon it so cleanup completes.
    if (
      !this.editCalls.settle(
        performance.now() - this.closedAt,
        (editCommand, total, overLimit) =>
          this.hooks.log("menu-role-completion-abandoned", {
            command: editCommand,
            abandoned: total,
            overLimit,
          }),
      )
    ) {
      return false;
    }
    if (this.environment5 && this.browserToken !== undefined) {
      checkHresult(
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
    if (drainsGroup && this.group.environment) {
      release(this.group.environment);
      delete this.group.environment;
    }
    // Environment references can own runtime-side resources. Release them after
    // BrowserProcessExited, then keep the STA/trampolines alive while children drain.
    if (
      drainsGroup &&
      [
        ...this.processHandles.values(),
      ].some((handle) => kernel.symbols.WaitForSingleObject(handle, 0) !== 0)
    ) {
      this.checkShutdownDeadline();
      return false;
    }
    // Settled editing completions hold only the owner reference, so they cannot be invoked
    // again and stay out of the post-detach invocation check.
    const callbacks = [
      ...this.events.map(({ callback }) => callback),
      ...this.completions,
    ];
    const editHandlers = this.editCalls.handlers();
    assert(
      [
        ...callbacks,
        ...editHandlers,
      ].every((callback) => callback.refs === 1),
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
    this.editCalls.release();
    this.events.length = 0;
    this.completions.length = 0;
    this.loader.close();
    this.finished = true;
    this.group.members.delete(this);
    if (drainsGroup) {
      assert(this.group.members.size === 0, "Environment still owns a window");
      environments.delete(this.profilePath);
    }
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
