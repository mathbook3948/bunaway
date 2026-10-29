import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadInputSchema,
  exchangeInputSchema,
  requestInputSchema,
  uploadInputSchema,
} from "#plugins/network/src/contract";
import type {
  IeProxyConfig,
  WinHttpApi,
} from "#plugins/network/src/platforms/resolve-proxy";
import { systemProxyFor } from "#plugins/network/src/platforms/system-proxy";
import {
  dispose,
  initialize,
  runDownload,
  runExchange,
  runRequest,
  runUpload,
} from "#plugins/network/src/platforms/windows";
import { deadline } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

/** A host name no resolver answers, so a request can only succeed by going through the proxy. */
const ORIGIN = "origin.invalid";
const ENVIRONMENT_NAMES = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
] as const;

type Mode = "answer" | "refuse-auth" | "refuse-tunnel";
let mode: Mode = "answer";
/** The first line of every request the proxy received, such as `GET http://origin.invalid/x HTTP/1.1`. */
let requestLines: string[] = [];
let proxyPort = 0;
let folder: string;
const saved = new Map<string, string | undefined>();

function startProxy(): Promise<Server> {
  const server = createServer((socket) => {
    let received = Buffer.alloc(0);
    let answered = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received = Buffer.concat([
        received,
        Buffer.from(chunk),
      ]);
      const end = received.indexOf("\r\n\r\n");
      if (answered || end < 0) {
        return;
      }
      const head = received.subarray(0, end).toString("latin1");
      const length = Number(/^content-length: (\d+)$/im.exec(head)?.[1] ?? 0);
      if (received.length < end + 4 + length) {
        return;
      }
      answered = true;
      const line = head.split("\r\n")[0] ?? "";
      requestLines.push(line);
      if (line.startsWith("CONNECT ") || mode === "refuse-tunnel") {
        socket.end(
          "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        );
      } else if (mode === "refuse-auth") {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="corp"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
        );
      } else {
        socket.end(
          "HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\nproxied",
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let proxyServer: Server;
const direct = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("direct"),
});

beforeAll(async () => {
  proxyServer = await startProxy();
  const address = proxyServer.address();
  proxyPort = typeof address === "object" && address ? address.port : 0;
  folder = mkdtempSync(join(tmpdir(), "bunaway-system-proxy-"));
  for (const name of ENVIRONMENT_NAMES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  mode = "answer";
  requestLines = [];
});

afterAll(async () => {
  proxyServer.close();
  await direct.stop(true);
  rmSync(folder, {
    recursive: true,
    force: true,
  });
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function settings(config: Partial<IeProxyConfig> | null): () => WinHttpApi {
  return () => ({
    ieProxyConfig: () =>
      config && {
        autoDetect: false,
        autoConfigUrl: null,
        proxy: null,
        bypass: null,
        ...config,
      },
    autoProxyForUrl: async () => 12180,
  });
}

const viaProxy = () =>
  settings({
    proxy: `127.0.0.1:${proxyPort}`,
  });

function requestFor(url: string, timeoutMs = 5000) {
  return requestInputSchema.parse({
    url,
    timeoutMs,
  });
}

function bodyOf(response: { bodyBase64: string }) {
  return Buffer.from(response.bodyBase64, "base64").toString();
}

test("request follows the system proxy and sends the full URL to it", async () => {
  const state = initialize();
  const response = await runRequest(
    state,
    requestFor(`http://${ORIGIN}/path?q=1`),
    undefined,
    viaProxy(),
  );
  expect(bodyOf(response)).toBe("proxied");
  expect(requestLines).toEqual([
    `GET http://${ORIGIN}/path?q=1 HTTP/1.1`,
  ]);
  await dispose(state);
});

test("an https request asks its proxy for a tunnel to the origin", async () => {
  const state = initialize();
  // The proxy refuses the tunnel; what matters is that the tunnel was asked for.
  await runRequest(
    state,
    requestFor(`https://${ORIGIN}/`),
    undefined,
    viaProxy(),
  ).catch(() => undefined);
  expect(requestLines).toEqual([
    `CONNECT ${ORIGIN}:443 HTTP/1.1`,
  ]);
  await dispose(state);
});

test("a proxy that wants credentials answers with its 407 and no credentials are sent", async () => {
  mode = "refuse-auth";
  const state = initialize();
  const response = await runRequest(
    state,
    requestFor(`http://${ORIGIN}/`),
    undefined,
    viaProxy(),
  );
  expect(response.status).toBe(407);
  expect(Object.fromEntries(response.headers)["proxy-authenticate"]).toContain(
    "Basic",
  );
  await dispose(state);
});

test("download and upload follow the system proxy", async () => {
  const state = initialize();
  const target = join(folder, "saved.txt");
  const saved = await runDownload(
    state,
    "app",
    downloadInputSchema.parse({
      downloadId: crypto.randomUUID(),
      url: `http://${ORIGIN}/file`,
      path: target,
      maxBytes: 1024,
    }),
    undefined,
    viaProxy(),
  );
  expect(saved).toMatchObject({
    saved: true,
  });
  expect(readFileSync(target, "utf8")).toBe("proxied");
  const source = join(folder, "source.txt");
  writeFileSync(source, "0123456789");
  const answer = await runUpload(
    state,
    "app",
    uploadInputSchema.parse({
      uploadId: crypto.randomUUID(),
      url: `http://${ORIGIN}/up`,
      path: source,
    }),
    undefined,
    viaProxy(),
  );
  expect(bodyOf(answer)).toBe("proxied");
  expect(requestLines).toEqual([
    `GET http://${ORIGIN}/file HTTP/1.1`,
    expect.stringMatching(new RegExp(`^(POST|PUT) http://${ORIGIN}/up `)),
  ]);
  await dispose(state);
});

test("exchange follows the system proxy for ws and wss", async () => {
  const state = initialize();
  for (const [scheme, port] of [
    [
      "ws",
      80,
    ],
    [
      "wss",
      443,
    ],
  ] as const) {
    await expect(
      runExchange(
        state,
        exchangeInputSchema.parse({
          url: `${scheme}://${ORIGIN}/socket`,
          messages: [],
          receiveCount: 1,
          timeoutMs: 5000,
        }),
        undefined,
        viaProxy(),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(requestLines.at(-1)).toBe(`CONNECT ${ORIGIN}:${port} HTTP/1.1`);
  }
  await dispose(state);
});

test("a direct route, no settings, a bypassed host and loopback skip the proxy", async () => {
  const state = initialize();
  for (const api of [
    settings(null),
    settings({}),
    settings({
      proxy: `127.0.0.1:${proxyPort}`,
      bypass: "127.0.0.1",
    }),
    viaProxy(),
  ]) {
    const response = await runRequest(
      state,
      requestFor(`http://127.0.0.1:${direct.port}/`),
      undefined,
      api,
    );
    expect(bodyOf(response)).toBe("direct");
  }
  expect(requestLines).toEqual([]);
  await dispose(state);
});

test("a proxy named by an environment variable keeps priority and skips the system lookup", async () => {
  const state = initialize();
  let lookups = 0;
  const counting = () => {
    lookups += 1;
    return viaProxy()();
  };
  process.env.HTTP_PROXY = "http://127.0.0.1:9";
  try {
    await runRequest(
      state,
      requestFor(`http://127.0.0.1:${direct.port}/`),
      undefined,
      counting,
    ).catch(() => undefined);
    expect(lookups).toBe(0);
  } finally {
    delete process.env.HTTP_PROXY;
  }
  await runRequest(
    state,
    requestFor(`http://127.0.0.1:${direct.port}/`),
    undefined,
    counting,
  );
  expect(lookups).toBe(1);
  await dispose(state);
});

test("a route with only a SOCKS proxy fails instead of connecting directly", async () => {
  const state = initialize();
  await expect(
    runRequest(
      state,
      requestFor(`http://${ORIGIN}/`),
      undefined,
      settings({
        proxy: "socks=127.0.0.1:1080",
      }),
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL",
    message: "SOCKS proxy is not supported.",
  });
  await dispose(state);
});

test("a settings read that fails is logged without the address and the request goes direct", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const chosen = await systemProxyFor(
      () => ({
        ieProxyConfig: () => {
          throw new Error("registry unreadable");
        },
        autoProxyForUrl: async () => 12180,
      }),
      `http://${ORIGIN}:8080/`,
      1000,
      new AbortController().signal,
    );
    expect(chosen).toBeUndefined();
  } finally {
    console.error = original;
  }
  expect(logged).toHaveLength(1);
  expect(JSON.stringify(logged)).not.toContain(ORIGIN);
});

test("the request deadline and cancellation end a lookup that never answers", async () => {
  const state = initialize();
  const stuck: () => WinHttpApi = () => ({
    ieProxyConfig: () => ({
      autoDetect: true,
      autoConfigUrl: null,
      proxy: null,
      bypass: null,
    }),
    autoProxyForUrl: (_url, _source, _timeoutMs, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  await expect(
    runRequest(state, requestFor(`http://${ORIGIN}/`, 50), undefined, stuck),
  ).rejects.toMatchObject({
    code: "TIMEOUT",
  });
  const controller = new AbortController();
  const pending = runRequest(
    state,
    requestFor(`http://${ORIGIN}/`),
    controller.signal,
    stuck,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(state.active.size).toBe(0);
  await dispose(state);
});
