import { expect, test } from "bun:test";
import {
  DesktopRequests,
  type MacosQuitRequestReason,
} from "#native/macos/bun/desktop-requests";

function requests(stopping = () => false) {
  const sent: MacosQuitRequestReason[] = [];
  return {
    sent,
    desktop: new DesktopRequests({
      stopping,
      sendQuitRequest: (reason) => sent.push(reason),
    }),
  };
}

test("requests that arrive before the backend's options wait for them and collapse per key", async () => {
  const { desktop } = requests();
  const runs: string[] = [];
  expect(desktop.closeBehavior).toBeUndefined();
  desktop.defer("quit-command", () => runs.push("quit"));
  desktop.defer("quit-command", () => runs.push("quit again"));
  desktop.defer("reopen", () => runs.push("reopen"));
  expect(runs).toEqual([]);
  desktop.configure({
    closeBehavior: "keep-alive",
  });
  await desktop.configured();
  expect(runs).toEqual([
    "quit",
    "reopen",
  ]);
  expect(desktop.closeBehavior).toBe("keep-alive");
  // Once the options are known requests run at once, and the first options stay.
  desktop.defer("quit-command", () => runs.push("late"));
  desktop.configure({
    closeBehavior: "quit",
  });
  expect(runs.at(-1)).toBe("late");
  expect(desktop.closeBehavior).toBe("keep-alive");
});

test("a deferred request is dropped when shutdown began before the options arrived", async () => {
  let stopping = false;
  const { desktop } = requests(() => stopping);
  const runs: string[] = [];
  desktop.defer("reopen", () => runs.push("reopen"));
  stopping = true;
  desktop.abandon();
  expect(await desktop.configured()).toBeUndefined();
  expect(runs).toEqual([]);
});

test("one quit request is pending at a time and a veto allows the next", async () => {
  const { desktop, sent } = requests();
  desktop.configure({
    closeBehavior: "quit",
  });
  const first = desktop.requestQuit("last-window");
  // A Quit command while the last-window request waits joins it instead of sending another.
  const joined = desktop.requestQuit("quit-command");
  expect(sent).toEqual([
    "last-window",
  ]);
  expect(desktop.quitPending).toBe(true);
  desktop.quitCancelled();
  await Promise.all([
    first,
    joined,
  ]);
  expect(desktop.quitPending).toBe(false);
  void desktop.requestQuit("quit-command");
  expect(sent).toEqual([
    "last-window",
    "quit-command",
  ]);
});

test("shutdown settles a pending quit request and later requests send nothing", async () => {
  let stopping = false;
  const { desktop, sent } = requests(() => stopping);
  desktop.configure({
    closeBehavior: "quit",
  });
  const pending = desktop.requestQuit("last-window");
  stopping = true;
  desktop.abandon();
  await pending;
  expect(desktop.quitPending).toBe(false);
  await desktop.requestQuit("quit-command");
  expect(sent).toEqual([
    "last-window",
  ]);
  // Repeating the shutdown notice is harmless.
  desktop.abandon();
});
