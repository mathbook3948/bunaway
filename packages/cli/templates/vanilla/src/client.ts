import type { CommandsOf, EventsOf } from "@bunaway/backend";
import { type Client, invoke, listen } from "@bunaway/client";
import type { app } from "../src-bunaway/app.ts";

type AppClient = Client<CommandsOf<typeof app>, EventsOf<typeof app>>;

export const client: Pick<AppClient, "invoke" | "listen"> = {
  invoke,
  listen,
};
