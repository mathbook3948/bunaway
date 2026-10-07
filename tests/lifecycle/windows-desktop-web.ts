import { createClient } from "../../packages/client-sdk/src/index.ts";
import type {
  CommandsOf,
  EventsOf,
} from "../../packages/backend-sdk/src/index.ts";
import type { desktopTestApp } from "./windows-desktop.ts";

const client = createClient<
  CommandsOf<typeof desktopTestApp>,
  EventsOf<typeof desktopTestApp>
>();
await client.ready;
await client.listen(
  "test.reopen",
  async () => {
    // A retained subscription and a successful call must use the same session.
    await client.invoke("test.restored", null);
  },
  {
    onError: (error) => {
      throw new Error(error.message);
    },
  },
);
await client.invoke("test.ready", null);
