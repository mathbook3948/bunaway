import { createClient } from "@bunaway/client";

const client = createClient();
await client.ready;
// The page is reloaded after the renderer is killed; arming again is a no-op for the backend.
await client.invoke("test.arm", null);
