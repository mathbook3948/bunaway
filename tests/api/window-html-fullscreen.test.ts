import { expect, test } from "bun:test";
import { windowEvents } from "@bunaway/plugin-windows";
import { validateValue } from "@bunaway/protocol";
import { createLatestCoalescer } from "#native/windows/bun/event-coalescer";
import { createHtmlFullscreenLink } from "#native/windows/bun/html-fullscreen";

const identity = {
  windowId: "window-1",
  viewId: "main",
};

/** A window that records the fullscreen changes the link makes. */
function fakeWindow(options: {
  fullscreen?: boolean;
  fullscreenable?: boolean;
}) {
  const calls: boolean[] = [];
  // Each fullscreen stay is a new object, as in the native window class.
  let session: object | undefined = options.fullscreen ? {} : undefined;
  return {
    calls,
    leaveByApp: () => {
      session = undefined;
    },
    window: {
      isFullscreen: () => session !== undefined,
      isFullscreenable: () => options.fullscreenable ?? true,
      fullscreenSession: () => session,
      setFullscreen: (enabled: boolean) => {
        calls.push(enabled);
        session = enabled ? {} : undefined;
      },
    },
  };
}

test("the event schema takes a boolean state and rejects other shapes", () => {
  const schema = windowEvents["windows.htmlFullscreenChanged"];
  for (const fullscreen of [
    true,
    false,
  ]) {
    expect(
      validateValue(schema, {
        ...identity,
        fullscreen,
      }),
    ).toEqual({
      ...identity,
      fullscreen,
    });
  }
  expect(() => validateValue(schema, identity)).toThrow();
  expect(() =>
    validateValue(schema, {
      ...identity,
      fullscreen: "yes",
    }),
  ).toThrow();
  expect(() =>
    validateValue(schema, {
      ...identity,
      fullscreen: true,
      extra: 1,
    }),
  ).toThrow();
});

test("the window enters fullscreen with the page element and leaves with it", () => {
  const { calls, window } = fakeWindow({});
  const link = createHtmlFullscreenLink(window);
  link(true);
  expect(calls).toEqual([
    true,
  ]);
  link(false);
  expect(calls).toEqual([
    true,
    false,
  ]);
});

test("a window that was already fullscreen stays fullscreen when the element ends", () => {
  const { calls, window } = fakeWindow({
    fullscreen: true,
  });
  const link = createHtmlFullscreenLink(window);
  link(true);
  link(false);
  expect(calls).toEqual([]);
  expect(window.isFullscreen()).toBe(true);
});

test("a window that is not fullscreenable is left alone", () => {
  const { calls, window } = fakeWindow({
    fullscreenable: false,
  });
  const link = createHtmlFullscreenLink(window);
  link(true);
  link(false);
  expect(calls).toEqual([]);
});

test("a window the app already took out of fullscreen is not changed again", () => {
  const { calls, leaveByApp, window } = fakeWindow({});
  const link = createHtmlFullscreenLink(window);
  link(true);
  leaveByApp();
  link(false);
  expect(calls).toEqual([
    true,
  ]);
});

test("an element end does not leave a fullscreen the app entered afterwards", () => {
  const { calls, window } = fakeWindow({});
  const link = createHtmlFullscreenLink(window);
  link(true);
  link(false);
  window.setFullscreen(true);
  link(false);
  expect(calls).toEqual([
    true,
    false,
    true,
  ]);
});

test("a fullscreen the app made again after leaving is not undone by the element end", () => {
  const { calls, leaveByApp, window } = fakeWindow({});
  const link = createHtmlFullscreenLink(window);
  link(true);
  leaveByApp();
  window.setFullscreen(true);
  link(false);
  expect(calls).toEqual([
    true,
    true,
  ]);
  expect(window.isFullscreen()).toBe(true);
});

test("values that arrive while a send is pending collapse to the latest one", () => {
  const sent: boolean[] = [];
  const settles: (() => void)[] = [];
  const publish = createLatestCoalescer<boolean>((value, settled) => {
    sent.push(value);
    settles.push(settled);
  });
  publish(true);
  publish(false);
  publish(true);
  publish(false);
  expect(sent).toEqual([
    true,
  ]);
  settles[0]?.();
  expect(sent).toEqual([
    true,
    false,
  ]);
  settles[1]?.();
  expect(sent).toEqual([
    true,
    false,
  ]);
  publish(true);
  expect(sent).toEqual([
    true,
    false,
    true,
  ]);
});
