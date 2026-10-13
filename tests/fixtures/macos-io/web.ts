import { createClient } from "@bunaway/client";

const client = createClient();
function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
async function rejected(work: Promise<unknown>, code: string) {
  try {
    await work;
  } catch (error) {
    check(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}: ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}`);
}
try {
  const phase = await client.invoke("test.phase", null);
  if (phase === 1) {
    const result = await client.invoke("plugin.probe.run", {
      id: "page",
      mode: "normal",
    });
    check(
      result &&
        typeof result === "object" &&
        "source" in result &&
        result.source === "view:main" &&
        "main" in result &&
        result.main === false,
      "WebView to I/O source and thread",
    );
    await rejected(
      client.invoke("plugin.probe.run", {
        id: "invalid",
        mode: "wrong",
      }),
      "INVALID_ARGUMENT",
    );
    await rejected(
      client.invoke("plugin.probe.run", {
        id: "failure",
        mode: "fail",
      }),
      "INVALID_ARGUMENT",
    );
    await rejected(
      client.invoke("plugin.probe.unsupported", null),
      "UNSUPPORTED",
    );
    await rejected(
      client.invoke("plugin.probe.denied", null),
      "PERMISSION_DENIED",
    );
    const snapshot = await client.invoke("plugin.probe.snapshot", null);
    check(
      Array.isArray(snapshot) &&
        snapshot.some(
          (item) =>
            item &&
            typeof item === "object" &&
            "name" in item &&
            "support" in item &&
            item.name === "probe.run" &&
            item.support === "supported",
        ) &&
        snapshot.some(
          (item) =>
            item &&
            typeof item === "object" &&
            "name" in item &&
            "support" in item &&
            item.name === "probe.unsupported" &&
            item.support === "unsupported",
        ) &&
        snapshot.some(
          (item) =>
            item &&
            typeof item === "object" &&
            "name" in item &&
            "support" in item &&
            item.name === "windows.list" &&
            item.support === "supported",
        ),
      "Mixed I/O/UI capabilities",
    );

    const blocking = client.invoke("plugin.probe.run", {
      id: "blocking",
      mode: "block",
    });
    await client.invoke("test.marker", "blocking-executing");
    check(
      (await client.invoke("test.responsive", null)) === true,
      "AppKit round trip completes before native I/O",
    );
    // A separate backend command requires WKWebView -> AppKit -> backend -> AppKit delivery.
    // Inspecting the real filesystem through a backend marker avoids a timing-only assertion.
    const duringBlock = await client.invoke("test.phase", null);
    check(
      duringBlock === 2,
      "AppKit channel remains responsive during blocking native I/O",
    );
    await blocking;

    const controller = new AbortController();
    const cancelled = rejected(
      client.invoke(
        "plugin.probe.run",
        {
          id: "cancelled",
          mode: "hold",
        },
        {
          signal: controller.signal,
        },
      ),
      "CANCELLED",
    );
    await client.invoke("test.marker", "cancelled-parsing");
    controller.abort();
    await cancelled;
    await client.invoke("test.release", "cancelled");
    check(
      (await client.invoke("plugin.probe.inspect", "cancelled")) === false,
      "Cancelled parser never executes",
    );

    void client
      .invoke("plugin.probe.run", {
        id: "revoked",
        mode: "hold",
      })
      .catch((error) => {
        if (error.code !== "CANCELLED") {
          throw error;
        }
      });
    await client.invoke("test.marker", "revoked-parsing");
    await client.invoke("plugin.windows.recreate", {
      view: "main",
    });
  } else {
    check(phase === 3, "Fresh WebView preserves backend state");
    await client.invoke("test.release", "revoked");
    check(
      (await client.invoke("plugin.probe.inspect", "revoked")) === false,
      "Revoked document cannot execute I/O",
    );
    check(
      (await client.invoke("plugin.probe.inspect", "setup")) === true,
      "Setup uses working I/O",
    );
    await client.invoke("test.report", {
      ok: true,
      phase,
    });
    await client.invoke("plugin.windows.close", {
      view: "main",
    });
  }
} catch (error) {
  if (
    !(error instanceof Error && "code" in error && error.code === "CANCELLED")
  ) {
    await client.invoke("test.report", {
      ok: false,
      message: String(error),
    });
    await client.invoke("plugin.windows.close", {
      view: "main",
    });
  }
}
