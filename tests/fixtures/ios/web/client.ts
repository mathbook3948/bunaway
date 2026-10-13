import type { CommandsOf, EventsOf } from "@bunaway/backend";
import { createClient, invoke } from "@bunaway/client";
import {
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@bunaway/protocol";
import type { app } from "../app.ts";
import {
  BACKEND_BUSY_MS,
  BURST_EVENT_COUNT,
  INPUT_BURST_COUNT,
  INPUT_BURST_PAYLOAD_BYTES,
  WEBVIEW_BUSY_MS,
} from "../limits.ts";

// This private fixture channel records WebKit lifecycle facts without relying on a live SDK.
declare const webkit: {
  messageHandlers: {
    regression: {
      postMessage(value: string): void;
    };
  };
};
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    webkit.messageHandlers.regression.postMessage("cacheRestored");
  }
});

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
/** Bypass SDK validation only for native boundary probes. */
function fixtureBridge() {
  const chrome: unknown = Reflect.get(globalThis, "chrome");
  assert(
    typeof chrome === "object" && chrome !== null && "webview" in chrome,
    "Missing fixture bridge.",
  );
  const bridge = chrome.webview;
  assert(
    typeof bridge === "object" &&
      bridge !== null &&
      "postMessage" in bridge &&
      typeof bridge.postMessage === "function",
    "Missing fixture sender.",
  );
  const postMessage = bridge.postMessage;
  return {
    postMessage(value: unknown) {
      postMessage.call(bridge, value);
    },
  };
}

