import { createClient } from "@bunaway/client";
import store from "@bunaway/plugin-store";
import windows from "@bunaway/plugin-windows";

const client = createClient();
function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
async function rejected(work: Promise<unknown>, code: string) {
  try {
    await work;
  } catch (error) {
    check(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}: ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}`);
}
try {
  // The view may read, and sees the backend's loaded store: the instance is shared.
  const theme = await store.get({
    name: "settings",
    key: "theme",
  });
  check(theme.found && theme.value === "dark", "View read of a shared store");
  // The view holds no write permission, so the store stays as the backend left it.
  await rejected(
    store.set({
      name: "settings",
      key: "theme",
      value: "forged",
    }),
    "PERMISSION_DENIED",
  );
  // A raw invocation skips the SDK's input parsing; the host still refuses a path-like name.
  await rejected(
    client.invoke("plugin.store.get", {
      name: "../settings",
      key: "theme",
    }),
    "INVALID_ARGUMENT",
  );
  const after = await store.get({
    name: "settings",
    key: "theme",
  });
  check(
    after.found && after.value === "dark",
    "Denied write changed the store",
  );
  await client.invoke("test.report", "passed");
  await windows.close();
} catch (error) {
  if (
    !(error instanceof Error && "code" in error && error.code === "CANCELLED")
  ) {
    console.error("Store native host fixture failed", error);
    await client.invoke("test.report", "failed");
    await windows.close();
  }
}
