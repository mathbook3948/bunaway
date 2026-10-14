import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
for (const call of [
  () =>
    windows.setDownloadRequestsEnabled({
      view: "main",
      enabled: true,
    }),
  () =>
    windows.getDownloads({
      view: "main",
    }),
]) {
  try {
    await call();
    throw new Error("Renderer obtained backend-only download authority");
  } catch (error) {
    if (error.code !== "PERMISSION_DENIED") {
      throw error;
    }
  }
}
const identity = await client.invoke("test.arrived", null);

// Attachment navigation can retire the SDK session without replacing the document.
// The loopback-only fixture driver therefore controls later links independently of that session.
for (;;) {
  const action = await (
    await fetch(`/driver?windowId=${encodeURIComponent(identity.windowId)}`, {
      cache: "no-store",
    })
  ).json();
  if (action) {
    if (action.kind === "ping") {
      await client.invoke("test.heartbeat", null);
    } else if (action.kind === "navigate") {
      location.href = action.url;
    } else {
      const link = document.createElement("a");
      link.href = action.url;
      document.body.append(link);
      link.click();
      link.remove();
    }
  }
  await new Promise((done) => setTimeout(done, 20));
}
