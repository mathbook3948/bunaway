import { dlopen } from "bun:ffi";
import { Objc, type ObjcObject } from "./objc.ts";
import { classifyQuit, KEY_AE_QUIT_REASON } from "./quit-reason.ts";
import { SessionEndTermination } from "./session-end-termination.ts";

const NS_APPLICATION_ACTIVATION_POLICY_REGULAR = 0;
// NSApplicationTerminateReply: the app answers cancel (the host runs its own asynchronous quit check),
// now (terminate immediately) or later (reply through replyToApplicationShouldTerminate:).
const NS_TERMINATE_CANCEL = 0;
const NS_TERMINATE_NOW = 1;
const NS_TERMINATE_LATER = 2;
/** Broadcast by NSWorkspace shortly before the system powers off (shutdown or restart). */
const POWER_OFF_NOTIFICATION = "NSWorkspaceWillPowerOffNotification";
/** `enumCodeValue` is a 32-bit OSType returned in a 64-bit register whose upper half is undefined. */
const OSTYPE_MASK = 0xffffffffn;
/** BOOL arguments occupy the low byte of a register on arm64. */
const BOOL_MASK = 0xff;
const UI_PUMP_INTERVAL_MS = 5;
const MAX_EVENTS_PER_TICK = 64;
// Registered delegate IMPs must remain callable until process exit.
const runtimeOwners: Objc[] = [];

/** Own the process-wide AppKit delegate and event pump independently of any window. */
export class MacosApplication {
  private readonly objc = new Objc();
  private readonly runLoop = dlopen(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    {
      CFRunLoopRunInMode: {
        args: [
          "ptr",
          "f64",
          "bool",
        ],
        returns: "i32",
      },
    },
  );
  private readonly app: ObjcObject;
  private readonly delegate: ObjcObject;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly profiles = new Map<string, ObjcObject>();
  private readonly sessionEnd: SessionEndTermination;

  constructor(hooks: {
    tick(): void;
    fail(error: unknown): void;
    /** Whether the host already began shutting down, so new requests are moot. */
    stopping(): boolean;
    /** The user asked to quit and the OS is not ending the session: ask the app through beforeQuit. */
    quitRequested(): void;
    /** The OS session is ending: commit an uncancellable shutdown. Called once. */
    sessionEnding(): void;
    /** The user reopened the app (Dock click) while no window is visible. */
    reopened(): void;
  }) {
    const o = this.objc;
    runtimeOwners.push(o);
    const app = o.send(o.class("NSApplication"), "sharedApplication");
    if (!app) {
      throw new Error("NSApplication creation failed.");
    }
    this.app = app;
    this.sessionEnd = new SessionEndTermination({
      commit: () => hooks.sessionEnding(),
      reply: () =>
        o.withAutoreleasePool(() =>
          o.send(app, "replyToApplicationShouldTerminate:", 1),
        ),
    });
    this.delegate = o.delegate([
      {
        selector: "applicationShouldTerminate:",
        arguments: 1,
        returns: "ptr",
        encoding: "Q@:@",
        call: () => {
          if (this.closed) {
            return NS_TERMINATE_CANCEL;
          }
          if (
            this.sessionEnd.active ||
            classifyQuit(this.currentQuitReasonCode()) === "session-end"
          ) {
            // The OS ends the session whatever the app does, so never cancel: answering cancel
            // would abort the user's logout. Hold the reply back while the app cleans up.
            return this.sessionEnd.terminateRequested() === "now"
              ? NS_TERMINATE_NOW
              : NS_TERMINATE_LATER;
          }
          if (!hooks.stopping()) {
            hooks.quitRequested();
          }
          // The host runs its own asynchronous beforeQuit and orderly shutdown, so AppKit's own
          // termination is always declined here. An approved quit ends the process by shutdown.
          return NS_TERMINATE_CANCEL;
        },
      },
      {
        // Closing a window never terminates the app by itself: the host decides closeBehavior
        // before a window closes, and keep-alive apps must stay running.
        selector: "applicationShouldTerminateAfterLastWindowClosed:",
        arguments: 1,
        returns: "bool",
        encoding: "B@:@",
        call: () => false,
      },
      {
        // Dock click or reopen Apple event. The host shows its windows itself, so AppKit does nothing more.
        selector: "applicationShouldHandleReopen:hasVisibleWindows:",
        arguments: 2,
        returns: "bool",
        encoding: "B@:@B",
        // The first two callback arguments are `self` and `_cmd`, as for every delegate method.
        call: (_self, _cmd, _sender, hasVisibleWindows) => {
          const visible = (Number(hasVisibleWindows) & BOOL_MASK) !== 0;
          if (!this.closed && !visible && !hooks.stopping()) {
            hooks.reopened();
          }
          return false;
        },
      },
      {
        selector: "workspaceWillPowerOff:",
        arguments: 1,
        encoding: "v@:@",
        call: () => {
          if (!this.closed) {
            this.sessionEnd.signal();
          }
        },
      },
    ]);
    o.withAutoreleasePool(() => {
      this.installMainMenu();
      o.send(
        this.workspaceNotifications(),
        "addObserver:selector:name:object:",
        this.delegate,
        o.selector("workspaceWillPowerOff:"),
        o.string(POWER_OFF_NOTIFICATION),
        null,
      );
    });
    o.send(
      app,
      "setActivationPolicy:",
      NS_APPLICATION_ACTIVATION_POLICY_REGULAR,
    );
    o.send(app, "setDelegate:", this.delegate);
    o.send(app, "finishLaunching");
    // One bounded main-thread turn serves every window and leaves Bun time for Worker I/O.
    this.timer = setInterval(() => {
      if (this.closed) {
        return;
      }
      try {
        o.withAutoreleasePool(() => {
          this.runLoop.symbols.CFRunLoopRunInMode(
            o.string("kCFRunLoopDefaultMode"),
            0,
            true,
          );
          for (let index = 0; index < MAX_EVENTS_PER_TICK; index++) {
            const event = o.nextEvent(app);
            if (!event) {
              break;
            }
            o.send(app, "sendEvent:", event);
          }
          o.send(app, "updateWindows");
          hooks.tick();
        });
      } catch (error) {
        hooks.fail(error);
      }
    }, UI_PUMP_INTERVAL_MS);
  }

