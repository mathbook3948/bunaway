import assert from "node:assert/strict";
import { resolve } from "node:path";
import { type CommandContext, defineApp } from "@bunaway/backend";
import { windows, windowsPlugin } from "@bunaway/plugin-windows";

/** Exercise the public SDK from the real backend Worker while WKWebView documents connect. */
export function controlsApp(origin: string, outside: string) {
  const arrivals = new Map<string, number>();
  const held = new Map<string, number>();
  const cancelled = new Map<string, number>();
  const main = {
    view: "main",
  };
  const peer = {
    view: "peer",
  };
  let pageFailure: string | undefined;
  let fragmentCalls = 0;
  let spoofedCalls = 0;
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    stage: string,
  ) => {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      if (pageFailure) {
        throw new Error(pageFailure);
      }
      assert(Date.now() < deadline, `Timed out: ${stage}`);
      await Bun.sleep(10);
    }
  };
  const ready = async (path: string, count = 1) => {
    await waitFor(
      () => (arrivals.get(path) ?? 0) >= count,
      `arrival ${path} ${count}`,
    );
    await waitFor(
      async () => !(await windows.getWebViewState(main)).loading,
      `loaded ${path}`,
    );
  };
  async function requests(kind: "slow" | "redirects"): Promise<number> {
    const stats = await (await fetch(`${origin}/stats`)).json();
    assert(
      stats &&
        typeof stats === "object" &&
        "slow" in stats &&
        "redirects" in stats,
    );
    const count: unknown = stats[kind];
    assert.equal(typeof count, "number");
    return Number(count);
  }
  async function exercise() {
    await ready("/index.html");
    await waitFor(
      () =>
        arrivals.has("/peer.html") &&
        arrivals.has("/denied.html") &&
        held.has("/index.html"),
      "peer and denied clients",
    );
    assert.deepEqual(await windows.getWebViewState(main), {
      url: "https://app.bunaway.local/index.html",
      title: "/index.html",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
    });
    assert.equal(await windows.goBack(main), false);
    assert.equal(await windows.goForward(main), false);
    for (const factor of [
      0.25,
      1.5,
      5,
    ]) {
      assert(
        Math.abs(
          (await windows.setZoomFactor({
            ...main,
            factor,
          })) - factor,
        ) < 0.001,
      );
      assert(
        Math.abs((await windows.getWebViewState(main)).zoomFactor - factor) <
          0.001,
      );
    }
    assert.equal((await windows.getWebViewState(peer)).zoomFactor, 1);
    for (const factor of [
      0.249,
      5.001,
    ]) {
      await assert.rejects(
        windows.setZoomFactor({
          ...main,
          factor,
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
    }
    const beforeDenied = await windows.getWebViewState(main);
    for (const url of [
      outside,
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,blocked",
      "bunaway://app.bunaway.local/index.html",
      `http://user:password@${new URL(origin).host}/index.html`,
    ]) {
      await assert.rejects(
        windows.navigateWebView({
          ...main,
          url,
        }),
        {
          code: "PERMISSION_DENIED",
        },
      );
    }
    assert.deepEqual(await windows.getWebViewState(main), beforeDenied);
    await assert.rejects(windows.openDevTools(main), {
      code: "UNSUPPORTED",
    });
    await assert.rejects(
      windows.reloadWebView({
        view: "missing",
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );

    await windows.navigateWebView({
      ...main,
      url: `${origin}/next.html`,
    });
    await ready("/next.html");
    await waitFor(
      () => (cancelled.get("/index.html") ?? 0) === 1,
      "document revocation",
    );
    assert.equal(
      (await windows.getWebViewState(main)).url,
      `${origin}/next.html`,
    );
    assert.equal((await windows.getWebViewState(main)).canGoBack, true);
    assert.equal(await windows.goBack(main), true);
    await ready("/index.html", 2);
    assert.equal((await windows.getWebViewState(main)).canGoForward, true);
    assert.equal(await windows.goForward(main), true);
    await ready("/next.html", 2);
    await windows.reloadWebView(main);
    await ready("/next.html", 3);
    await waitFor(() => (held.get("/next.html") ?? 0) >= 3, "reload client");
    const cancelledBeforeFragment = cancelled.get("/next.html") ?? 0;
    await windows.navigateWebView({
      ...main,
      url: `${origin}/next.html#fragment`,
    });
    await waitFor(() => fragmentCalls === 1, "existing fragment client");
    assert.equal(cancelled.get("/next.html") ?? 0, cancelledBeforeFragment);
    assert.equal(
      (await windows.getWebViewState(main)).url,
      `${origin}/next.html#fragment`,
    );
    assert.equal(
      (await windows.getWebViewState(peer)).url,
      "https://app.bunaway.local/peer.html",
    );

    await windows.navigateWebView({
      ...main,
      url: `${origin}/slow.html`,
    });
    await waitFor(async () => (await requests("slow")) >= 1, "slow request");
    await waitFor(
      async () => (await windows.getWebViewState(main)).loading,
      "slow loading",
    );
    await windows.stopWebView(main);
    await waitFor(
      async () => !(await windows.getWebViewState(main)).loading,
      "stop loading",
    );
    assert.equal(arrivals.has("/slow.html"), false);
    await windows.navigateWebView({
      ...main,
      url: `${origin}/recovered.html`,
    });
    await ready("/recovered.html");
    await windows.navigateWebView({
      ...main,
      url: `${origin}/redirect.html`,
    });
    await waitFor(
      async () => (await requests("redirects")) >= 1,
      "redirect request",
    );
    await waitFor(
      async () => !(await windows.getWebViewState(main)).loading,
      "denied redirect",
    );
    assert.notEqual(
      new URL((await windows.getWebViewState(main)).url).origin,
      outside,
    );
    await windows.navigateWebView({
      ...main,
      url: `${origin}/final.html`,
    });
    await ready("/final.html");
    assert.equal(
      spoofedCalls,
      0,
      "subframe message acquired a main-frame route",
    );
    await windows.close(peer);
    await assert.rejects(windows.getWebViewState(peer), {
      code: "INVALID_ARGUMENT",
    });
    await windows.recreate(peer);
    await waitFor(
      () => (arrivals.get("/peer.html") ?? 0) === 2,
      "recreated peer",
    );
    const recreated = await windows.getWebViewState(peer);
    assert.equal(recreated.zoomFactor, 1);
    assert.equal(recreated.canGoBack, false);
    assert.equal(recreated.canGoForward, false);
    await windows.setZoomFactor({
      ...peer,
      factor: 1.25,
    });
    assert.equal((await windows.getWebViewState(main)).title, "/final.html");
    if (pageFailure) {
      throw new Error(pageFailure);
    }
    return {
      pass: true,
      arrivals: Object.fromEntries(arrivals),
      cancelled: Object.fromEntries(cancelled),
      fragmentCalls,
      spoofedCalls,
    };
  }
  return defineApp({
    modules: [],
    events: {},
    plugins: [
      windowsPlugin,
      {
        name: "controls-fixture",
        version: "1.0.0",
        setup() {
          // Setup must complete before the host can start its documents. Observe all work and failure.
          void (async () => {
            let report: object;
            try {
              report = await exercise();
            } catch (error) {
              console.error(error);
              report = {
                pass: false,
                error: String(error),
              };
            }
            await Bun.write(
              resolve(process.env.TMPDIR ?? "", "report.json"),
              JSON.stringify(report),
            );
            for (const view of [
              "peer",
              "denied",
              "main",
            ]) {
              await windows.close({
                view,
              });
            }
          })().catch((error) => {
            console.error(error);
            process.exitCode = 1;
          });
        },
      },
    ],
    commands: {
      "test.arrived": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          assert.equal(typeof input, "string");
          const path = String(input);
          arrivals.set(path, (arrivals.get(path) ?? 0) + 1);
          return null;
        },
      },
      "test.hold": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(input: unknown, context: CommandContext) {
          const path = String(input);
          held.set(path, (held.get(path) ?? 0) + 1);
          await new Promise<void>((done) => {
            if (context.signal.aborted) {
              done();
              return;
            }
            const abort = () => {
              context.signal.removeEventListener("abort", abort);
              done();
            };
            context.signal.addEventListener("abort", abort);
          });
          cancelled.set(path, (cancelled.get(path) ?? 0) + 1);
          return null;
        },
      },
      "test.fragment": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          fragmentCalls++;
          return null;
        },
      },
      "test.spoof": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          spoofedCalls++;
          return null;
        },
      },
      "test.failure": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          pageFailure = String(input);
          return null;
        },
      },
    },
  });
}
