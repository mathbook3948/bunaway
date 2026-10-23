import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
const state = await windows.getWebViewState();
if (state.url !== location.href || state.title !== document.title) {
  throw new Error("WebView state did not match the real document");
}
try {
  await windows.reloadWebView();
  throw new Error(
    "Renderer controlled its WebView without the operation grant",
  );
} catch (error) {
  if (error.code !== "PERMISSION_DENIED") {
    throw error;
  }
}
await client.invoke("test.arrived", location.pathname);
// Leave a real command pending so navigation must retire its authenticated session.
void client.invoke("test.hold", null).catch(() => {});
