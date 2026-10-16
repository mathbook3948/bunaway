import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
const role = location.pathname.slice(1, -5);
const token = crypto.randomUUID();
if (role === "denied") {
  try {
    await windows.createInstance({
      view: "shared",
    });
    throw new Error("Denied document created an instance");
  } catch (error) {
    if (error.code !== "PERMISSION_DENIED") {
      throw error;
    }
    await client.invoke("test.denied", null);
  }
} else {
  const identity = await windows.getCurrent();
  if (!identity || identity.viewId !== role) {
    throw new Error("Wrong originating native identity");
  }
  const report = (action, value = "") =>
    client.invoke("test.result", {
      windowId: identity.windowId,
      viewId: role,
      token,
      action,
      value,
    });
  await client.listen(
    "windows.changed",
    (event) => {
      if (event.payload.windowId !== identity.windowId) {
        void report("error", "Foreign window event");
      } else {
        void report("changed", String(event.payload.revision));
      }
    },
    {
      onError: console.error,
    },
  );
  if (role === "main") {
    // Report every snapshot of the arrival-ordered list; the backend uses the longest one because
    // concurrent reports may be handled out of order.
    const lifecycle = [];
    await client.listen(
      "windows.lifecycle",
      (event) => {
        lifecycle.push(`${event.payload.windowId}:${event.payload.phase}`);
        void report("lifecycle", JSON.stringify(lifecycle));
      },
      {
        onError: console.error,
      },
    );
  }
  await client.listen(
    "test.action",
    (event) => {
      const { ids, action, value } = event.payload;
      if (!ids.includes(identity.windowId)) {
        return;
      }
      void (async () => {
        if (action === "set") {
          localStorage.setItem("instance-value", value);
          document.cookie = `instance-value=${value}; SameSite=Lax; path=/`;
        } else if (action === "navigate") {
          location.replace(`/${role}.html?next=${token}`);
          return;
        } else if (action === "hold") {
          void client.invoke("test.hold", identity.windowId).catch(() => {});
          return;
        }
        const echo = await client.invoke("test.echo", token);
        if (echo !== token) {
          throw new Error("Reply arrived in another instance");
        }
        await report(
          action,
          `${localStorage.getItem("instance-value") ?? ""}|${document.cookie}`,
        );
      })().catch((error) => {
        void report("error", String(error));
      });
    },
    {
      onError: console.error,
    },
  );
  // Independent clients start their request counters together; responses must still correlate by context.
  const echoes = await Promise.all(
    Array.from(
      {
        length: 8,
      },
      (_, index) => {
        const value = `${token}:${index}`;
        return client.invoke("test.echo", value).then((result) => {
          if (result !== value) {
            throw new Error("Cross-instance response");
          }
        });
      },
    ),
  );
  if (echoes.length !== 8) {
    throw new Error("Missing responses");
  }
  await report("arrived");
}
