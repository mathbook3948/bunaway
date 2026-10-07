import { createClient } from "../../../packages/client-sdk/src/index.ts";

const client = createClient();
await client.ready;
if (location.pathname === "/editor.html") {
  await client.invoke("test.aux", null);
  await client.invoke("test.hold", null);
} else {
  for (;;) {
    await client.invoke("test.run", null);
  }
}
