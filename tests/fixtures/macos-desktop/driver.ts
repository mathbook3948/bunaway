import { dlopen } from "bun:ffi";
import { appendFileSync } from "node:fs";
import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import { z } from "zod";
import { Objc, type ObjcObject } from "../../../native/macos/bun/objc.ts";
import { fourCharCode } from "../../../native/macos/bun/quit-reason.ts";
import { readDesktopFixture } from "./fixture-config.ts";

/** Same name AppKit posts before a logout, restart or shutdown. */
const POWER_OFF_NOTIFICATION = "NSWorkspaceWillPowerOffNotification";
const OBJC = "/usr/lib/libobjc.A.dylib";
/** `kAutoGenerateReturnID` and `kAnyTransactionID` of `AECreateAppleEvent`. */
const AUTO_GENERATE_RETURN_ID = -1;
const ANY_TRANSACTION_ID = 0;
/** `kAENoReply` send option and `kAEDefaultTimeout`; the timeout is unused without a reply. */
const AE_NO_REPLY = 1;
const AE_DEFAULT_TIMEOUT = -1;
/** Short enough to fire before the backend's cleanup finishes, long enough to be a later turn. */
const MAIN_TICK_DELAY_MS = 10;
const BOOL_MASK = 0xff;
const WINDOW_TITLES = [
  "main",
  "observer",
];

const request = z
  .object({
    action: z.enum([
      "terminate",
      "quitEvent",
      "close",
      "reopen",
      "powerOff",
      "visibleWindows",
      "windowCount",
    ]),
    /** Window title for `close` and `windowCount`, or the quit reason code (such as `shut`) for `quitEvent`. */
    title: z.string().optional(),
  })
  .strict();

/**
 * Stimulus driver for tests/lifecycle/macos-desktop.ts. It runs on the UI thread, where AppKit
 * lives, so the backend can trigger the same delegate and window paths a user or the OS would:
 * Quit command, a quit Apple event, closing a window, a reopen Apple event and the workspace
 * power-off notification. Stimuli run in a later main-thread turn, so the call returns at once with
 * the number of visible fixture windows before them; the outcome is read from the app's hooks.
 * `visibleWindows` and `windowCount` are queries: they run at once and return the visible count or
 * the count of every window with the given title.
 *
 * The adapter defines no `executeUI`, so the host runs this UI-thread operation through `execute`
 * for any caller. The backend scripts are the only caller in practice.
 */
