import { expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import network from "@bunaway/plugin-network";
import { NativeRegistry } from "@bunaway/protocol";
import {
  MAX_PROXY_ENTRIES,
  resolveProxyInputSchema,
  resolveProxyResultSchema,
} from "#plugins/network/src/contract";
import { macosOperations } from "#plugins/network/src/operations";
import {
  AUTO_PROXY_WORKER_SOURCE,
  requestFromWorker,
  startWorker,
} from "#plugins/network/src/platforms/auto-proxy-worker";
import {
  isImplicitDirect,
  matchesBypass,
  parseProxyList,
  selectEntries,
} from "#plugins/network/src/platforms/proxy-rules";
import {
  type AutoProxyResult,
  type AutoProxySource,
  type IeProxyConfig,
  parseReply,
  resolveProxy,
  type WinHttpApi,
} from "#plugins/network/src/platforms/resolve-proxy";
import {
  dispose,
  initialize,
  runResolveProxy,
} from "#plugins/network/src/platforms/windows";
import { deadline, waitFor } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

const NAMED = 3;
const NO_PROXY = 1;
const ERROR_AUTODETECTION_FAILED = 12180;
const ERROR_UNABLE_TO_DOWNLOAD_SCRIPT = 12167;
const ERROR_INVALID_URL = 12005;

function direct() {
  return {
    kind: "direct",
  } as const;
}

function proxy(
  host: string,
  port: number,
  scheme: "http" | "https" | "socks4" | "socks5" = "http",
) {
  return {
    kind: "proxy",
    scheme,
    host,
    port,
  } as const;
}

/** A WinHTTP stand-in that records every automatic lookup. */
function fakeApi(
  config: Partial<IeProxyConfig> | null,
  auto: (
    url: string,
    source: AutoProxySource,
    timeoutMs: number,
  ) => AutoProxyResult | number = () => ERROR_AUTODETECTION_FAILED,
) {
  const lookups: {
    url: string;
    source: AutoProxySource;
    timeoutMs: number;
  }[] = [];
  const api: WinHttpApi = {
    ieProxyConfig: () =>
      config && {
        autoDetect: false,
        autoConfigUrl: null,
        proxy: null,
        bypass: null,
        ...config,
      },
    async autoProxyForUrl(url, source, timeoutMs) {
      lookups.push({
        url,
        source,
        timeoutMs,
      });
      return auto(url, source, timeoutMs);
    },
  };
  return {
    api,
    lookups,
  };
}

const live = new AbortController().signal;

test("network.resolveProxy needs its own grant", () => {
  const registry = new NativeRegistry([
    network._definition,
  ]);
  const call = {
    operation: "network.resolveProxy",
    payload: {
      url: "https://example.com/",
    },
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "network.resolveProxy",
        ],
      },
      call,
    ),
  ).toBe(true);
  for (const permissions of [
    [],
    [
      "network.request",
      "network.exchange",
      "network.isOnline",
      "network.resolveHost",
    ],
  ]) {
    expect(
      registry.allowed(
        {
          permissions,
        },
        call,
      ),
    ).toBe(false);
  }
});

test("network.resolveProxy accepts only http and https URLs without credentials", () => {
  const parse = (url: string) =>
    resolveProxyInputSchema.safeParse({
      url,
    }).success;
  expect(parse("http://example.com/path?q=1")).toBe(true);
  expect(parse("https://example.com:8443/")).toBe(true);
  for (const url of [
    "",
    "example.com",
    "ftp://example.com/",
    "ws://example.com/",
    "file:///C:/a.txt",
    "https://user:secret@example.com/",
    "https://example.com/#frag",
    "https://exa mple.com/",
  ]) {
    expect(parse(url)).toBe(false);
  }
  expect(
    resolveProxyInputSchema.safeParse({
      url: "https://example.com/",
      timeoutMs: 0,
    }).success,
  ).toBe(false);
  expect(
    resolveProxyInputSchema.safeParse({
      url: "https://example.com/",
      extra: true,
    }).success,
  ).toBe(false);
  expect(
    resolveProxyInputSchema.parse({
      url: "https://example.com/",
    }).timeoutMs,
  ).toBe(30_000);
});