async function run() {
  await new Promise<void>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.onload = () => {
      if (frame.contentDocument?.body.dataset.attempted !== "yes") {
        reject(new Error("Subframe did not attempt a native hello."));
        return;
      }
      resolve();
    };
    frame.src = "/frame.html";
    document.body.append(frame);
  });
  const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
  await client.ready;
  if (location.search === "?probe=1") {
    // The native fixture revokes this session and tests failed navigation before loading '/'.
    return;
  }
  const slashes = "/".repeat(600000);
  assert(
    (await client.invoke("test.echo", slashes)) === slashes,
    "Slash serialization changed or exceeded the pipe limit.",
  );

  const validInvoke = {
    kind: "invoke",
    protocol: PROTOCOL_VERSION,
    id: "invalid-probe",
    command: "test.echo",
    payload: "ok",
  };
  let deepPayload: unknown = null;
  for (let depth = 0; depth < MAX_JSON_DEPTH + 1; depth++) {
    deepPayload = [
      deepPayload,
    ];
  }
  const invalidMessages = [
    {
      kind: "invoke",
    },
    {
      ...validInvoke,
      protocol: {
        major: true,
        minor: 0,
      },
    },
    {
      ...validInvoke,
      extra: true,
    },
    {
      ...validInvoke,
      id: "trailing-newline\n",
    },
    {
      ...validInvoke,
      id: "x".repeat(129),
    },
    {
      ...validInvoke,
      deadline: 0.5,
    },
    {
      ...validInvoke,
      deadline: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      buildId: "fixture",
      features: [
        "duplicate",
        "duplicate",
      ],
    },
    {
      ...validInvoke,
      payload: deepPayload,
    },
    {
      ...validInvoke,
      payload: "가".repeat(Math.ceil(MAX_MESSAGE_BYTES / 3)),
    },
  ];
  const invalidIndex = Number(
    sessionStorage.getItem("ios-invalid-input") ?? "0",
  );
  if (invalidIndex < invalidMessages.length) {
    const closed = client.invoke("test.hold", null).then(
      () => false,
      (error: unknown) =>
        error instanceof Error && error.message === "Connection closed.",
    );
    await wait(30);
    const bridge = fixtureBridge();
    bridge.postMessage(invalidMessages[invalidIndex]);
    bridge.postMessage(validInvoke);
    assert(
      await closed,
      `Invalid input ${invalidIndex} did not close the document.`,
    );
    sessionStorage.setItem("ios-invalid-input", String(invalidIndex + 1));
    location.reload();
    return;
  }
  webkit.messageHandlers.regression.postMessage("invalidMessagesClosed");
  if (!sessionStorage.getItem("ios-cancel")) {
    sessionStorage.setItem("ios-cancel", "pending");
    location.href = "/cancelled.html";
    return;
  }
  webkit.messageHandlers.regression.postMessage("cancelledNavigationRecovered");
  const replacement = sessionStorage.getItem("ios-replacement");
  if (!replacement) {
    sessionStorage.setItem("ios-replacement", "pending");
    location.href = "/replaced.html";
    return;
  }
  if (replacement === "pending") {
    assert(
      location.search === "?replacement=1",
      "Cancellation recovery replaced a newer navigation.",
    );
    sessionStorage.setItem("ios-replacement", "complete");
  }
  webkit.messageHandlers.regression.postMessage(
    "replacementNavigationPreserved",
  );

  // Hash assignment and links must keep this exact client alive.
  location.hash = "assigned";
  await wait(50);
  assert(
    (await client.invoke("test.echo", "hash")) === "hash",
    "Hash navigation closed the SDK.",
  );
  const link = document.createElement("a");
  link.href = "#linked";
  document.body.append(link);
  link.click();
  await wait(50);
  assert(
    (await client.invoke("test.echo", "link")) === "link",
    "Hash link closed the SDK.",
  );

  // Going back restores this page from cache; the production bridge must reload it itself.
  if (!sessionStorage.getItem("ios-history")) {
    sessionStorage.setItem("ios-history", "pending");
    location.href = "/history.html";
    return;
  }
  sessionStorage.setItem("ios-history", "complete");

  if (!sessionStorage.getItem("ios-input-burst")) {
    sessionStorage.setItem("ios-input-burst", "pending");
    const blocked = client.invoke("test.block", null).then(
      () => false,
      (error: unknown) =>
        error instanceof Error && error.message === "Connection closed.",
    );
    await wait(100);
    const bridge = fixtureBridge();
    // Bypass the SDK's own pending-request limit to exercise the native trust boundary.
    const floodPayload = "x".repeat(INPUT_BURST_PAYLOAD_BYTES);
    for (let index = 0; index < INPUT_BURST_COUNT; index++) {
      try {
        bridge.postMessage({
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: `flood-${index}`,
          command: "test.echo",
          payload: floodPayload,
        });
      } catch {
        // The shared WebSocket bridge can reject the burst before the server's queue fills.
        break;
      }
    }
    assert(await blocked, "Input overflow did not close only the document.");
    webkit.messageHandlers.regression.postMessage("inputQueueClosed");
    await wait(BACKEND_BUSY_MS + 500);
    sessionStorage.setItem("ios-input-burst", "complete");
    location.reload();
    return;
  }
  const echo = "가😀".repeat(32768);
  assert(
    (await client.invoke("test.echo", echo)) === echo,
    "Large UTF-8 echo changed.",
  );
  assert(
    (await client.invoke("test.files", null)) === "iOS backend 한글 😀\n",
    "Packaged file import changed.",
  );
  let changed = 0;
  const release = await client.listen(
    "test.changed",
    ({ payload }) => {
      changed = payload;
    },
    {
      onError(error) {
        throw new Error(error.message);
      },
    },
  );
  assert(
    (await client.invoke("test.count", null)) === 1,
    "Worker state did not reset.",
  );
  assert(changed === 1, "Event was not delivered.");
  await release();
  let received = 0;
  let completeBurst = () => {};
  const burstReceived = new Promise<void>((resolve) => {
    completeBurst = resolve;
  });
  const releaseBurst = await client.listen(
    "test.changed",
    ({ payload }) => {
      assert(payload === received, "Burst events changed order.");
      received++;
      if (received === BURST_EVENT_COUNT) {
        completeBurst();
      }
    },
    {
      onError(error) {
        throw new Error(error.message);
      },
    },
  );
  const burst = client.invoke("test.burst", null);
  await wait(20);
  const until = performance.now() + WEBVIEW_BUSY_MS;
  while (performance.now() < until) {
    /* Keep WebKit busy while the native pipe reader runs. */
  }
  await Promise.all([
    burst,
    burstReceived,
  ]);
  await releaseBurst();
  try {
    await client.invoke("test.error", null);
    throw new Error("Declared error succeeded.");
  } catch (error) {
    assert(
      error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_ARGUMENT",
      "Declared error changed.",
    );
  }
  try {
    await invoke("test.denied", null);
    throw new Error("Forbidden command succeeded.");
  } catch (error) {
    assert(
      error instanceof Error &&
        "code" in error &&
        error.code === "PERMISSION_DENIED",
      "Policy did not deny command.",
    );
  }
  const abort = new AbortController();
  const pending = client.invoke("test.hold", null, {
    signal: abort.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  abort.abort();
  try {
    await pending;
    throw new Error("Cancelled command succeeded.");
  } catch (error) {
    assert(
      error instanceof Error && "code" in error && error.code === "CANCELLED",
      "Cancellation did not reach the native session.",
    );
  }
  await client.invoke(
    "test.record",
    JSON.stringify({
      ok: true,
      echoBytes: new TextEncoder().encode(echo).length,
      count: changed,
      hashNavigation: true,
      eventBurst: received,
    }),
  );
  const result = document.querySelector("#result");
  if (result) {
    result.textContent = "PASS: SDK, Core, 정책, 이벤트, UTF-8, 파일 import";
  }
}
void run().catch((error) => {
  const result = document.querySelector("#result");
  if (result) {
    result.textContent = String(error);
  }
  console.error(error);
});
