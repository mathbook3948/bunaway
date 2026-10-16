import { expect, test } from "bun:test";
import {
  classifyQuit,
  fourCharCode,
  KEY_AE_QUIT_REASON,
} from "#native/macos/bun/quit-reason";
import { SessionEndTermination } from "#native/macos/bun/session-end-termination";

test("four-character Apple event codes use the big-endian values AppKit reports", () => {
  expect(KEY_AE_QUIT_REASON).toBe(0x7768793f);
  expect(fourCharCode("rlgo")).toBe(0x726c676f);
  expect(() => fourCharCode("abc")).toThrow("four-character");
  expect(() => fourCharCode("abcde")).toThrow("four-character");
});

test("only logout, restart and shutdown quit reasons end the session", () => {
  for (const code of [
    "rlgo",
    "rest",
    "shut",
  ]) {
    expect(classifyQuit(fourCharCode(code))).toBe("session-end");
  }
  // `logo` (kAELogOut), sleep and unknown reasons are ordinary Quit commands, as is no Apple event at all.
  for (const code of [
    fourCharCode("logo"),
    fourCharCode("slep"),
    0,
    undefined,
  ]) {
    expect(classifyQuit(code)).toBe("quit-command");
  }
});

/** Records the termination replies; a short wait keeps the timer tests fast. */
function termination(waitMs = 30) {
  const calls = {
    commits: 0,
    replies: 0,
  };
  const session = new SessionEndTermination(
    {
      commit: () => calls.commits++,
      reply: () => calls.replies++,
    },
    waitMs,
  );
  return {
    calls,
    session,
  };
}

test("a session end commits shutdown once and holds the termination reply until app cleanup finishes", () => {
  const { calls, session } = termination(10_000);
  expect(session.active).toBe(false);
  session.signal();
  session.signal();
  expect(calls.commits).toBe(1);
  expect(session.active).toBe(true);
  expect(session.terminateRequested()).toBe("later");
  // A repeated request while waiting does not start another wait or reply.
  expect(session.terminateRequested()).toBe("later");
  expect(calls.replies).toBe(0);
  session.appCleanedUp();
  session.appCleanedUp();
  expect(calls.replies).toBe(1);
  expect(session.terminateRequested()).toBe("now");
  session.dispose();
});

test("a termination request that is itself the first session-end signal commits shutdown", () => {
  const { calls, session } = termination(10_000);
  expect(session.terminateRequested()).toBe("later");
  expect(calls.commits).toBe(1);
  session.dispose();
});

test("a termination request after app cleanup is answered immediately without a reply call", () => {
  const { calls, session } = termination(10_000);
  session.signal();
  session.appCleanedUp();
  expect(session.terminateRequested()).toBe("now");
  expect(calls.replies).toBe(0);
});

test("the termination reply is given after the session-end wait even when cleanup never finishes", async () => {
  const { calls, session } = termination(20);
  session.signal();
  expect(session.terminateRequested()).toBe("later");
  await Bun.sleep(80);
  expect(calls.replies).toBe(1);
  // A late cleanup report does not reply a second time.
  session.appCleanedUp();
  expect(calls.replies).toBe(1);
});

test("disposing cancels the wait without replying", async () => {
  const { calls, session } = termination(20);
  session.terminateRequested();
  session.dispose();
  await Bun.sleep(60);
  expect(calls.replies).toBe(0);
});