test("the result schema is a nonempty list of direct and proxy entries", () => {
  const parse = (entries: unknown[]) =>
    resolveProxyResultSchema.safeParse({
      entries,
    }).success;
  expect(
    parse([
      direct(),
    ]),
  ).toBe(true);
  expect(
    parse([
      proxy("proxy.example", 8080),
      direct(),
    ]),
  ).toBe(true);
  expect(parse([])).toBe(false);
  expect(
    parse([
      proxy("proxy.example", 0),
    ]),
  ).toBe(false);
  expect(
    parse([
      proxy("proxy.example", 65536),
    ]),
  ).toBe(false);
  expect(
    parse([
      proxy("", 80),
    ]),
  ).toBe(false);
  expect(
    parse([
      {
        ...proxy("proxy.example", 80),
        scheme: "ftp",
      },
    ]),
  ).toBe(false);
  expect(
    parse([
      {
        ...proxy("proxy.example", 80),
        password: "x",
      },
    ]),
  ).toBe(false);
  expect(
    parse(
      Array.from(
        {
          length: MAX_PROXY_ENTRIES + 1,
        },
        () => direct(),
      ),
    ),
  ).toBe(false);
});

test("a proxy list is split by the scheme each entry serves", () => {
  expect(
    parseProxyList(
      "http=a.example:3128; https=b.example:3129 socks=c.example ftp=d.example:21 e.example",
    ),
  ).toEqual({
    http: [
      proxy("a.example", 3128),
    ],
    https: [
      proxy("b.example", 3129),
    ],
    socks: [
      proxy("c.example", 1080, "socks4"),
    ],
    all: [
      proxy("e.example", 80),
    ],
  });
  expect(
    parseProxyList(
      "https://s.example socks5://t.example:9050 socks://u.example http://v.example:81/path",
    ).all,
  ).toEqual([
    proxy("s.example", 443, "https"),
    proxy("t.example", 9050, "socks5"),
    proxy("u.example", 1080, "socks4"),
    proxy("v.example", 81),
  ]);
});

