import { createClient } from "@bunaway/client";

const client = createClient();
await client.ready;
// The page loads again after the renderer is killed; the backend counts each load.
await client.invoke("test.loaded", null);
