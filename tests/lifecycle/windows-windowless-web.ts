import { createClient } from "@bunaway/client";

const client = createClient();
await client.invoke("test.ready", null);
