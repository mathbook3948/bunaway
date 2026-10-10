import { createClient } from "@bunaway/client";

const client = createClient();
await client.ready;
if (location.pathname === "/editor.html") {
  // Leave an editor call pending so recreation and renderer failure can verify cancellation.
  await client.invoke("test.aux", null);
  await client.invoke("test.hold", null);
} else {
  // Keep the main document active while the parent recreates and crashes the editor view.
  for (;;) {
    await client.invoke("test.run", null);
    if (!location.search) {
      location.replace("/index.html?navigation=1");
      break;
    }
  }
}
