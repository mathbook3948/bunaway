import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
const view =
  location.pathname === "/denied.html"
    ? "denied"
    : location.pathname === "/peer.html"
      ? "peer"
      : "main";
if (view === "denied") {
  try {
    await windows.reloadWebView({
      view: "main",
    });
    throw new Error("Denied renderer controlled another WebView");
  } catch (error) {
    if (error.code !== "PERMISSION_DENIED") {
      throw error;
    }
  }
} else {
  const state = await windows.getWebViewState({
    view,
  });
  if (state.url !== location.href || state.title !== document.title) {
    throw new Error("WebView state did not match the real document");
  }
}
await client.invoke("test.arrived", location.pathname);
if (view === "main") {
  // Leave a real command pending so navigation must retire its authenticated session.
  void client.invoke("test.hold", null).catch(() => {});
}
