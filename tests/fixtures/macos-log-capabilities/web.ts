import { createClient } from "@bunaway/client";
import capabilities from "@bunaway/plugin-capabilities";
import log from "@bunaway/plugin-log";
import windows from "@bunaway/plugin-windows";

const client = createClient();

async function rejected(work: () => Promise<unknown>, code: string) {
  try {
    await work();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected ${code}.`);
}

try {
  const pathname = new URL(String(Reflect.get(globalThis, "location")))
    .pathname;
  if (pathname === "/denied.html") {
    await rejected(() => log.info("denied"), "PERMISSION_DENIED");
    await rejected(() => capabilities(), "PERMISSION_DENIED");
    await client.invoke("test.denied", null);
  } else {
    await client.invoke("test.waitDenied", null);
    await rejected(
      () =>
        client.invoke("plugin.log.write", {
          level: "info",
          message: "forged",
          source: "backend",
        }),
      "INVALID_ARGUMENT",
    );
    await Promise.all(
      Array.from(
        {
          length: 32,
        },
        (_, index) =>
          log.info("renderer", {
            index,
          }),
      ),
    );
    if ((await client.invoke("test.writeFailure", null)) !== true) {
      throw new Error("Write error did not reach the public command.");
    }
    await log.info("recovered");
    await log.info("large-0", {
      text: "x".repeat(524288),
    });
    await log.info("large-1", {
      text: "x".repeat(524288),
    });
    await log.info("after-rotation");
    await rejected(() => windows.getContentSize({}), "UNSUPPORTED");
    await client.invoke("test.report", {
      ok: true,
      support: await capabilities(),
    });
    await windows.close();
    await windows.close();
  }
} catch (error) {
  if (
    !(error instanceof Error && "code" in error && error.code === "CANCELLED")
  ) {
    await client.invoke("test.report", {
      ok: false,
      message: String(error),
    });
    await windows.close();
    await windows.close();
  }
}
