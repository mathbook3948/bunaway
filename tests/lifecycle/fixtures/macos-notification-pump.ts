import { dlopen, ptr } from "bun:ffi";
import { waitFor } from "../../fixtures/deadlines.ts";

/**
 * Posts notifications to the workspace and distributed centers of this process and pumps the main
 * run loop, which delivers them. Distributed notifications travel through the system daemon, so
 * delivery needs several run loop turns rather than one.
 */
const UTF8_ENCODING = 0x08000100;
/** One run loop turn; long enough to service the daemon, short enough to poll. */
const PUMP_SECONDS = 0.02;

const objc = dlopen("/usr/lib/libobjc.A.dylib", {
  objc_getClass: {
    args: [
      "ptr",
    ],
    returns: "u64",
  },
  sel_registerName: {
    args: [
      "ptr",
    ],
    returns: "u64",
  },
  objc_msgSend: {
    args: [
      "u64",
      "u64",
      "u64",
      "u64",
    ],
    returns: "u64",
  },
});
// Loading AppKit makes NSWorkspace resolvable by name.
dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {
  NSApplicationLoad: {
    args: [],
    returns: "bool",
  },
});
const coreFoundation = dlopen(
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
    CFStringCreateWithCString: {
      args: [
        "ptr",
        "ptr",
        "u32",
      ],
      returns: "ptr",
    },
  },
);

const cstring = (value: string) => ptr(Buffer.from(`${value}\0`));
const selector = (name: string) => objc.symbols.sel_registerName(cstring(name));
const send = (object: bigint, name: string, a = 0n, b = 0n) =>
  objc.symbols.objc_msgSend(object, selector(name), a, b);
const classOf = (name: string) => objc.symbols.objc_getClass(cstring(name));
const string = (value: string) =>
  send(classOf("NSString"), "stringWithUTF8String:", BigInt(cstring(value)));
const runLoopMode = coreFoundation.symbols.CFStringCreateWithCString(
  null,
  cstring("kCFRunLoopDefaultMode"),
  UTF8_ENCODING,
);

const pumpOnce = () =>
  coreFoundation.symbols.CFRunLoopRunInMode(runLoopMode, PUMP_SECONDS, false);

export function post(center: "workspace" | "distributed", name: string): void {
  const target =
    center === "workspace"
      ? send(
          send(classOf("NSWorkspace"), "sharedWorkspace"),
          "notificationCenter",
        )
      : send(classOf("NSDistributedNotificationCenter"), "defaultCenter");
  send(target, "postNotificationName:object:", string(name));
}

/** Pumps the main run loop until `reached` holds; fails when the run loop never delivers. */
export async function pumpUntil(
  reached: () => boolean,
  what: string,
): Promise<void> {
  await waitFor(
    () => {
      pumpOnce();
      return reached() || undefined;
    },
    {
      deadline: "childStep",
      what,
    },
  );
}

/** Pumps the main run loop for a fixed count of turns, to show that nothing more arrives. */
export function pumpTurns(turns: number): void {
  for (let turn = 0; turn < turns; turn++) {
    pumpOnce();
  }
}
