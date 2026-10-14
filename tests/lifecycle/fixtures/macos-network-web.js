import { createClient } from "@bunaway/client";
import network from "@bunaway/plugin-network";

const client = createClient();

function check(ok, message) {
  if (!ok) {
    throw new Error(message);
  }
}
function equal(value, expected, message) {
  check(JSON.stringify(value) === JSON.stringify(expected), message);
}
async function error(work, code) {
  try {
    await work();
  } catch (failure) {
    check(
      failure instanceof Error && "code" in failure && failure.code === code,
      `Expected ${code}: ${String(failure)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}`);
}
async function waitFor(started) {
  const deadline = Date.now() + 5000;
  while (!started(await client.invoke("test.stats", null))) {
    check(Date.now() < deadline, "Network call did not start");
    await new Promise((done) => setTimeout(done, 10));
  }
}

try {
  const { http, ws } = await client.invoke("test.config", null);
  const view = location.pathname.slice(1).split(".")[0];
  if (view !== "main") {
    // Command permission is allowed; each operation still needs its own host grant.
    if (view === "request-only") {
      check(
        (
          await network.request({
            url: `${http}/text`,
          })
        ).status === 200,
        "request-only HTTP",
      );
      await client.invoke("test.inheritedHttp", null);
    } else {
      await error(
        () =>
          network.request({
            url: `${http}/denied`,
          }),
        "PERMISSION_DENIED",
      );
      await error(
        () => client.invoke("test.inheritedHttp", null),
        "PERMISSION_DENIED",
      );
    }
    await error(
      () =>
        network.exchange({
          url: `${ws}/denied`,
          messages: [],
          receiveCount: 1,
        }),
      "PERMISSION_DENIED",
    );
    await error(
      () => client.invoke("test.inheritedWs", null),
      "PERMISSION_DENIED",
    );
    await client.invoke("test.ready", view ?? "unknown");
  } else {
    await client.invoke("test.peers", null);
    const binary = "AP8KQQ==";
    const echo = await network.request({
      url: `${http}/echo`,
      method: "POST",
      bodyBase64: binary,
    });
    check(
      echo.status === 201 && echo.bodyBase64 === binary,
      "binary HTTP roundtrip",
    );
    const text = await network.request({
      url: `${http}/text`,
    });
    check(
      new TextDecoder().decode(
        Uint8Array.from(atob(text.bodyBase64), (char) => char.charCodeAt(0)),
      ) === "한글 😀",
      "UTF-8 HTTP",
    );
    const redirect = await network.request({
      url: `${http}/redirect`,
    });
    check(redirect.status === 302, "manual redirect");
    check(
      (
        await network.request({
          url: `${http}/text`,
          method: "HEAD",
          maxResponseBytes: 0,
        })
      ).bodyBase64 === "",
      "HEAD empty body",
    );
    await error(
      () =>
        network.request({
          url: `${http}/large`,
        }),
      "INTERNAL",
    );
    await error(
      () =>
        network.request({
          url: `${http}/compressed-large`,
        }),
      "INTERNAL",
    );
    await error(
      () =>
        network.request({
          url: `${http}/text`,
          maxResponseBytes: 1,
        }),
      "INTERNAL",
    );
    await error(
      () =>
        network.request({
          url: `${http}/text`,
          headers: [
            [
              "Cookie",
              "secret",
            ],
          ],
        }),
      "INVALID_ARGUMENT",
    );
    const socket = await network.exchange({
      url: `${ws}/socket`,
      messages: [
        "한글 😀",
        "a & b",
      ],
      receiveCount: 2,
    });
    equal(
      socket.messages,
      [
        {
          kind: "text",
          text: "한글 😀",
        },
        {
          kind: "text",
          text: "a & b",
        },
      ],
      "WebSocket text",
    );
    check(
      socket.close.code === 1000 && socket.close.wasClean,
      "clean handshake",
    );
    const bytes = await network.exchange({
      url: `${ws}/binary`,
      messages: [],
      receiveCount: 1,
    });
    equal(
      bytes.messages,
      [
        {
          kind: "binary",
          base64: "AP8B",
        },
      ],
      "WebSocket binary",
    );
    await error(
      () =>
        network.exchange({
          url: `${ws}/redirect`,
          messages: [],
          receiveCount: 1,
        }),
      "INTERNAL",
    );
    await error(
      () =>
        network.exchange({
          url: `${ws}/bad-handshake`,
          messages: [],
          receiveCount: 1,
        }),
      "INTERNAL",
    );
    await error(
      () =>
        network.exchange({
          url: `${ws}/socket-large`,
          messages: [],
          receiveCount: 1,
        }),
      "INTERNAL",
    );
    await error(
      () =>
        network.request({
          url: `${http}/wait-timeout`,
          timeoutMs: 30,
        }),
      "TIMEOUT",
    );
    await error(
      () =>
        network.exchange({
          url: `${ws}/socket-timeout`,
          messages: [],
          receiveCount: 1,
          timeoutMs: 30,
        }),
      "TIMEOUT",
    );

    for (const transport of [
      "http",
      "ws",
    ]) {
      const controller = new AbortController();
      const observed = error(
        () =>
          transport === "http"
            ? network.request(
                {
                  url: `${http}/wait-cancel`,
                },
                {
                  signal: controller.signal,
                },
              )
            : network.exchange(
                {
                  url: `${ws}/socket-cancel`,
                  messages: [],
                  receiveCount: 1,
                },
                {
                  signal: controller.signal,
                },
              ),
        "CANCELLED",
      );
      await waitFor(
        (stats) =>
          (transport === "http"
            ? stats.waits["/wait-cancel"]
            : stats.sockets["/socket-cancel"]) === 1,
      );
      check(
        (await client.invoke("test.echo", "responsive")) === "responsive",
        "UI responds during network I/O",
      );
      controller.abort();
      await observed;
      await waitFor((stats) =>
        transport === "http"
          ? stats.cancelledReads.includes("/wait-cancel")
          : stats.closedSockets.includes("/socket-cancel"),
      );
    }
    // SDK deadlines must cancel the native transport, in addition to the adapter timeout.
    const deadline = error(
      () =>
        network.request(
          {
            url: `${http}/wait-deadline`,
          },
          {
            deadline: Date.now() + 500,
          },
        ),
      "TIMEOUT",
    );
    await waitFor((stats) => stats.waits["/wait-deadline"] === 1);
    await deadline;
    await waitFor((stats) => stats.cancelledReads.includes("/wait-deadline"));
    // The parent waits for both real transports to start before sending SIGTERM.
    const shutdownHttp = network.request({
      url: `${http}/wait-shutdown`,
    });
    const shutdownWs = network.exchange({
      url: `${ws}/socket-shutdown`,
      messages: [],
      receiveCount: 1,
    });
    void Promise.allSettled([
      shutdownHttp,
      shutdownWs,
    ]);
    await waitFor(
      (stats) =>
        stats.waits["/wait-shutdown"] === 1 &&
        stats.sockets["/socket-shutdown"] === 1,
    );
    await client.invoke("test.report", {
      ok: true,
    });
  }
} catch (failure) {
  await client.invoke("test.report", {
    ok: false,
    message: String(failure),
  });
}
