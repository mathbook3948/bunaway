import { createClient } from "@bunaway/client";

// A real subframe attempts an otherwise allowed command. Its native frame identity must win.
const client = createClient();
void client.invoke("test.spoof", null).catch(() => {});