export const driver = defineNativePlugin({
  name: "driver",
  operations: {
    drive: {
      input: request,
      output: z.number(),
    },
  },
  platforms: {
    macos: {
      thread: "ui",
      create(environment: NativeEnvironment) {
        // The app's event log, shared with the backend so the test sees one ordered record.
        const eventsPath = readDesktopFixture(environment.dataRoot).events;
        const o = new Objc();
        const app = o.send(o.class("NSApplication"), "sharedApplication");
        if (!app) {
          throw new Error("NSApplication is unavailable.");
        }
        // Apple event creation takes FourCharCodes and 16-bit ids, sending takes a double timeout;
        // Objc.send passes integer registers only, so these two messages get their own signatures.
        const createEvent = dlopen(OBJC, {
          objc_msgSend: {
            args: [
              "ptr",
              "ptr",
              "u32",
              "u32",
              "ptr",
              "i16",
              "i32",
            ],
            returns: "ptr",
          },
        });
        const sendEvent = dlopen(OBJC, {
          objc_msgSend: {
            args: [
              "ptr",
              "ptr",
              "u64",
              "f64",
              "ptr",
            ],
            returns: "ptr",
          },
        });
        /**
         * Delivers an Apple event addressed to this process, the way the Dock or `osascript` do.
         * AppKit handles it on the run loop, so its delegate sees the real `currentAppleEvent` and
         * computes window visibility itself. `reason` becomes the quit reason attribute that
         * separates a logout from a Quit command.
         */
        const sendSelfEvent = (
          eventClass: string,
          eventId: string,
          reason?: string,
        ) => {
          const descriptor = o.class("NSAppleEventDescriptor");
          const target = o.send(descriptor, "currentProcessDescriptor");
          const event = createEvent.symbols.objc_msgSend(
            descriptor,
            o.selector(
              "appleEventWithEventClass:eventID:targetDescriptor:returnID:transactionID:",
            ),
            fourCharCode(eventClass),
            fourCharCode(eventId),
            target,
            AUTO_GENERATE_RETURN_ID,
            ANY_TRANSACTION_ID,
          );
          if (!target || !event) {
            throw new Error("Apple event creation failed.");
          }
          if (reason) {
            o.send(
              event,
              "setAttributeDescriptor:forKeyword:",
              o.send(
                descriptor,
                "descriptorWithEnumCode:",
                fourCharCode(reason),
              ),
              fourCharCode("why?"),
            );
          }
          sendEvent.symbols.objc_msgSend(
            event,
            o.selector("sendEventWithOptions:timeout:error:"),
            AE_NO_REPLY,
            AE_DEFAULT_TIMEOUT,
            null,
          );
        };
        /**
         * Fixture windows in AppKit's order, which is creation order; other windows are ignored by
         * title. The list includes every window AppKit still holds, visible or not. A replaced
         * window that the host closed and released leaves the list once AppKit deallocates it, which
         * can be a pump turn after the release; `windowCount` lets a scenario wait for that.
         */
        const fixtureWindows = (): {
          window: ObjcObject;
          title: string;
        }[] => {
          const all = o.send(app, "windows");
          const count = Number(o.integer(all as ObjcObject, "count"));
          const found: {
            window: ObjcObject;
            title: string;
          }[] = [];
          for (let index = 0; index < count; index++) {
            const window = o.send(all, "objectAtIndex:", index) as ObjcObject;
            const title = o.text(o.send(window, "title"));
            if (WINDOW_TITLES.includes(title)) {
              found.push({
                window,
                title,
              });
            }
          }
          return found;
        };
        /** The fixture windows that are on screen, which excludes replaced and closed ones. */
        const visibleFixtureWindows = () =>
          fixtureWindows().filter(
            ({ window }) =>
              (Number(o.integer(window, "isVisible")) & BOOL_MASK) !== 0,
          );
        const visibleWindows = () => visibleFixtureWindows().length;
        /** All windows of `title` in `[NSApp windows]`, whatever their visibility. */
        const windowsTitled = (title: string | undefined) =>
          fixtureWindows().filter((candidate) => candidate.title === title)
            .length;
        /**
         * Proves the main thread keeps running timers after a termination request: a thread blocked
         * inside a nested run loop (the NSTerminateLater path) would never reach this turn, because
         * the host suspends a session-end quit Apple event instead of waiting inside the handler.
         */
        const recordMainTickAfterTermination = () => {
          setTimeout(() => {
            appendFileSync(eventsPath, "main-tick-after-terminate\n");
          }, MAIN_TICK_DELAY_MS);
        };
        const perform = (action: string, title: string | undefined) => {
          if (action === "terminate") {
            // The Quit menu item and `[NSApp terminate:]` share this path.
            o.send(app, "terminate:", null);
            recordMainTickAfterTermination();
          } else if (action === "quitEvent") {
            // The Dock's Quit item; `title` carries the optional quit reason.
            sendSelfEvent("aevt", "quit", title);
            recordMainTickAfterTermination();
          } else if (action === "close") {
            // Only a visible window is one the user could close. Right after `windows.recreate`
            // the replaced window can still be listed ahead of its successor until AppKit
            // deallocates it, and `performClose:` on it does nothing because it has no delegate
            // and is already closed. Deallocation is asserted separately through `windowCount`.
            const matches = fixtureWindows().filter(
              (candidate) => candidate.title === title,
            );
            const visible = visibleFixtureWindows().filter(
              (candidate) => candidate.title === title,
            );
            const [target] = visible;
            if (!target || visible.length !== 1) {
              throw new Error(
                `Expected one visible fixture window titled ${title}, found ${visible.length} visible of ${matches.length}.`,
              );
            }
            // performClose: runs windowShouldClose: like the close button does.
            o.send(target.window, "performClose:", null);
          } else if (action === "reopen") {
            // What the Dock click sends; AppKit then asks the delegate to handle the reopen.
            sendSelfEvent("aevt", "rapp");
          } else if (action === "powerOff") {
            const workspace = o.send(o.class("NSWorkspace"), "sharedWorkspace");
            o.send(
              o.send(workspace, "notificationCenter"),
              "postNotificationName:object:",
              o.string(POWER_OFF_NOTIFICATION),
              null,
            );
          }
        };
        return {
          execute(_operation, value) {
            const { action, title } = request.parse(value);
            if (action !== "visibleWindows" && action !== "windowCount") {
              // A stimulus starts outside this operation's call stack, so the operation returns
              // before AppKit re-enters the host. A failure has no caller left and goes to the log,
              // where the test treats it like a failed script.
              setTimeout(() => {
                try {
                  // Shows how far the script got when a stimulus has no visible effect.
                  appendFileSync(
                    eventsPath,
                    `driven:${title ? `${action}:${title}` : action}\n`,
                  );
                  o.withAutoreleasePool(() => perform(action, title));
                } catch (error) {
                  appendFileSync(
                    eventsPath,
                    `script-failed:driver:${String(error).replaceAll("\n", " ")}\n`,
                  );
                }
              }, 0);
            }
            return o.withAutoreleasePool(() =>
              action === "windowCount"
                ? windowsTitled(title)
                : visibleWindows(),
            );
          },
          dispose() {},
        };
      },
    },
  },
});
