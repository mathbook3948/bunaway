import { dlopen, JSCallback, type Pointer, ptr } from "bun:ffi";
import {
  failWithCleanup,
  type NativeEventServices,
  ResourceOwner,
} from "@bunaway/plugin";
import { OBJC_PATH, OBJC_RUNTIME } from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { powerEvents } from "#power/contract";

const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const FOUNDATION = "/System/Library/Frameworks/Foundation.framework/Foundation";

type LifecycleEvent = Exclude<keyof typeof powerEvents, "power.statusChanged">;
type EventEmitter = Pick<NativeEventServices, "emit">;

/** Which notification center delivers a notification. */
type Center = "workspace" | "distributed";

type Subscription = {
  readonly event: LifecycleEvent;
  readonly center: Center;
  readonly notification: string;
  readonly selector: string;
};

/**
 * The notifications behind each event, the same sources Electron's powerMonitor uses on macOS.
 * Sleep and wake are public NSWorkspace notifications. Lock and unlock have no public API: the
 * login window posts them as distributed notifications under these names, which are stable in
 * practice but not documented by Apple.
 */
const SUBSCRIPTIONS: readonly Subscription[] = [
  {
    event: "power.suspended",
    center: "workspace",
    notification: "NSWorkspaceWillSleepNotification",
    selector: "bunawaySystemWillSleep:",
  },
  {
    event: "power.resumed",
    center: "workspace",
    notification: "NSWorkspaceDidWakeNotification",
    selector: "bunawaySystemDidWake:",
  },
  {
    event: "power.sessionLocked",
    center: "distributed",
    notification: "com.apple.screenIsLocked",
    selector: "bunawayScreenLocked:",
  },
  {
    event: "power.sessionUnlocked",
    center: "distributed",
    notification: "com.apple.screenIsUnlocked",
    selector: "bunawayScreenUnlocked:",
  },
];

/** `v@:@`: a void method taking the receiver, the selector and the NSNotification. */
const OBSERVER_METHOD_ENCODING = "v@:@";

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

const closeLibrary = (library: { close(): void }) => library.close();

/**
 * Observe sleep, wake, screen lock and screen unlock and emit `power.suspended`, `power.resumed`,
 * `power.sessionLocked` and `power.sessionUnlocked` with an empty payload.
 *
 * It must run on the macOS main thread: both notification centers deliver to the run loop of the
 * thread that registered, and the host pumps only the main run loop. One observer object, whose
 * class has a method per notification, is registered with each center. The returned release
 * removes the observer before it releases the object and closes the callbacks that the methods
 * point to, so no notification can reach a closed callback, and it is safe to call repeatedly.
 * Nothing is replayed for events that happened
 * before registration, and no current lock state is queried. Returns undefined when the host
 * provides no event service.
 */
export function watchMacosPowerLifecycle(
  events?: EventEmitter,
): (() => void) | undefined {
  if (!events) {
    return undefined;
  }
  const owner = new ResourceOwner("macOS power lifecycle cleanup failed.");
  try {
    watch(owner, events);
  } catch (error) {
    // No caller receives the release function, so undo what was registered before the failure.
    failWithCleanup(
      error,
      () => owner.dispose(),
      "macOS power lifecycle cleanup failed.",
    );
  }
  return () => owner.dispose();
}

