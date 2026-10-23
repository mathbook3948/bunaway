import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CommandContext, defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import { BunawayError } from "@bunaway/protocol";
import { controlsClientReadiness } from "./readiness.ts";

/** Per-stage wait bound; macOS CI runners can be slow to deliver WebView loads. */
const WAIT_TIMEOUT_MS = 45_000;

/** Exercise the public SDK from the real backend Worker while WKWebView documents connect. */
export function controlsApp(origin: string, outside: string) {
  const arrivals = new Map<string, number>();
  const held = new Map<string, number>();
  const cancelled = new Map<string, number>();
  let pageFailure: string | undefined;
  let fragmentCalls = 0;
  let spoofedCalls = 0;
  const progress = resolve(process.env.TMPDIR ?? "", "controls-progress.json");
  // Persist from the backend Worker itself: a blocked UI thread may not flush console output.
  const checkpoint = (stage: string, error?: unknown) => {
    writeFileSync(
      `${progress}.tmp`,
      JSON.stringify({
        stage,
        timestamp: Date.now(),
        arrivals: Object.fromEntries(arrivals),
        held: Object.fromEntries(held),
        cancelled: Object.fromEntries(cancelled),
        ...(error === undefined
          ? {}
          : {
              error: String(error),
            }),
      }),
    );
    renameSync(`${progress}.tmp`, progress);
  };
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    stage: string,
  ) => {
    checkpoint(`waiting: ${stage}`);
    const startedAt = Date.now();
    const deadline = startedAt + WAIT_TIMEOUT_MS;
    while (!(await check())) {
      if (pageFailure) {
        throw new Error(pageFailure);
      }
      if (Date.now() >= deadline) {
        const message = `Timed out: ${stage} after ${Date.now() - startedAt} ms (deadline ${WAIT_TIMEOUT_MS} ms)`;
        // Best-effort progress marker; the outer catch may overwrite the progress file with a failure summary.
        checkpoint(`timed out: ${stage}`, message);
        throw new Error(message);
      }
      await Bun.sleep(10);
    }
    checkpoint(`completed: ${stage}`);
  };
  const ready = controlsClientReadiness({
    arrivals,
    held,
    isLoading: async () => (await windows.getWebViewState()).loading,
    waitFor,
  });
  async function requests(
    kind: "slow" | "redirects" | "syntheticRestores" | "probeLoads",
  ): Promise<number> {
    const stats = await (await fetch(`${origin}/stats`)).json();
    assert(
      stats &&
        typeof stats === "object" &&
        "slow" in stats &&
        "redirects" in stats &&
        "syntheticRestores" in stats &&
        "probeLoads" in stats,
    );
    const count: unknown = stats[kind];
    assert.equal(typeof count, "number");
    return Number(count);
  }
  async function exercise() {
    await ready("/index.html");
    await waitFor(() => held.has("/index.html"), "the held command");
    const { focused, ...initialState } = await windows.getWebViewState();
    // Real key-window state depends on the CI desktop session, so only the type is stable.
    assert.equal(typeof focused, "boolean");
    assert.deepEqual(initialState, {
      url: "https://app.bunaway.local/index.html",
      title: "/index.html",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
    });
    assert.equal(await windows.goBack(), false);
    assert.equal(await windows.goForward(), false);
    for (const factor of [
      0.25,
      1.5,
      5,
    ]) {
      assert(
        Math.abs(
          (await windows.setZoomFactor({
            factor,
          })) - factor,
        ) < 0.001,
      );
      assert(
        Math.abs((await windows.getWebViewState()).zoomFactor - factor) < 0.001,
      );
    }
    for (const factor of [
      0.249,
      5.001,
    ]) {
      await assert.rejects(
        windows.setZoomFactor({
          factor,
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
    }
    const beforeDenied = await windows.getWebViewState();
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
          url,
        }),
        {
          code: "PERMISSION_DENIED",
        },
      );
    }
    assert.deepEqual(await windows.getWebViewState(), beforeDenied);
    await assert.rejects(windows.openDevTools(), {
      code: "UNSUPPORTED",
    });
    await assert.rejects(windows.reloadWebView(), {
      code: "INVALID_ARGUMENT",
    });

    await windows.navigateWebView({
      url: `${origin}/next.html`,
    });
    await ready("/next.html");
    await waitFor(
      () => (cancelled.get("/index.html") ?? 0) === 1,
      "document revocation",
    );
    assert.equal((await windows.getWebViewState()).url, `${origin}/next.html`);
    assert.equal((await windows.getWebViewState()).canGoBack, true);
    assert.equal(await windows.goBack(), true);
    await ready("/index.html", 2);
    assert.equal((await windows.getWebViewState()).canGoForward, true);
    assert.equal(await windows.goForward(), true);
    await ready("/next.html", 2);
    await windows.reloadWebView();
    await ready("/next.html", 3);
    await waitFor(() => (held.get("/next.html") ?? 0) >= 3, "reload client");
    const cancelledBeforeFragment = cancelled.get("/next.html") ?? 0;
    await windows.navigateWebView({
      url: `${origin}/next.html#fragment`,
    });
    await waitFor(() => fragmentCalls === 1, "existing fragment client");
    assert.equal(cancelled.get("/next.html") ?? 0, cancelledBeforeFragment);
    assert.equal(
      (await windows.getWebViewState()).url,
      `${origin}/next.html#fragment`,
    );

    await windows.navigateWebView({
      url: `${origin}/slow.html`,
    });
    await waitFor(async () => (await requests("slow")) >= 1, "slow request");
    await waitFor(
      async () => (await windows.getWebViewState()).loading,
      "slow loading",
    );
    await windows.stopWebView();
    await waitFor(
      async () => !(await windows.getWebViewState()).loading,
      "stop loading",
    );
    assert.equal(arrivals.has("/slow.html"), false);
    await windows.navigateWebView({
      url: `${origin}/recovered.html`,
    });
    await ready("/recovered.html");
    await windows.navigateWebView({
      url: `${origin}/redirect.html`,
    });
    await waitFor(
      async () => (await requests("redirects")) >= 1,
      "redirect request",
    );
    await waitFor(
      async () => !(await windows.getWebViewState()).loading,
      "denied redirect",
    );
    assert.notEqual(
      new URL((await windows.getWebViewState()).url).origin,
      outside,
    );
    await windows.navigateWebView({
      url: `${origin}/final.html`,
    });
    await ready("/final.html");
    assert.equal(
      spoofedCalls,
      0,
      "subframe message acquired a main-frame route",
    );
    for (const [url, path] of [
      [
        "HTTPS://app.bunaway.local/upper-scheme.html?case=scheme#asset",
        "/upper-scheme.html",
      ],
      [
        "https://APP.BUNAWAY.LOCAL/upper-host.html?case=host#asset",
        "/upper-host.html",
      ],
    ]) {
      assert(url && path);
      checkpoint(`navigate requested: ${path}`);
      await windows.navigateWebView({
        url,
      });
      checkpoint(`navigate returned: ${path}`);
      await ready(path);
      assert.equal((await windows.getWebViewState()).url, new URL(url).href);
      assert.equal((await windows.getWebViewState()).title, path);
    }
    await windows.navigateWebView({
      url: `${origin}/cache-probe.html`,
    });
    await ready("/cache-probe.html", 2);
    await waitFor(
      () => (held.get("/cache-probe.html") ?? 0) === 2,
      "fresh SDK after synthetic persisted restore",
    );
    await waitFor(
      () => (cancelled.get("/cache-probe.html") ?? 0) === 1,
      "synthetic pagehide cancellation",
    );
    await waitFor(
      async () => (await requests("syntheticRestores")) === 1,
      "persisted pageshow branch evidence",
    );
    await waitFor(
      async () => (await requests("probeLoads")) === 2,
      "completed reload after synthetic persisted restore",
    );
    await windows.navigateWebView({
      url: `${origin}/final.html`,
    });
    await ready("/final.html", 2);
    assert.equal((await windows.getWebViewState()).title, "/final.html");
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
      windows,
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
              // Retain the primary failure before asking a possibly stalled UI for diagnostic state.
              checkpoint("failed; state query pending", error);
              console.error(error);
              report = {
                pass: false,
                error: String(error),
                arrivals: Object.fromEntries(arrivals),
                held: Object.fromEntries(held),
                cancelled: Object.fromEntries(cancelled),
                state: await windows.getWebViewState().catch((error) => ({
                  error: String(error),
                })),
              };
              checkpoint("failed; state query completed", error);
            }
            await Bun.write(
              resolve(process.env.TMPDIR ?? "", "report.json"),
              JSON.stringify(report),
            );
            // The final close retires the backend route before its response can be delivered.
            try {
              await windows.close();
            } catch (error) {
              if (
                !(error instanceof BunawayError) ||
                error.code !== "CANCELLED"
              ) {
                throw error;
              }
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
