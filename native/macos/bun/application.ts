import { dlopen } from "bun:ffi";
import { Objc, type ObjcObject } from "./objc.ts";
import {
  CORE_EVENT_CLASS,
  KEY_AE_QUIT_REASON,
  QUIT_APPLICATION_EVENT_ID,
  quitReasonAccessor,
  routeQuitEvent,
} from "./quit-reason.ts";
import { SessionEndTermination } from "./session-end-termination.ts";

const NS_APPLICATION_ACTIVATION_POLICY_REGULAR = 0;
// NSApplicationTerminateReply cancel: the host never lets AppKit terminate the process, because it
// runs its own asynchronous quit check and orderly shutdown. Answering later would make
// `terminate:` spin a nested run loop inside the FFI call that pumps events, blocking the JS thread.
const NS_TERMINATE_CANCEL = 0;
/**
 * Posted in-process by AppKit shortly before the system powers off, as an earlier extra signal of a
 * session end. Apple does not document whether it is still posted once the host replaces AppKit's
 * default quit Apple event handler, so correctness never depends on it: the quit Apple event's
 * `keyAEQuitReason` alone decides (see docs/decisions/0021-macos-desktop-lifecycle.md).
 */
const POWER_OFF_NOTIFICATION = "NSWorkspaceWillPowerOffNotification";
/**
 * OSType/DescType values returned by `enumCodeValue`, `descriptorType` and `typeCodeValue` are
 * 32-bit, but arrive in a 64-bit register whose upper half is undefined.
 */
const OSTYPE_MASK = 0xffffffffn;
/** BOOL arguments occupy the low byte of a register on arm64. */
const BOOL_MASK = 0xff;
const UI_PUMP_INTERVAL_MS = 5;
const MAX_EVENTS_PER_TICK = 64;
/**
 * An `NSAppleEventManagerSuspensionID`: an opaque pointer, not an Objective-C object, that is only
 * passed back to `resumeWithSuspensionID:`. It shares the pointer-sized `ObjcObject` register type
 * of the message bridge and must never receive messages.
 */
type AppleEventSuspensionId = ObjcObject;
// Registered delegate IMPs must remain callable until process exit.
const runtimeOwners: Objc[] = [];

/** Handles one quit Apple event for the live application; `null` is the event without a descriptor. */
type QuitEventHandler = (event: ObjcObject | null) => void;
/** The live application's quit handler, or `null` before it exists and after `close()`. */
let liveQuitEventHandler: QuitEventHandler | null = null;
/** Runtime and target of the process-lifetime quit Apple event registration, created on first use. */
let quitEventRegistration:
  | {
      objc: Objc;
      target: ObjcObject;
    }
  | undefined;

/**
 * Registers the quit Apple event handler on a target that lives until the process exits, and
 * forwards each event to the live application. Public API cannot restore AppKit's default handler,
 * and removing ours would leave a quit event that arrives after `close()` (for example later in a
 * session end) unhandled with `errAEEventNotHandled`, which loginwindow can report as the app
 * cancelling the logout. The target is therefore never released and answers success at once while
 * no application is live: returning without an error makes AppKit send the success reply.
 */