function watch(owner: ResourceOwner, events: EventEmitter): void {
  // Bun requires a nonempty symbol table even when a framework is only loaded.
  owner.acquire(
    () =>
      dlopen(APPKIT, {
        NSApplicationLoad: {
          args: [],
          returns: "bool",
        },
      } as const),
    closeLibrary,
  );
  owner.acquire(
    () =>
      dlopen(FOUNDATION, {
        NSClassFromString: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
      } as const),
    closeLibrary,
  );
  const runtime = owner.acquire(
    () =>
      dlopen(OBJC_PATH, {
        ...pick(OBJC_RUNTIME, "objc_getClass", "sel_registerName"),
        objc_allocateClassPair: {
          args: [
            "ptr",
            "cstring",
            "usize",
          ],
          returns: "ptr",
        },
        objc_disposeClassPair: {
          args: [
            "ptr",
          ],
          returns: "void",
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
            "u64",
            "u64",
            "u64",
            "u64",
            "u64",
            "u64",
          ],
          returns: "u64",
        },
      } as const),
    closeLibrary,
  );
  // `ptr` returns only an address, so the buffers stay referenced until the next pool drain.
  const pinned: Buffer[] = [];
  const cstring = (value: string) => {
    const buffer = Buffer.from(`${value}\0`);
    pinned.push(buffer);
    return ptr(buffer);
  };
  const selector = (name: string) =>
    BigInt(runtime.symbols.sel_registerName(cstring(name)) ?? 0);
  const send = (object: bigint, name: string, ...args: bigint[]) =>
    runtime.symbols.objc_msgSend(
      object,
      selector(name),
      args[0] ?? 0n,
      args[1] ?? 0n,
      args[2] ?? 0n,
      args[3] ?? 0n,
    );
  const classOf = (name: string) =>
    BigInt(runtime.symbols.objc_getClass(cstring(name)) ?? 0) ||
    failure(`Objective-C class ${name} is unavailable.`);
  const inPool = <T>(work: () => T): T => {
    const pool = send(send(classOf("NSAutoreleasePool"), "alloc"), "init");
    try {
      return work();
    } finally {
      send(pool, "drain");
      pinned.length = 0;
    }
  };

  const callbacks = SUBSCRIPTIONS.map((subscription) =>
    owner.acquire(
      () =>
        new JSCallback(
          () => {
            try {
              events.emit(subscription.event, {});
            } catch (error) {
              // An observer callback has no caller to throw to, so the failure is reported here.
              console.error(`Could not emit ${subscription.event}.`, error);
            }
          },
          {
            args: [
              "ptr",
              "ptr",
              "ptr",
            ],
            returns: "void",
          } as const,
        ),
      closeLibrary,
    ),
  );

  // Each watch registers its own observer class. The runtime cannot safely unregister a class,
  // so the class lives until process exit; the host creates one power adapter per process.
  const observerClass = runtime.symbols.objc_allocateClassPair(
    Number(classOf("NSObject")) as Pointer,
    `BunawayPowerObserver${crypto.randomUUID().replaceAll("-", "")}`,
    0,
  );
  if (!observerClass) {
    failure("Objective-C power observer allocation failed.");
  }
  SUBSCRIPTIONS.forEach((subscription, index) => {
    if (
      !runtime.symbols.class_addMethod(
        observerClass,
        Number(selector(subscription.selector)) as Pointer,
        callbacks[index]?.ptr ?? null,
        OBSERVER_METHOD_ENCODING,
      )
    ) {
      // The pair is not registered yet, so no instance exists and it can be disposed.
      runtime.symbols.objc_disposeClassPair(observerClass);
      failure("Objective-C power observer registration failed.");
    }
  });
  runtime.symbols.objc_registerClassPair(observerClass);

  inPool(() => {
    const observer = owner.acquire(
      () => send(send(BigInt(observerClass), "alloc"), "init"),
      (instance) => inPool(() => send(instance, "release")),
    );
    if (!observer) {
      failure("Power observer could not be created.");
    }
    const centers: Record<Center, bigint> = {
      workspace: send(
        send(classOf("NSWorkspace"), "sharedWorkspace"),
        "notificationCenter",
      ),
      distributed: send(
        classOf("NSDistributedNotificationCenter"),
        "defaultCenter",
      ),
    };
    // Removal is registered before any observer is added, so a failure part way still undoes it.
    for (const center of Object.values(centers)) {
      owner.acquire(
        () => center,
        (registered) =>
          inPool(() => send(registered, "removeObserver:", observer)),
      );
    }
    for (const subscription of SUBSCRIPTIONS) {
      const name = send(
        classOf("NSString"),
        "stringWithUTF8String:",
        BigInt(cstring(subscription.notification)),
      );
      send(
        centers[subscription.center],
        "addObserver:selector:name:object:",
        observer,
        selector(subscription.selector),
        name,
        0n,
      );
    }
  });
}
