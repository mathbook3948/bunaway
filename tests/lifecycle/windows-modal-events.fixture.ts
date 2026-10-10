import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { parentPort, Worker, workerData } from "node:worker_threads";
import {
  API_LIMITS,
  type HostContext,
  PROTOCOL_VERSION,
} from "@bunaway/protocol";
import { Channel, type Route } from "@bunaway/runtime-bun/worker-channel";

const runtime = {
  id: "modal-events",
  generation: "1",
};
const route: Route = {
  viewId: "main",
  context: "ctx-modal" as HostContext,
  documentGeneration: 0,
};
const MOVE_COUNT = API_LIMITS.maxPending * 3;
const MOVE_INTERVAL_MS = 5;
const WM_SYSCOMMAND = 0x0112;
const SC_MOVE = 0xf010n;
const WM_CANCELMODE = 0x001f;
const SWP_NOSIZE = 0x1;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;

/** Keep both directions live while the real STA is inside DispatchMessage's native move loop. */
if (workerData) {
  assert(parentPort);
  const { Windows, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE } = await import(
    "#native/windows/bun/win32"
  );
  let stopping = false;
  let failure: unknown;
  let emitted = 0;
  let received = 0;
  const fail = (error: unknown) => {
    failure ??= error;
  };
  const channel = new Channel(
    parentPort,
    runtime,
    "ui",
    (packet) => {
      if (packet.kind === "shutdown") {
        stopping = true;
      } else {
        assert.equal(packet.kind, "server");
        if (packet.kind === "server" && packet.message.kind === "event") {
          assert.equal(packet.message.sequence, ++received);
        }
      }
    },
    fail,
  );
  const windows = new Windows(
    () => {},
    undefined,
    undefined,
    () => channel.poll(),
  );
  let hwnd = 0n;
  try {
    hwnd = windows.create("Modal window events", 640, 480, (message) => {
      if (message === WM_ENTERSIZEMOVE) {
        channel.notify({
          kind: "diagnostic",
          event: "modal-enter",
          fields: {},
        });
      } else if (message === WM_EXITSIZEMOVE) {
        channel.notify({
          kind: "diagnostic",
          event: "modal-exit",
          fields: {
            received,
          },
        });
      }
    });
    windows.observe(hwnd, "main", (snapshot, changes) => {
      emitted++;
      void channel
        .send({
          kind: "native-event",
          route,
          event: "windows.changed",
          payload: {
            ...snapshot,
            changes,
          },
        })
        .catch(fail);
    });
    await channel.send({
      kind: "diagnostic",
      event: "window",
      fields: {
        hwnd: String(hwnd),
      },
    });
    while (!stopping) {
      windows.pump();
      assert.equal(failure, undefined);
      await Bun.sleep(MOVE_INTERVAL_MS);
    }
    assert.equal(failure, undefined);
    assert.equal(received, emitted);
    assert(emitted >= MOVE_COUNT);
    await channel.send({
      kind: "diagnostic",
      event: "result",
      fields: {
        emitted,
        received,
      },
    });
  } finally {
    if (hwnd) {
      windows.destroy(hwnd);
    }
    windows.dispose();
    await channel.drain();
    channel.close();
    parentPort.close();
  }
} else {
  const worker = new Worker(import.meta.filename, {
    workerData: true,
  });
  const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
  let hwnd = 0n;
  let entered = false;
  let left = false;
  let result = false;
  let received = 0;
  let failure: unknown;
  worker.on("error", (error) => {
    failure ??= error;
  });
  const channel = new Channel(
    worker,
    runtime,
    "main",
    async (packet) => {
      if (packet.kind === "native-event") {
        await channel.send({
          kind: "server",
          route,
          message: {
            kind: "event",
            protocol: PROTOCOL_VERSION,
            subscriptionId: "sub-modal",
            sequence: ++received,
            source: "native",
            target: "main",
            event: packet.event,
            payload: packet.payload,
          },
        });
      } else if (packet.kind === "diagnostic") {
        if (packet.event === "window") {
          hwnd = BigInt(String(packet.fields.hwnd));
        }
        if (packet.event === "modal-enter") {
          entered = true;
        }
        if (packet.event === "modal-exit") {
          assert(
            Number(packet.fields.received) > API_LIMITS.maxPending,
            "Server delivery stalled inside the modal loop",
          );
          left = true;
        }
        if (packet.event === "result") {
          result = true;
        }
      }
    },
    (error) => {
      failure ??= error;
    },
  );
  const driver = dlopen("user32.dll", {
    PostMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i32",
    },
    SetWindowPos: {
      args: [
        "u64",
        "u64",
        "i32",
        "i32",
        "i32",
        "i32",
        "u32",
      ],
      returns: "i32",
    },
  });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      assert.equal(failure, undefined);
      assert(Date.now() < deadline, "Modal event test timed out");
      await Bun.sleep(MOVE_INTERVAL_MS);
    }
  };
  const timer = setTimeout(() => {
    void worker.terminate();
  }, 20000);
  try {
    await waitFor(() => !!hwnd);
    assert(driver.symbols.PostMessageW(hwnd, WM_SYSCOMMAND, SC_MOVE, 0n));
    await waitFor(() => entered);
    for (let index = 0; index < MOVE_COUNT; index++) {
      assert(
        driver.symbols.SetWindowPos(
          hwnd,
          0n,
          100 + index,
          100,
          0,
          0,
          SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        ),
      );
      await Bun.sleep(MOVE_INTERVAL_MS);
    }
    assert(driver.symbols.PostMessageW(hwnd, WM_CANCELMODE, 0n, 0n));
    await waitFor(() => left);
    await channel.drain();
    await channel.send({
      kind: "shutdown",
    });
    assert.equal(await exit, 0);
    assert.equal(failure, undefined);
    assert(result);
    console.log(`PASS ${received} ordered modal events and server deliveries`);
  } finally {
    clearTimeout(timer);
    if (hwnd) {
      driver.symbols.PostMessageW(hwnd, WM_CANCELMODE, 0n, 0n);
    }
    channel.close();
    await worker.terminate();
    driver.close();
  }
}
