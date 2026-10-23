import { createClient } from "@bunaway/client";

const client = createClient();
await client.invoke("plugin.windows.close", {
  view: "main",
});