  /**
   * Installs the smallest main menu that gives the app a Quit command: one app menu with
   * "Quit <name>" on Cmd+Q. Its `terminate:` action reaches `applicationShouldTerminate:`.
   * Other menus belong to the menu feature.
   */
  private installMainMenu(): void {
    const o = this.objc;
    const processName = o.text(
      o.send(o.send(o.class("NSProcessInfo"), "processInfo"), "processName"),
    );
    const mainMenu = o.object("NSMenu");
    const appItem = o.object("NSMenuItem");
    const appMenu = o.object("NSMenu");
    const quitItem = o.send(
      o.send(o.class("NSMenuItem"), "alloc"),
      "initWithTitle:action:keyEquivalent:",
      o.string(`Quit ${processName}`),
      o.selector("terminate:"),
      o.string("q"),
    );
    if (!quitItem) {
      throw new Error("NSMenuItem creation failed.");
    }
    o.send(appMenu, "addItem:", quitItem);
    o.send(appItem, "setSubmenu:", appMenu);
    o.send(mainMenu, "addItem:", appItem);
    o.send(this.app, "setMainMenu:", mainMenu);
    // The menu hierarchy retains its parts; drop the references that creation returned.
    for (const owned of [
      quitItem,
      appMenu,
      appItem,
      mainMenu,
    ]) {
      o.send(owned, "release");
    }
  }

  private workspaceNotifications(): ObjcObject | null {
    const o = this.objc;
    return o.send(
      o.send(o.class("NSWorkspace"), "sharedWorkspace"),
      "notificationCenter",
    );
  }

  /**
   * The `keyAEQuitReason` of the quit Apple event being handled, or undefined when termination
   * did not come from one (`terminate:` from the menu, Cmd+Q and the Dock's Quit send none).
   * Only meaningful inside `applicationShouldTerminate:`.
   */
  private currentQuitReasonCode(): number | undefined {
    const o = this.objc;
    const event = o.send(
      o.send(o.class("NSAppleEventManager"), "sharedAppleEventManager"),
      "currentAppleEvent",
    );
    const reason =
      event &&
      o.send(event, "attributeDescriptorForKeyword:", KEY_AE_QUIT_REASON);
    if (!reason) {
      return undefined;
    }
    return Number(BigInt(o.integer(reason, "enumCodeValue")) & OSTYPE_MASK);
  }

  /** App cleanup finished (`onWillQuit` and the plugin stop hooks): releases a waiting session-end reply. */
  appCleanedUp(): void {
    this.sessionEnd.appCleanedUp();
  }

  activate(): void {
    this.objc.withAutoreleasePool(() =>
      this.objc.send(this.app, "activateIgnoringOtherApps:", 1),
    );
  }

  isActive(): boolean {
    return !!this.objc.send(this.app, "isActive");
  }

  /** Isolate each view's ephemeral profile and retain it across window recreation. */
  dataStore(view: string): ObjcObject {
    let store = this.profiles.get(view);
    if (!store) {
      store =
        this.objc.send(
          this.objc.class("WKWebsiteDataStore"),
          "nonPersistentDataStore",
        ) ?? undefined;
      if (!store) {
        throw new Error("WebKit profile creation failed.");
      }
      this.objc.send(store, "retain");
      this.profiles.set(view, store);
    }
    return store;
  }

  /** Stop pumping only after all windows have detached their native callbacks. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.timer);
    this.sessionEnd.dispose();
    this.objc.send(
      this.workspaceNotifications(),
      "removeObserver:",
      this.delegate,
    );
    this.objc.send(this.app, "setDelegate:", null);
    this.objc.send(this.delegate, "release");
    for (const store of this.profiles.values()) {
      this.objc.send(store, "release");
    }
    this.profiles.clear();
    this.objc.releaseCallbacks();
    this.runLoop.close();
  }
}
