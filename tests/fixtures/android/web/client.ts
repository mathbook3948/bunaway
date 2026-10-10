import { createClient, invoke } from "@bunaway/client";
import type { CommandsOf, EventsOf } from "@bunaway/backend";
import type { app } from "../app.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

document.getElementById("fail-renderer")?.addEventListener("click", () => {
  const native: unknown = Reflect.get(globalThis, "bunawayNative");
  assert(
    typeof native === "object" &&
      native !== null &&
      "postMessage" in native &&
      typeof native.postMessage === "function",
    "Missing native fixture bridge",
  );
  native.postMessage('{"kind":"shutdown"}');
});

async function run() {
  const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
  await client.ready;
  assert(
    (await client.invoke("test.files", null)) === "Android backend 한글 😀\n",
    "Packaged backend file import was not extracted with the bundle",
  );
  // The response spans many pipe reads, including split UTF-8 encodings of Korean and emoji.
  const largeEcho = "가😀".repeat(32_768);
  assert(
    (await client.invoke("test.echo", largeEcho)) === largeEcho,
    "Large UTF-8 command response changed across pipe chunks",
  );
  const environment = await client.invoke("test.environment", null);
  assert(
    environment.writable &&
      environment.temporary.endsWith("/cache") &&
      environment.home.endsWith("/files"),
    "Bun temporary/home directories are not app-owned and writable",
  );
  await new Promise<void>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.onload = () => {
      try {
        assert(
          frame.contentDocument?.body.dataset.attempted === "yes",
          "Subframe did not attempt the native message",
        );
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    frame.src = "/frame.html";
    document.body.appendChild(frame);
  });
  const before = await client.invoke("test.info", null);
  const values: number[] = [];
  const release = await client.listen(
    "test.changed",
    ({ payload }) => values.push(payload),
    {
      onError(error) {
        throw new Error(error.message);
      },
    },
  );
  const count = await client.invoke("test.increment", 1);
  assert(
    count === before.count + 1 && values[0] === count,
    "Command or event failed",
  );
  await release();
  await client.invoke("test.increment", 1);
  assert(values.length === 1, "Event delivered after unsubscribe");
  for (const [name, expected] of [
    [
      "test.denied",
      "PERMISSION_DENIED",
    ],
    [
      "test.error",
      "INTERNAL",
    ],
  ] as const) {
    try {
      await invoke(name, null);
      throw new Error("Expected command rejection");
    } catch (error) {
      assert(
        typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === expected,
        `Wrong ${name} error`,
      );
    }
  }
  const controller = new AbortController();
  const hold = client.invoke("test.hold", null, {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  try {
    await hold;
    throw new Error("Expected cancellation");
  } catch (error) {
    assert(
      typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "CANCELLED",
      "Cancellation failed",
    );
  }
  const after = await client.invoke("test.info", null);
  assert(
    after.cancelled === before.cancelled + 1,
    "Backend cancellation did not arrive",
  );
  const blocked = await fetch("/%2e%2e/host.json");
  assert(!blocked.ok, "Framework assets exposed");
  const privateAsset = await fetch("/backend.js");
  assert(!privateAsset.ok, "Backend bundle exposed to WebView");
  assert((await fetch("/")).ok, "Root did not serve the packaged index");
  let externalBlocked = false;
  try {
    await fetch("https://example.com/");
  } catch {
    externalBlocked = true;
  }
  assert(externalBlocked, "External network request was allowed");
  return {
    passed: true,
    before,
    after,
    events: values.length,
    checks:
      "commands, large UTF-8 response, events, unsubscribe, permission, errors, cancellation, assets, subframe",
  };
}

void run()
  .then((report) => {
    const text = JSON.stringify(report);
    const element = document.getElementById("result");
    if (element) {
      element.textContent = text;
    }
    console.log(`ANDROID_TEST:${text}`);
  })
  .catch((error) =>
    console.error(
      `ANDROID_TEST:${JSON.stringify({
        passed: false,
        error: String(error),
      })}`,
    ),
  );
