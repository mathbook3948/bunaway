import { dlopen } from "bun:ffi";
import { Objc, type ObjcObject } from "./objc.ts";

const NS_APPLICATION_ACTIVATION_POLICY_REGULAR = 0;
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

  constructor(hooks: {
    quit(): void;
    tick(): void;
    fail(error: unknown): void;
  }) {
    const o = this.objc;
    runtimeOwners.push(o);
    const app = o.send(o.class("NSApplication"), "sharedApplication");
    if (!app) {
      throw new Error("NSApplication creation failed.");
    }
    this.app = app;
    this.delegate = o.delegate([
      {
        selector: "applicationShouldTerminate:",
        arguments: 1,
        returns: "ptr",
        encoding: "q@:@",
        call: () => {
          if (!this.closed) {
            hooks.quit();
          }
          return null;
        },
      },
    ]);
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
