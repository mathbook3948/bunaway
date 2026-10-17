import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import type { HostContext } from "@bunaway/protocol";
import { Channel } from "@bunaway/runtime-bun/worker-channel";
import { NativeRequests } from "#native/host-api/bun/native-requests";
import { Windows } from "#native/windows/bun/win32";
import { menuItemsSchema } from "#plugins/menu/src/contract";
import { WindowMenus } from "#plugins/menu/src/platforms/windows-window-menus";

assert(parentPort);
const runtime = {
  id: "context-popup",
  generation: String(workerData.generation),
};
const context = "popup-owner" as HostContext;
const requests = new NativeRequests();
const signal = requests.begin("popup", context);
let failure: unknown;
const channel = new Channel(
  parentPort,
  runtime,
  "ui",
  (packet) => {
    if (packet.kind === "cancel") {
      requests.cancel(packet.requestId);
    } else if (packet.kind === "cancel-context") {
      requests.cancelContext(packet.context);
    } else if (packet.kind === "session-failure") {
      requests.cancelContext(packet.route.context);
    } else if (packet.kind === "shutdown") {
      requests.cancelAll();
    }
  },
  (error) => {
    failure = error;
  },
  (packet) => requests.interruptModal(packet),
);
const windows = new Windows(
  () => {},
  undefined,
  undefined,
  () => channel.poll(),
);
// WM_ENTERMENULOOP is always sent when the native loop starts, while
// WM_INITMENUPOPUP may be skipped once EndMenu was requested.
const enterMessage = workerData.bar || workerData.early ? 0x0211 : 0x0117;
const listeners = new Set<
  (message: number, wparam: bigint, lparam: bigint) => void
>();
const hwnd = windows.create(
  "Cancellable popup integration",
  400,
  300,
  (message, wparam, lparam) => {
    for (const receive of [
      ...listeners,
    ]) {
      receive(message, wparam, lparam);
    }
    if (message === enterMessage) {
      channel.notify({
        kind: "diagnostic",
        event: "popup-enter",
        fields: {},
      });
    }
  },
  true,
);
const menus = new WindowMenus({
  resolve: () => hwnd,
  subscribe(_id, receive) {
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  },
  interrupt: (requestSignal, cancel) =>
    requests.onModalInterrupt(requestSignal, cancel),
  changed() {},
  executeRole() {},
});
/** Lets the parent queue shutdown so the native loop observes it as soon as it starts. */
function waitForEarlyShutdown() {
  const ready = new Int32Array(workerData.ready);
  channel.notify({
    kind: "diagnostic",
    event: "early-ready",
    fields: {},
  });
  Atomics.wait(ready, 0, 0, 3000);
  assert.equal(
    Atomics.load(ready, 0),
    1,
    "Parent did not queue early shutdown.",
  );
}
try {
  await channel.send({
    kind: "ready",
  });
  const items = menuItemsSchema.parse([
    {
      id: "a",
      type: "item",
      label: "Select or cancel",
    },
  ]);
  let code: string | undefined;
  if (workerData.bar) {
    const user = dlopen("user32.dll", {
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    });
    try {
      menus.set(
        "one",
        menuItemsSchema.parse([
          {
            id: "file",
            type: "submenu",
            label: "File",
            items,
          },
        ]),
        () => {},
        () => {},
      );
      if (workerData.early) {
        waitForEarlyShutdown();
      }
      // SC_KEYMENU enters the real native menu-bar loop, without sending global keyboard input.
      user.symbols.SendMessageW(hwnd, 0x0112, 0xf100n, 0n);
      code = "CANCELLED";
    } finally {
      user.close();
    }
  } else {
    if (workerData.early) {
      waitForEarlyShutdown();
    }
    try {
      menus.popup("one", items, 100, 100, new AbortController().signal, signal);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        code = String(error.code);
      } else {
        throw error;
      }
    }
    assert.equal(code, "CANCELLED");
  }
  // Deferred request cancellation and its acknowledgements now run outside the native stack.
  await Bun.sleep(0);
  assert.equal(signal.aborted, true);
  assert.equal(failure, undefined);
  menus.dispose();
  windows.destroy(hwnd);
  windows.dispose();
  await channel.send({
    kind: "diagnostic",
    event: "popup-released",
    fields: {
      code,
    },
  });
} finally {
  channel.close();
  parentPort.close();
}