function installQuitEventHandler(): void {
  if (!quitEventRegistration) {
    const objc = new Objc();
    // Its callbacks must stay callable until process exit, and `releaseCallbacks` is never called.
    runtimeOwners.push(objc);
    quitEventRegistration = {
      objc,
      target: objc.delegate([
        {
          selector: "handleQuitEvent:withReplyEvent:",
          arguments: 2,
          encoding: "v@:@@",
          call: (_self, _cmd, event) => liveQuitEventHandler?.(event),
        },
      ]),
    };
  }
  const { objc: o, target } = quitEventRegistration;
  // Registering again replaces AppKit's default handler if a later launch restored it.
  o.withAutoreleasePool(() =>
    o.send(
      o.send(o.class("NSAppleEventManager"), "sharedAppleEventManager"),
      "setEventHandler:andSelector:forEventClass:andEventID:",
      target,
      o.selector("handleQuitEvent:withReplyEvent:"),
      CORE_EVENT_CLASS,
      QUIT_APPLICATION_EVENT_ID,
    ),
  );
}

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
  /**
   * Suspensions of the session-end quit Apple events whose replies are still owed to the OS. The OS
   * may send several quit events during one session end, and each suspension must be resumed once.
   */
  private readonly suspendedQuitEvents: AppleEventSuspensionId[] = [];
  /** This application's entry in `liveQuitEventHandler`, so `close()` clears only its own. */
  private readonly quitEventHandler: QuitEventHandler;

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
      reply: () => this.resumeQuitEvent(),
    });
    this.delegate = o.delegate([
      {
        // Reached only by `terminate:` (the Quit menu, Cmd+Q or code); quit Apple events are handled
        // by `handleQuitEvent:withReplyEvent:` and never get here.
        selector: "applicationShouldTerminate:",
        arguments: 1,
        returns: "ptr",
        encoding: "Q@:@",
        call: () => {
          if (!this.closed && !hooks.stopping() && !this.sessionEnd.active) {
            hooks.quitRequested();
          }
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
    // Replaces AppKit's quit handler, which would call `terminate:`. The handler returns at once,
    // so the JS thread keeps running while a session-end reply is held back. Installed after
    // launch so it replaces the default handler AppKit registers for the quit event.
    this.quitEventHandler = (event) => {
      const action = routeQuitEvent({
        applicationLive: !this.closed,
        sessionEndActive: this.sessionEnd.active,
        quitReasonCode: event ? this.quitReasonCode(event) : undefined,
        stopping: hooks.stopping(),
      });
      if (action === "request-quit") {
        hooks.quitRequested();
      } else if (action === "session-end") {
        this.holdSessionEndQuitEvent();
      }
    };
    liveQuitEventHandler = this.quitEventHandler;
    installQuitEventHandler();
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

  private appleEvents(): ObjcObject | null {
    const o = this.objc;
    return o.send(o.class("NSAppleEventManager"), "sharedAppleEventManager");
  }

  /** The `keyAEQuitReason` of a quit Apple event, or undefined when the event carries none. */
  private quitReasonCode(event: ObjcObject): number | undefined {
    const o = this.objc;
    const reason = o.send(
      event,
      "attributeDescriptorForKeyword:",
      KEY_AE_QUIT_REASON,
    );
    if (!reason) {
      return undefined;
    }
    const descriptorType = Number(
      BigInt(o.integer(reason, "descriptorType")) & OSTYPE_MASK,
    );
    const accessor = quitReasonAccessor(descriptorType);
    if (!accessor) {
      return undefined;
    }
    return Number(BigInt(o.integer(reason, accessor)) & OSTYPE_MASK);
  }

  /**
   * Suspends the session-end quit Apple event being handled, so the OS is never answered with an
   * error, which would abort the user's logout, and its reply waits for app cleanup.
   */
  private holdSessionEndQuitEvent(): void {
    if (this.sessionEnd.quitEventReceived() !== "later") {
      return;
    }
    const suspension = this.suspendQuitEvent();
    if (suspension) {
      this.suspendedQuitEvents.push(suspension);
    } else if (this.suspendedQuitEvents.length === 0) {
      // Without a suspension the event is replied to when this handler returns. When earlier
      // events are still suspended they keep waiting for app cleanup instead. App cleanup has not
      // finished, so only the reply obligation ends here.
      this.sessionEnd.replyNotHeld();
    }
  }

  /**
   * Suspends the quit Apple event being handled, so its reply is sent later by
   * `resumeQuitEvent` while the handler returns at once. Only valid inside the event handler.
   */
  private suspendQuitEvent(): AppleEventSuspensionId | null {
    return this.objc.send(this.appleEvents(), "suspendCurrentAppleEvent");
  }

  /** Sends the success reply of every suspended quit event that is still owed, each once. */
  private resumeQuitEvent(): void {
    for (const suspension of this.suspendedQuitEvents.splice(0)) {
      this.objc.withAutoreleasePool(() =>
        this.objc.send(
          this.appleEvents(),
          "resumeWithSuspensionID:",
          suspension,
        ),
      );
    }
  }

  /**
   * App cleanup finished (`onWillQuit`, the plugin stop hooks and descendant cleanup): releases a
   * suspended session-end quit event so the OS gets its reply.
   */
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
    // Replies to a still-suspended quit event first, so the OS is never left waiting.
    this.sessionEnd.dispose();
    // The Apple event registration stays: see `installQuitEventHandler`. It now answers success at once.
    if (liveQuitEventHandler === this.quitEventHandler) {
      liveQuitEventHandler = null;
    }
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
