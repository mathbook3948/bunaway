import { createClient } from "@bunaway/client";

declare const location: {
  pathname: string;
  search: string;
};

import { appearance } from "@bunaway/plugin-appearance";
import { windows } from "@bunaway/plugin-windows";

const client = createClient();
const view = location.pathname.includes("denied") ? "denied" : "main";
function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
async function denied(work: () => Promise<unknown>, code: string) {
  try {
    await work();
  } catch (error) {
    check(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}`,
    );
    return;
  }
  throw new Error(`Missing ${code}`);
}
function snapshot(value: unknown) {
  check(
    value &&
      typeof value === "object" &&
      "colors" in value &&
      "accentColor" in value &&
      "appsTheme" in value &&
      "systemTheme" in value &&
      "forcedColors" in value,
    "Snapshot fields",
  );
  check(
    value.appsTheme === "light" || value.appsTheme === "dark",
    "Effective theme",
  );
  check(
    value.systemTheme === null && value.forcedColors === false,
    "Platform semantics",
  );
  check(value.colors && typeof value.colors === "object", "Colors object");
  for (const color of [
    value.accentColor,
    ...Object.values(value.colors),
  ]) {
    check(
      typeof color === "string" && /^#[0-9a-f]{6}$/.test(color),
      "sRGB bounds",
    );
  }
  for (const key of [
    "highContrast",
    "reducedMotion",
    "transparencyEnabled",
    "screenReaderEnabled",
  ]) {
    check(typeof Reflect.get(value, key) === "boolean", key);
  }
}
try {
  if (view === "denied") {
    await denied(() => appearance.getPreferences(), "PERMISSION_DENIED");
    await denied(
      () => client.invoke("test.inherited", null),
      "PERMISSION_DENIED",
    );
  } else {
    for (let index = 0; index < 100; index++) {
      snapshot(await appearance.getPreferences());
    }
    await denied(
      () => client.invoke("plugin.appearance.getPreferences", {}),
      "INVALID_ARGUMENT",
    );
    snapshot(await client.invoke("test.inherited", null));
    const backend = await client.invoke("test.backend", null);
    if (new URLSearchParams(location.search).has("backend-denied")) {
      check(
        backend &&
          typeof backend === "object" &&
          "code" in backend &&
          backend.code === "PERMISSION_DENIED",
        "Backend permission denial",
      );
    } else {
      snapshot(backend);
    }
  }
  await client.invoke("test.report", {
    view,
    ok: true,
  });
  await windows.close({
    view,
  });
} catch (error) {
  if (
    !(error instanceof Error && "code" in error && error.code === "CANCELLED")
  ) {
    await client.invoke("test.report", {
      view,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    await windows.close({
      view,
    });
  }
}