test("a proxy list with user information is refused whole", () => {
  for (const list of [
    "user:secret@a.example:8080",
    "http://admin:pw@b.example:3128/x",
    "alice:1234;5:6@proxy.example:8080",
    "u:a@b;c@host.example:80",
    "u:p@ss w@rd@host:80",
    "first.example:80;bob@proxy.example:8080",
    "https=a.example:80;http=bob:pw@b.example:81",
  ]) {
    expect(() => parseProxyList(list)).toThrowError(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
    expect(() =>
      selectEntries(list, null, new URL("http://x.example/")),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }
});

test("malformed entries are skipped and unknown schemes ignored", () => {
  const rules = parseProxyList(
    ":80 c.example:0 d.example:70000 e.example:notaport [::1]:3128 socks6=h.example:1080",
  );
  expect(rules.all).toEqual([
    proxy("[::1]", 3128),
  ]);
  expect(rules.socks).toEqual([]);
  // Tokens that are not host names never become a host.
  expect(
    parseProxyList('proxy,corp"x:8080 <local> a%41b \x01host ok.example:81')
      .all,
  ).toEqual([
    proxy("ok.example", 81),
  ]);
  expect(parseProxyList(`${"a".repeat(254)}:80`).all).toEqual([]);
});

test("the bypass list follows the WinHTTP token rules", () => {
  const url = (text: string) => new URL(text);
  const bypass =
    "*.corp.example;<local> 10.*;https://secure.example;api.example:8443";
  expect(matchesBypass(bypass, url("http://wiki.corp.example/"))).toBe(true);
  expect(matchesBypass(bypass, url("http://corp.example/"))).toBe(false);
  expect(matchesBypass(bypass, url("http://intranet/"))).toBe(true);
  expect(matchesBypass(bypass, url("http://10.1.2.3/"))).toBe(true);
  expect(matchesBypass(bypass, url("http://11.1.2.3/"))).toBe(false);
  expect(matchesBypass(bypass, url("https://secure.example/"))).toBe(true);
  expect(matchesBypass(bypass, url("http://secure.example/"))).toBe(false);
  expect(matchesBypass(bypass, url("https://api.example:8443/"))).toBe(true);
  expect(matchesBypass(bypass, url("https://api.example/"))).toBe(false);
  expect(matchesBypass(bypass, url("http://WWW.Example.com/"))).toBe(false);
  expect(matchesBypass(null, url("http://intranet/"))).toBe(false);
  expect(matchesBypass("", url("http://intranet/"))).toBe(false);
  // "." is a literal, not a wildcard.
  expect(matchesBypass("a.example", url("http://axexample/"))).toBe(false);
});

test("a wildcard-heavy bypass token matches in linear time", () => {
  const host = new URL(`http://${"a".repeat(60)}/`);
  const started = performance.now();
  expect(matchesBypass("*a*a*a*a*a*a*a*a*a*a*a*b", host)).toBe(false);
  expect(matchesBypass("*a*a*a*a*a*a*a*a*a*a*a*a", host)).toBe(true);
  expect(matchesBypass("a*a", new URL("http://aa/"))).toBe(true);
  expect(matchesBypass("a*a", new URL("http://a/"))).toBe(false);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("loopback and link-local hosts are never proxied", () => {
  for (const host of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.8.8.8",
    "169.254.10.10",
    "[::1]",
    "[fe80::1]",
  ]) {
    expect(isImplicitDirect(host)).toBe(true);
  }
  for (const host of [
    "example.com",
    "128.0.0.1",
    "127.foo.example",
    "[2001:db8::1]",
    "10.0.0.1",
  ]) {
    expect(isImplicitDirect(host)).toBe(false);
  }
});

test("entries for a URL take its own scheme first, then shared entries; SOCKS only when neither exists", () => {
  const list = "socks=s.example:1080;a.example:80;http=h.example:3128";
  expect(selectEntries(list, null, new URL("http://x.example/"))).toEqual([
    proxy("h.example", 3128),
    proxy("a.example", 80),
  ]);
  expect(selectEntries(list, null, new URL("https://x.example/"))).toEqual([
    proxy("a.example", 80),
  ]);
  expect(
    selectEntries(
      "http=h.example:3128;socks=s.example",
      null,
      new URL("https://x.example/"),
    ),
  ).toEqual([
    proxy("s.example", 1080, "socks4"),
  ]);
  expect(
    selectEntries(
      "http=h.example:3128;socks=s.example",
      null,
      new URL("http://x.example/"),
    ),
  ).toEqual([
    proxy("h.example", 3128),
  ]);
  // Only an http rule exists: https goes direct.
  expect(
    selectEntries("http=h.example:80", null, new URL("https://x.example/")),
  ).toEqual([
    direct(),
  ]);
  expect(
    selectEntries(
      "a.example:80;a.example:80",
      null,
      new URL("http://x.example/"),
    ),
  ).toEqual([
    proxy("a.example", 80),
  ]);
  expect(selectEntries(null, null, new URL("http://x.example/"))).toEqual([
    direct(),
  ]);
  expect(selectEntries("   ;; ", null, new URL("http://x.example/"))).toEqual([
    direct(),
  ]);
  expect(
    selectEntries("a.example:80", "*.example", new URL("http://x.example/")),
  ).toEqual([
    direct(),
  ]);
  const many = Array.from(
    {
      length: MAX_PROXY_ENTRIES + 5,
    },
    (_, index) => `p${index}.example:80`,
  ).join(";");
  expect(selectEntries(many, null, new URL("http://x.example/"))).toHaveLength(
    MAX_PROXY_ENTRIES,
  );
});

test("no settings or no proxy configured resolves direct without a WinHTTP session", async () => {
  for (const config of [
    null,
    {},
    {
      bypass: "*",
    },
  ]) {
    const { api, lookups } = fakeApi(config);
    expect(await resolveProxy(api, "https://example.com/", 1000, live)).toEqual(
      [
        direct(),
      ],
    );
    expect(lookups).toEqual([]);
  }
});

test("a manual proxy list applies with its bypass list", async () => {
  const { api, lookups } = fakeApi({
    proxy: "http=web.example:3128;https=secure.example:3129",
    bypass: "<local>;*.corp.example",
  });
  expect(await resolveProxy(api, "http://example.com/", 1000, live)).toEqual([
    proxy("web.example", 3128),
  ]);
  expect(await resolveProxy(api, "https://example.com/", 1000, live)).toEqual([
    proxy("secure.example", 3129),
  ]);
  expect(
    await resolveProxy(api, "https://host.corp.example/", 1000, live),
  ).toEqual([
    direct(),
  ]);
  expect(await resolveProxy(api, "http://intranet/", 1000, live)).toEqual([
    direct(),
  ]);
  expect(lookups).toEqual([]);
});

test("loopback URLs go direct even when a proxy and a script are configured", async () => {
  const { api, lookups } = fakeApi({
    autoDetect: true,
    autoConfigUrl: "http://pac.example/proxy.pac",
    proxy: "p.example:80",
  });
  for (const url of [
    "http://localhost:3000/",
    "https://127.0.0.1/",
    "http://[::1]/",
  ]) {
    expect(await resolveProxy(api, url, 1000, live)).toEqual([
      direct(),
    ]);
  }
  expect(lookups).toEqual([]);
});

test("automatic detection that names a proxy wins over the manual list", async () => {
  const { api, lookups } = fakeApi(
    {
      autoDetect: true,
      proxy: "manual.example:80",
    },
    () => ({
      accessType: NAMED,
      proxy: "pac.example:8080",
      bypass: null,
    }),
  );
  expect(
    await resolveProxy(api, "http://example.com/a?b=1", 1000, live),
  ).toEqual([
    proxy("pac.example", 8080),
  ]);
  expect(lookups).toEqual([
    {
      url: "http://example.com/a?b=1",
      source: {
        kind: "detect",
      },
      timeoutMs: 1000,
    },
  ]);
});

test("a script that selects no proxy resolves direct", async () => {
  const { api } = fakeApi(
    {
      autoConfigUrl: "http://pac.example/proxy.pac",
      proxy: "manual.example:80",
    },
    () => ({
      accessType: NO_PROXY,
      proxy: null,
      bypass: null,
    }),
  );
  expect(await resolveProxy(api, "http://example.com/", 1000, live)).toEqual([
    direct(),
  ]);
});

test("a failed detection falls through to the script, then to the manual list", async () => {
  const { api, lookups } = fakeApi(
    {
      autoDetect: true,
      autoConfigUrl: "http://pac.example/proxy.pac",
      proxy: "manual.example:80",
    },
    (_url, source) =>
      source.kind === "detect"
        ? ERROR_AUTODETECTION_FAILED
        : ERROR_UNABLE_TO_DOWNLOAD_SCRIPT,
  );
  expect(await resolveProxy(api, "http://example.com/", 1000, live)).toEqual([
    proxy("manual.example", 80),
  ]);
  expect(lookups.map((lookup) => lookup.source)).toEqual([
    {
      kind: "detect",
    },
    {
      kind: "script",
      url: "http://pac.example/proxy.pac",
    },
  ]);
  // Nothing else configured: automatic configuration that fails means a direct connection.
  const bare = fakeApi({
    autoDetect: true,
  });
  expect(
    await resolveProxy(bare.api, "http://example.com/", 1000, live),
  ).toEqual([
    direct(),
  ]);
});

test("the script sees no credentials, fragment or https path", async () => {
  const { api, lookups } = fakeApi({
    autoDetect: true,
  });
  await resolveProxy(
    api,
    "https://example.com:8443/private/path?token=abc",
    1000,
    live,
  );
  await resolveProxy(api, "http://example.com/path?q=1", 1000, live);
  expect(lookups.map((lookup) => lookup.url)).toEqual([
    "https://example.com:8443/",
    "http://example.com/path?q=1",
  ]);
});

test("a source that fails with any error falls through to the manual list", async () => {
  const { api } = fakeApi(
    {
      autoDetect: true,
      autoConfigUrl: "proxy.corp/pac",
      proxy: "manual.example:80",
    },
    () => ERROR_INVALID_URL,
  );
  expect(await resolveProxy(api, "http://example.com/", 1000, live)).toEqual([
    proxy("manual.example", 80),
  ]);
});

test("the deadline is spent across automatic steps", async () => {
  let clock = 0;
  const { api, lookups } = fakeApi(
    {
      autoDetect: true,
      autoConfigUrl: "http://pac.example/proxy.pac",
    },
    () => {
      clock += 700;
      return ERROR_AUTODETECTION_FAILED;
    },
  );
  expect(
    await resolveProxy(api, "http://example.com/", 1000, live, () => clock),
  ).toEqual([
    direct(),
  ]);
  expect(lookups.map((lookup) => lookup.timeoutMs)).toEqual([
    1000,
    300,
  ]);
  clock = 0;
  const slow = fakeApi(
    {
      autoDetect: true,
      autoConfigUrl: "http://pac.example/proxy.pac",
    },
    () => {
      clock += 1000;
      return ERROR_AUTODETECTION_FAILED;
    },
  );
  await expect(
    resolveProxy(slow.api, "http://example.com/", 1000, live, () => clock),
  ).rejects.toMatchObject({
    code: "TIMEOUT",
  });
  expect(slow.lookups).toHaveLength(1);
});

test("a cancelled call asks WinHTTP nothing", async () => {
  const { api, lookups } = fakeApi({
    autoDetect: true,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    resolveProxy(api, "http://example.com/", 1000, controller.signal),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(lookups).toEqual([]);
});

test("the operation validates the result and frees its slot", async () => {
  const state = initialize();
  const { api } = fakeApi({
    proxy: "proxy.example:8080",
  });
  const input = resolveProxyInputSchema.parse({
    url: "https://example.com/",
  });
  const result = await runResolveProxy(state, input, undefined, () => api);
  expect(resolveProxyResultSchema.parse(result)).toEqual({
    entries: [
      proxy("proxy.example", 8080),
    ],
  });
  expect(state.active.size).toBe(0);
  await expect(
    runResolveProxy(state, input, AbortSignal.abort(), () => api),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(state.active.size).toBe(0);
  await dispose(state);
  await expect(
    runResolveProxy(state, input, undefined, () => api),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  // Repeated cleanup is safe.
  await dispose(state);
});

test("a lookup failure surfaces as a bounded internal error", async () => {
  const state = initialize();
  const input = resolveProxyInputSchema.parse({
    url: "https://example.com/",
  });
  await expect(
    runResolveProxy(state, input, undefined, () => {
      throw new Error("C:\\secret\\path failed");
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Network request failed.",
  });
  await dispose(state);
});

test("macOS declares the operation and reports it as unsupported", () => {
  const operation = macosOperations.resolveProxy;
  expect(operation).toBeDefined();
  expect(() =>
    (
      operation as unknown as {
        handler: () => unknown;
      }
    ).handler(),
  ).toThrowError(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
});

/** A worker that answers with the request, after an optional delay, never when told to hang. */
const ECHO_WORKER = `
self.onmessage = (event) => {
  if (event.data.hang) {
    return;
  }
  if (event.data.crash) {
    throw new Error("boom");
  }
  setTimeout(
    () => postMessage({ echoed: event.data.value }),
    event.data.delayMs ?? 0,
  );
};
`;

function request(
  message: unknown,
  signal: AbortSignal,
  workers: Set<Worker>,
  limit = 2,
) {
  return requestFromWorker({
    source: ECHO_WORKER,
    request: message,
    signal,
    workers,
    limit,
  });
}

test("a worker request returns the reply and frees its slot", async () => {
  const workers = new Set<Worker>();
  await expect(
    request(
      {
        value: 7,
      },
      live,
      workers,
    ),
  ).resolves.toEqual({
    echoed: 7,
  });
  expect(workers.size).toBe(0);
});

test("an aborted request rejects at once but keeps its slot until the worker replies", async () => {
  const workers = new Set<Worker>();
  const controller = new AbortController();
  const pending = request(
    {
      value: 1,
      delayMs: 300,
    },
    controller.signal,
    workers,
    1,
  );
  expect(workers.size).toBe(1);
  controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");
  // The worker is still busy, so the limit still counts it.
  expect(workers.size).toBe(1);
  await expect(
    request(
      {
        value: 2,
      },
      live,
      workers,
      1,
    ),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  await waitFor(() => workers.size === 0, {
    deadline: "childStep",
    what: "the aborted worker to reply and retire",
  });
  await expect(
    request(
      {
        value: 3,
      },
      live,
      workers,
      1,
    ),
  ).resolves.toEqual({
    echoed: 3,
  });
  await expect(
    request(
      {
        value: 4,
      },
      AbortSignal.abort(),
      workers,
    ),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(workers.size).toBe(0);
});

test("a crashing worker is an internal error", async () => {
  const workers = new Set<Worker>();
  await expect(
    request(
      {
        crash: true,
      },
      live,
      workers,
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  await waitFor(() => workers.size === 0, {
    deadline: "childStep",
    what: "the crashed worker to retire",
  });
});

test("a hung worker holds its slot until the owner terminates it", async () => {
  const workers = new Set<Worker>();
  const controller = new AbortController();
  const first = request(
    {
      hang: true,
    },
    controller.signal,
    workers,
    1,
  );
  controller.abort(new Error("stop"));
  await expect(first).rejects.toThrow("stop");
  expect(workers.size).toBe(1);
  for (const worker of workers) {
    const closed = new Promise<void>((resolve) => {
      worker.addEventListener("close", () => resolve());
    });
    void worker.terminate();
    await closed;
  }
  // Termination retires the worker and frees its slot.
  await waitFor(() => workers.size === 0, {
    deadline: "childStep",
    what: "the terminated worker to retire",
  });
});

test("startWorker runs module source without a file", async () => {
  const { worker, release } = startWorker(ECHO_WORKER);
  const reply = new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
  });
  worker.postMessage({
    value: "inline",
  });
  await expect(reply).resolves.toEqual({
    echoed: "inline",
  });
  release();
  await worker.terminate();
});

test("dispose terminates workers that are still running", async () => {
  const state = initialize();
  const controller = new AbortController();
  const pending = requestFromWorker({
    source: ECHO_WORKER,
    request: {
      hang: true,
    },
    signal: controller.signal,
    workers: state.winhttp.workers,
    limit: 2,
  });
  controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");
  expect(state.winhttp.workers.size).toBe(1);
  const [worker] = state.winhttp.workers;
  assert(worker);
  const closed = new Promise<void>((resolve) => {
    worker.addEventListener("close", () => resolve());
  });
  await dispose(state);
  expect(state.winhttp.workers.size).toBe(0);
  // The worker thread really ended, not only the bookkeeping.
  await closed;
});

test("the deadline ends a lookup that never answers", async () => {
  const state = initialize();
  const stuck: WinHttpApi = {
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
  };
  const input = resolveProxyInputSchema.parse({
    url: "https://example.com/",
    timeoutMs: 50,
  });
  await expect(
    runResolveProxy(state, input, undefined, () => stuck),
  ).rejects.toMatchObject({
    code: "TIMEOUT",
  });
  expect(state.active.size).toBe(0);
  await dispose(state);
});

test("a worker reply is a result, an error code or a failed lookup", () => {
  expect(
    parseReply({
      error: 12180,
    }),
  ).toBe(12180);
  expect(
    parseReply({
      found: {
        accessType: 3,
        proxy: "p:80",
        bypass: null,
      },
    }),
  ).toEqual({
    accessType: 3,
    proxy: "p:80",
    bypass: null,
  });
  for (const reply of [
    {
      fail: "Windows proxy lookup could not start.",
    },
    {
      found: {
        accessType: "3",
        proxy: null,
        bypass: null,
      },
    },
    {
      found: {
        accessType: 3,
        proxy: 5,
        bypass: null,
      },
    },
    {
      found: {
        accessType: 3,
        proxy: null,
      },
    },
    {
      found: null,
    },
    "text",
    null,
  ]) {
    expect(() => parseReply(reply)).toThrowError(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }
});

test("the worker module source is valid JavaScript", () => {
  const transpiler = new Bun.Transpiler({
    loader: "js",
  });
  expect(() =>
    transpiler.transformSync(AUTO_PROXY_WORKER_SOURCE),
  ).not.toThrow();
});
