import { afterEach, expect, test } from "bun:test";
import { isBunaway } from "@bunaway/client";
import type { HostCall, Policy } from "@bunaway/protocol";
import { allowedHost } from "../fixtures/host-plugins.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function setWindow(value: unknown) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value,
  });
}

const bridge = {
  postMessage() {},
  addEventListener() {},
  removeEventListener() {},
};

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("is false during SSR where no window exists", () => {
  Reflect.deleteProperty(globalThis, "window");
  expect(isBunaway()).toBe(false);
});

test("is false in a regular browser without a host bridge", () => {
  setWindow({});
  expect(isBunaway()).toBe(false);
  setWindow({
    chrome: {},
  });
  expect(isBunaway()).toBe(false);
});

test("is false for an incomplete bridge", () => {
  setWindow({
    chrome: {
      webview: {
        postMessage() {},
      },
    },
  });
  expect(isBunaway()).toBe(false);
});

test("is true as soon as the host injects the bridge, before any client exists", () => {
  setWindow({
    chrome: {
      webview: bridge,
    },
  });
  expect(isBunaway()).toBe(true);
});

test("a forged bridge makes the result true but does not change backend permission checks", async () => {
  const denied: Policy["backend"] = {
    permissions: [],
  };
  const call: HostCall = {
    operation: "log.write",
    payload: {
      level: "debug",
      message: "forged",
    },
  };
  Reflect.deleteProperty(globalThis, "window");
  const before = await allowedHost(denied, call);
  setWindow({
    chrome: {
      webview: bridge,
    },
  });
  expect(isBunaway()).toBe(true);
  expect(await allowedHost(denied, call)).toBe(before);
  expect(before).toBe(false);
});

test("backend and plugin sources never read the environment check", async () => {
  const sources = [
    ...new Bun.Glob("packages/*/src/**/*.ts").scanSync(),
    ...new Bun.Glob("plugins/*/src/**/*.ts").scanSync(),
  ].filter((file) => !file.startsWith("packages/client-sdk/"));
  expect(sources.length).toBeGreaterThan(0);
  for (const file of sources) {
    expect(await Bun.file(file).text()).not.toContain("isBunaway");
  }
});
