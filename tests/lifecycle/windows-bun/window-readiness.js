import { createClient } from "@bunaway/client";
import { windows } from "@bunaway/plugin-windows";

const role = location.pathname.slice(1, -5);
const client = createClient();
await client.ready;
if (role === "splash" || role === "observer") {
  await client.listen(
    "windows.readiness",
    (event) => {
      void client.invoke("test.record", {
        recipient: role,
        state: event.payload,
      });
    },
    {
      onError: console.error,
    },
  );
  await client.invoke("test.arrived", role);
} else if (role === "denied") {
  try {
    await client.listen("windows.readiness", () => {}, {
      onError: console.error,
    });
    throw new Error("Denied view subscribed");
  } catch (error) {
    if (error.code !== "PERMISSION_DENIED") {
      throw error;
    }
    await client.invoke("test.arrived", role);
  }
} else {
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
  const state = await windows.getReadiness({
    view: role,
  });
  if (state.sdk !== "ready") {
    throw new Error("SDK acknowledgement was not observed");
  }
  await client.invoke("test.arrived", role);
}
