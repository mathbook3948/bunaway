import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

// WebKit can finish pageshow while the module is awaiting its SDK handshake.
const pageShown =
  document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) =>
        addEventListener("pageshow", resolve, {
          once: true,
        }),
      );
const client = createClient();
const check = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};
async function denied(work, code) {
  try {
    await work();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    check(error.code === code, `${code}: ${error.message}`);
  }
}
try {
  await client.ready;
  const state = await windows.getWebViewState();
  const expected = location.href.replace(/^bunaway:/, "https:");
  check(
    state.url === expected && state.title === document.title,
    "live document state",
  );
  await denied(() => windows.reloadWebView(), "PERMISSION_DENIED");
  // The original client must still work after fragment navigation, without a new handshake.
  addEventListener("hashchange", () => {
    void client
      .invoke("test.fragment", null)
      .catch((error) => client.invoke("test.failure", String(error)));
  });
  await client.invoke("test.arrived", location.pathname);
  void client.invoke("test.hold", location.pathname).catch(() => {});
  if (
    document.querySelector('meta[name="closed-client-probe"]')?.content ===
    "true"
  ) {
    // This acknowledgment follows the held command before pagehide closes the shared client.
    await windows.getWebViewState();
    await pageShown;
    dispatchEvent(
      new PageTransitionEvent("pagehide", {
        persisted: true,
      }),
    );
    dispatchEvent(
      new PageTransitionEvent("pageshow", {
        persisted: true,
      }),
    );
  }
} catch (error) {
  void client.invoke("test.failure", String(error));
}
