import { createClient } from "@bunaway/client";

const client = createClient();
await client.ready;
await client.invoke("test.run", null).catch(() => {});
