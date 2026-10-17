import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isBunaway } from "@bunaway/client";

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

test("backend and plugin sources never read the environment check", async () => {
  const root = resolve(import.meta.dir, "../..");
  const sources = [
    ...new Bun.Glob("packages/*/src/**/*.ts").scanSync(root),
    ...new Bun.Glob("plugins/*/src/**/*.ts").scanSync(root),
  ]
    // Glob results use the platform separator, so normalize before prefix checks.
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.startsWith("packages/client-sdk/"));
  expect(sources.length).toBeGreaterThan(0);
  for (const file of sources) {
    expect(await Bun.file(resolve(root, file)).text()).not.toContain(
      "isBunaway",
    );
  }
});
