import { createClient } from "@bunaway/client";
import { windows } from "@bunaway/plugin-windows";

const view = location.pathname.slice(1, -5);
const client = createClient();
await client.ready;
try {
  await windows.destroy({
    view,
  });
  throw new Error("WebView performed trusted destruction");
} catch (error) {
  if (error.code !== "PERMISSION_DENIED") {
    throw error;
  }
}
await client.invoke("test.arrived", view);
