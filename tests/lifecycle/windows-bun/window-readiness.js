import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
await client.listen(
  "test.action",
  (event) => {
    if (event.payload === "navigate") {
      location.replace("/main.html?next=1");
    }
    if (event.payload === "close-sdk") {
      void client.close();
    }
    if (event.payload === "fragment") {
      location.hash = "same-document";
      void client.invoke("test.arrived", "fragment");
    }
  },
  {
    onError: console.error,
  },
);
// Exercise the public client helper as well as backend calls.
const state = await windows.getReadiness();
if (state.sdk !== "ready") {
  throw new Error("SDK acknowledgement was not observed");
}
await client.invoke("test.arrived", "main");
