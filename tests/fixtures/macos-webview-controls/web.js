import { createClient } from "@bunaway/client";
import { windows } from "@bunaway/plugin-windows";

const client = createClient();
const view =
  location.pathname === "/peer.html"
    ? "peer"
    : location.pathname === "/denied.html"
      ? "denied"
      : "main";
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
  if (view === "denied") {
    for (const target of [
      "main",
      "denied",
      "unknown",
    ]) {
      await denied(
        () =>
          windows.reloadWebView({
            view: target,
          }),
        "PERMISSION_DENIED",
      );
      await denied(
        () =>
          windows.getWebViewState({
            view: target,
          }),
        "PERMISSION_DENIED",
      );
    }
  } else {
    const state = await windows.getWebViewState({
      view,
    });
    const expected = location.href.replace(/^bunaway:/, "https:");
    check(
      state.url === expected && state.title === document.title,
      "live document state",
    );
    await denied(
      () =>
        windows.reloadWebView({
          view,
        }),
      "PERMISSION_DENIED",
    );
  }
  // The original client must still work after fragment navigation, without a new handshake.
  addEventListener("hashchange", () => {
    void client
      .invoke("test.fragment", null)
      .catch((error) => client.invoke("test.failure", String(error)));
  });
  await client.invoke("test.arrived", location.pathname);
  if (view === "main") {
    void client.invoke("test.hold", location.pathname).catch(() => {});
    if (
      document.querySelector('meta[name="closed-client-probe"]')?.content ===
      "true"
    ) {
      // This acknowledgment follows the held command before pagehide closes the shared client.
      await windows.getWebViewState({
        view,
      });
      addEventListener(
        "pageshow",
        () => {
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
        },
        {
          once: true,
        },
      );
    }
  }
} catch (error) {
  void client.invoke("test.failure", String(error));
}
