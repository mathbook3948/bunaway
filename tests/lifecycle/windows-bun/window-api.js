import { createClient } from "@bunaway/client";

const client = createClient();
await client.ready;
// Leave a call pending in every document so recreation can verify that it is cancelled.
void client.invoke("test.hold", null).catch(() => undefined);
for (;;) {
  await client.invoke("test.run", null);
  if (!location.search) {
    // Navigate within the same native window to verify that its identity is preserved.
    location.replace("/index.html?navigation=1");
    break;
  }
}
