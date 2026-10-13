import { dlopen } from "bun:ffi";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Objc } from "../../native/macos/bun/objc.ts";

// Compiled only into the disposable CI app. It never fetches incoming URLs.
const resources = resolve(dirname(process.execPath), "../Resources");
const events = resolve(resources, "events.jsonl");
const stop = resolve(resources, "stop");
const objc = new Objc();
const record = (kind: string, target: string) =>
  appendFileSync(
    events,
    `${JSON.stringify({
      kind,
      target,
      pid: process.pid,
    })}\n`,
  );
const app = objc.send(objc.class("NSApplication"), "sharedApplication");
if (!app) {
  throw new Error("Fixture could not initialize NSApplication.");
}
const runLoop = dlopen(
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  {
    CFRunLoopRunInMode: {
      args: [
        "u64",
        "f64",
        "bool",
      ],
      returns: "i32",
    },
  },
);
const delegate = objc.delegate([
  {
    selector: "application:openURLs:",
    arguments: 2,
    returns: "void",
    encoding: "v@:@@",
    call: (_self, _selector, _app, urls) => {
      const count = Number(objc.send(urls ?? null, "count"));
      for (let index = 0; index < count; index++) {
        const url = objc.send(urls ?? null, "objectAtIndex:", index);
        record("url", objc.text(objc.send(url, "absoluteString")));
      }
    },
  },
  {
    selector: "application:openFile:",
    arguments: 2,
    returns: "bool",
    encoding: "B@:@@",
    call: (_self, _selector, _app, path) => {
      record("file", objc.text(path ?? null));
      return true;
    },
  },
]);
objc.send(app, "setActivationPolicy:", 2);
objc.send(app, "setDelegate:", delegate);
objc.send(app, "finishLaunching");
const bundle = objc.send(objc.class("NSBundle"), "mainBundle");
record("ready", objc.text(objc.send(bundle, "bundleIdentifier")));
record("bundle", objc.text(objc.send(bundle, "bundlePath")));
const deadline = Date.now() + 60000;
setInterval(() => {
  if (existsSync(stop) || Date.now() > deadline) {
    objc.send(app, "setDelegate:", null);
    objc.send(delegate, "release");
    process.exit(0);
  }
  objc.withAutoreleasePool(() => {
    runLoop.symbols.CFRunLoopRunInMode(
      BigInt(objc.string("kCFRunLoopDefaultMode")),
      0,
      true,
    );
    for (let index = 0; index < 64; index++) {
      const event = objc.nextEvent(app);
      if (!event) {
        break;
      }
      objc.send(app, "sendEvent:", event);
    }
    objc.send(app, "updateWindows");
  });
}, 5);
