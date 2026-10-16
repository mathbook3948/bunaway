import { expect, test } from "bun:test";
import {
  classifyQuit,
  fourCharCode,
  KEY_AE_QUIT_REASON,
  quitReasonAccessor,
  routeQuitEvent,
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
    "logo",
    "rlgo",
    "rest",
    "shut",
  ]) {
    expect(classifyQuit(fourCharCode(code))).toBe("session-end");
  }
  // The restart and shutdown dialog requests only ask for confirmation, so they are ordinary Quit
  // commands, like sleep, unknown reasons and no Apple event at all.
  for (const code of [
    fourCharCode("rrst"),
    fourCharCode("rsdn"),
    fourCharCode("slep"),
    0,
    undefined,
  ]) {
    expect(classifyQuit(code)).toBe("quit-command");
  }
});

test("a quit reason is read as a type or an enumeration code and nothing else", () => {
  expect(quitReasonAccessor(fourCharCode("type"))).toBe("typeCodeValue");
  expect(quitReasonAccessor(fourCharCode("enum"))).toBe("enumCodeValue");
  expect(quitReasonAccessor(fourCharCode("utxt"))).toBeUndefined();
  expect(quitReasonAccessor(0)).toBeUndefined();
});

test("the process-lifetime quit handler replies at once when no application is live", () => {
  for (const quitReasonCode of [
    undefined,
    fourCharCode("shut"),
  ]) {
    expect(
      routeQuitEvent({
        applicationLive: false,
        sessionEndActive: true,
        quitReasonCode,
        stopping: false,
      }),
    ).toBe("reply");
  }
});

test("a session-end reason or an active session end routes to session end", () => {
  expect(
    routeQuitEvent({
      applicationLive: true,
      sessionEndActive: false,
      quitReasonCode: fourCharCode("rlgo"),
      stopping: false,
    }),
  ).toBe("session-end");
  // A plain quit event after the power-off notification belongs to the same session end, even while stopping.
  expect(
    routeQuitEvent({
      applicationLive: true,
      sessionEndActive: true,
      quitReasonCode: undefined,
      stopping: true,
    }),
  ).toBe("session-end");
});

test("an ordinary quit asks the app unless the host is already stopping", () => {
  const state = {
    applicationLive: true,
    sessionEndActive: false,
    quitReasonCode: fourCharCode("rrst"),
  };
  expect(
    routeQuitEvent({
      ...state,
      stopping: false,
    }),
  ).toBe("request-quit");
  expect(
    routeQuitEvent({
      ...state,
      stopping: true,
    }),
  ).toBe("reply");
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

test("a session end commits shutdown once and holds the quit event reply until app cleanup finishes", () => {
  const { calls, session } = termination(10_000);
  expect(session.active).toBe(false);
  session.signal();
  session.signal();
  expect(calls.commits).toBe(1);
  expect(session.active).toBe(true);
  expect(session.quitEventReceived()).toBe("later");
  // A repeated quit event while suspended does not start another wait or reply.
  expect(session.quitEventReceived()).toBe("later");
  expect(calls.replies).toBe(0);
  session.appCleanedUp();
  session.appCleanedUp();
  expect(calls.replies).toBe(1);
  expect(session.quitEventReceived()).toBe("now");
  session.dispose();
  expect(calls.replies).toBe(1);
});

test("a quit event that is itself the first session-end signal commits shutdown", () => {
  const { calls, session } = termination(10_000);
  expect(session.quitEventReceived()).toBe("later");
  expect(calls.commits).toBe(1);
  session.dispose();
});

test("a quit event after app cleanup is answered immediately without a reply call", () => {
  const { calls, session } = termination(10_000);
  session.signal();
  session.appCleanedUp();
  expect(session.quitEventReceived()).toBe("now");
  expect(calls.replies).toBe(0);
});

test("the quit event reply is given after the session-end wait even when cleanup never finishes", async () => {
  const { calls, session } = termination(20);
  session.signal();
  expect(session.quitEventReceived()).toBe("later");
  await Bun.sleep(80);
  expect(calls.replies).toBe(1);
  // A late cleanup report does not reply a second time.
  session.appCleanedUp();
  expect(calls.replies).toBe(1);
});

test("disposing sends a still-owed reply once and cancels the wait", async () => {
  const { calls, session } = termination(20);
  session.quitEventReceived();
  session.dispose();
  session.dispose();
  expect(calls.replies).toBe(1);
  await Bun.sleep(60);
  expect(calls.replies).toBe(1);
});

test("disposing without a suspended quit event sends no reply", () => {
  const { calls, session } = termination(10_000);
  session.signal();
  session.dispose();
  expect(calls.replies).toBe(0);
});
