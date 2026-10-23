import { expect, test } from "bun:test";
import type { NativeEnvironment } from "@bunaway/plugin";
import updaterPlugin from "@bunaway/plugin-updater/native/windows";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import { createUpdater } from "#plugins/updater/src/adapter";
import { MAX_MANIFEST_BYTES } from "#plugins/updater/src/contract";
import { validateEndpointTemplate } from "#plugins/updater/src/endpoint";
import { compareSemVer, parseSemVer } from "#plugins/updater/src/semver";

function semver(text: string) {
  const parsed = parseSemVer(text);
  if (!parsed) {
    throw new Error(`Expected a SemVer version: ${text}`);
  }
  return parsed;
}

const ENDPOINT =
  "https://updates.example.com/{{target}}/{{arch}}/{{channel}}?v={{current_version}}";

function environment(
  settings: unknown,
  version: string | null = "1.0.0",
  mode: "development" | "packaged" = "packaged",
): NativeEnvironment {
  return {
    dataRoot: "C:\\data",
    capabilities: [],
    app: {
      id: "com.example.app",
      version,
      ...(settings === undefined
        ? {}
        : {
            pluginSettings: {
              updater: settings as never,
            },
          }),
      launch: {
        mode,
        executablePath: "C:\\App.exe",
        args: [],
      },
    },
  };
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function updater(
  handler: Handler,
  options: {
    settings?: unknown;
    version?: string | null;
    mode?: "development" | "packaged";
    arch?: string;
    timeoutMs?: number;
  } = {},
) {
  const requests: string[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    requests.push(String(input));
    return handler(new URL(String(input)), init);
  }) as unknown as typeof fetch;
  const instance = createUpdater(
    "windows",
    options.arch ?? "x64",
    environment(
      "settings" in options
        ? options.settings
        : {
            endpoint: ENDPOINT,
          },
      options.version === undefined ? "1.0.0" : options.version,
      options.mode,
    ),
    {
      fetchImpl,
      ...(options.timeoutMs === undefined
        ? {}
        : {
            timeoutMs: options.timeoutMs,
          }),
    },
  );
  return {
    instance,
    requests,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

async function failure(promise: Promise<unknown>): Promise<BunawayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    return error as BunawayError;
  }
  throw new Error("Expected the check to fail.");
}

const manifest = {
  version: "1.2.0",
  notes: "Fixes",
  pub_date: "2026-10-20T09:00:00+09:00",
  platforms: {
    "windows-x86_64": {
      url: "https://downloads.example.com/app-1.2.0.exe",
      signature: "ignored",
    },
  },
};

test("a newer manifest version reports an update with notes, date and download URL", async () => {
  const { instance, requests } = updater(() => json(manifest));
  expect(await instance.check()).toEqual({
    updateAvailable: true,
    currentVersion: "1.0.0",
    version: "1.2.0",
    notes: "Fixes",
    publishedAt: "2026-10-20T00:00:00.000Z",
    downloadUrl: "https://downloads.example.com/app-1.2.0.exe",
  });
  expect(requests).toEqual([
    "https://updates.example.com/windows/x86_64/stable?v=1.0.0",
  ]);
});

test("equal, older and 204 answers report no update", async () => {
  for (const response of [
    () =>
      json({
        ...manifest,
        version: "1.0.0",
      }),
    () =>
      json({
        ...manifest,
        version: "0.9.0",
      }),
    () =>
      new Response(null, {
        status: 204,
      }),
  ]) {
    const { instance } = updater(response);
    expect(await instance.check()).toEqual({
      updateAvailable: false,
      currentVersion: "1.0.0",
      version: null,
      notes: null,
      publishedAt: null,
      downloadUrl: null,
    });
  }
});

test("a dynamic response with a top-level url is accepted", async () => {
  const { instance } = updater(() =>
    json({
      version: "2.0.0",
      url: "https://downloads.example.com/a.exe",
    }),
  );
  expect((await instance.check()).downloadUrl).toBe(
    "https://downloads.example.com/a.exe",
  );
});

test("channel and build values are encoded into the request URL", async () => {
  const { instance, requests } = updater(
    () =>
      new Response(null, {
        status: 204,
      }),
    {
      settings: {
        endpoint: ENDPOINT,
        channel: "beta-2",
      },
      version: "1.0.0-rc.1+build.5",
      arch: "arm64",
    },
  );
  await instance.check();
  expect(requests).toEqual([
    "https://updates.example.com/windows/aarch64/beta-2?v=1.0.0-rc.1%2Bbuild.5",
  ]);
});

test("SemVer precedence follows the specification", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
    "10.0.0",
  ].map(semver);
  for (let index = 1; index < ordered.length; index++) {
    expect(
      compareSemVer(ordered[index - 1] as never, ordered[index] as never),
    ).toBe(-1);
    expect(
      compareSemVer(ordered[index] as never, ordered[index - 1] as never),
    ).toBe(1);
  }
  expect(compareSemVer(semver("1.0.0+a"), semver("1.0.0+b"))).toBe(0);
});

test("SemVer rejects loose forms", () => {
  for (const text of [
    "v1.0.0",
    "1.0",
    "01.0.0",
    "1.0.0-",
    "1.0.0-01",
    "1.0.0-a..b",
    "1.0.0+",
    "1.0.0 ",
    `1.0.0-${"a".repeat(260)}`,
  ]) {
    expect(parseSemVer(text)).toBeNull();
  }
});

test("a missing or invalid app version is UNSUPPORTED with a reason", async () => {
  for (const [version, reason] of [
    [
      null,
      "appVersionMissing",
    ],
    [
      "v1.0",
      "appVersionInvalid",
    ],
  ] as const) {
    const { instance, requests } = updater(() => json(manifest), {
      version,
    });
    const error = await failure(instance.check());
    expect(error.code).toBe("UNSUPPORTED");
    expect(error.details).toEqual({
      reason,
    });
    expect(requests).toEqual([]);
  }
});

test("an app without updater settings reports notConfigured, and an unsupported CPU is refused", async () => {
  const none = updater(() => json(manifest), {
    settings: undefined,
  });
  const missing = await failure(none.instance.check());
  expect(missing.code).toBe("UNSUPPORTED");
  expect(missing.details).toEqual({
    reason: "notConfigured",
  });
  const odd = updater(() => json(manifest), {
    arch: "ia32",
  });
  expect((await failure(odd.instance.check())).details).toEqual({
    reason: "unsupportedArch",
  });
});

test("invalid settings fail when the adapter is created", () => {
  for (const settings of [
    "https://updates.example.com",
    {},
    {
      endpoint: "https://updates.example.com",
      extra: 1,
    },
    {
      endpoint: "https://updates.example.com",
      channel: "Beta",
    },
    {
      endpoint: "http://updates.example.com/",
    },
    {
      endpoint: "ftp://updates.example.com/",
    },
    {
      endpoint: "https://user:pw@updates.example.com/",
    },
    {
      endpoint: "https://{{channel}}.example.com/",
    },
    {
      endpoint: "{{target}}://updates.example.com/",
    },
    {
      endpoint: "https://updates.example.com/{{version}}",
    },
    {
      endpoint: "https://updates.example.com/#{{target}}",
    },
    {
      endpoint: "updates.example.com/path",
    },
    {
      // An empty host would let the first placeholder become the host.
      endpoint: "https:///{{channel}}.example.com/x",
    },
    {
      endpoint: "https:////{{target}}/x",
    },
    {
      // The URL parser deletes tabs and line breaks, which would leave the host empty.
      endpoint: "https://\t/{{channel}}/m",
    },
    {
      endpoint: "https://\n/{{target}}",
    },
    {
      endpoint: "https://\r\n/{{channel}}.json",
    },
    {
      endpoint: "https://updates.example.com/a b",
    },
    {
      // Mixed slashes and backslashes are skipped by the URL parser before the host.
      endpoint: "https://\\/{{channel}}/m",
    },
    {
      endpoint: "https:/\\{{current_version}}/m",
    },
    {
      endpoint: "https://\\{{target}}",
    },
    {
      // Longest values would push the address past the length limit at check time.
      endpoint: `https://updates.example.com/${"{{current_version}}".repeat(20)}`,
    },
  ]) {
    expect(() =>
      createUpdater("windows", "x64", environment(settings)),
    ).toThrow(BunawayError);
  }
});

test("http is allowed only for loopback hosts of a development launch", async () => {
  const local = {
    endpoint: "http://127.0.0.1:5000/{{target}}",
  };
  expect(() =>
    createUpdater("windows", "x64", environment(local, "1.0.0", "packaged")),
  ).toThrow(BunawayError);
  expect(() =>
    createUpdater("windows", "x64", environment(local, "1.0.0", "development")),
  ).not.toThrow();
  expect(() =>
    validateEndpointTemplate("http://updates.example.com/", true),
  ).toThrow(BunawayError);
  expect(() =>
    validateEndpointTemplate("http://[::1]:5000/", true),
  ).not.toThrow();
});

test("redirects are followed up to three hops and never leave https", async () => {
  let hops = 0;
  const redirecting = (count: number, to = "https://cdn.example.com/m.json") =>
    updater((url) => {
      if (
        url.pathname.startsWith("/hop") ||
        url.hostname === "updates.example.com"
      ) {
        hops++;
        return hops <= count
          ? new Response(null, {
              status: 302,
              headers: {
                location: hops === count ? to : `/hop${hops}`,
              },
            })
          : json(manifest);
      }
      return json(manifest);
    });
  hops = 0;
  expect((await redirecting(3).instance.check()).updateAvailable).toBe(true);
  hops = 0;
  const tooMany = await failure(redirecting(4, "/hop5").instance.check());
  expect(tooMany.details).toEqual({
    reason: "redirectLimit",
  });
  hops = 0;
  const downgrade = await failure(
    redirecting(1, "http://updates.example.com/m.json").instance.check(),
  );
  expect(downgrade.details).toEqual({
    reason: "redirectScheme",
  });
  const noLocation = await failure(
    updater(
      () =>
        new Response(null, {
          status: 302,
        }),
    ).instance.check(),
  );
  expect(noLocation.details).toEqual({
    reason: "httpStatus",
    status: 302,
  });
});

test("a redirect to another https host is allowed", async () => {
  const { instance, requests } = updater((url) =>
    url.hostname === "updates.example.com"
      ? new Response(null, {
          status: 301,
          headers: {
            location: "https://cdn.example.net/m.json",
          },
        })
      : json(manifest),
  );
  await instance.check();
  expect(requests.at(-1)).toBe("https://cdn.example.net/m.json");
});

test("the manifest body is limited by streamed size", async () => {
  const padded = (size: number) =>
    JSON.stringify({
      version: "1.0.0",
      pad: "",
    }).replace('"pad":""', `"pad":"${"x".repeat(size)}"`);
  const exact = padded(0);
  const fill = MAX_MANIFEST_BYTES - exact.length;
  const stream = (text: string) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(text);
          for (let offset = 0; offset < bytes.length; offset += 1000) {
            controller.enqueue(bytes.slice(offset, offset + 1000));
          }
          controller.close();
        },
      }),
    );
  expect(
    (await updater(() => stream(padded(fill))).instance.check())
      .updateAvailable,
  ).toBe(false);
  const error = await failure(
    updater(() => stream(padded(fill + 1))).instance.check(),
  );
  expect(error.details).toEqual({
    reason: "tooLarge",
  });
});

/** A real loopback server, which a development launch may use over http. */
function localUpdater(
  handler: (request: Request) => Response,
  timeoutMs?: number,
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  const instance = createUpdater(
    "windows",
    "x64",
    environment(
      {
        endpoint: `http://127.0.0.1:${server.port}/{{target}}`,
      },
      "1.0.0",
      "development",
    ),
    timeoutMs === undefined
      ? {}
      : {
          timeoutMs,
        },
  );
  return {
    instance,
    stop: () => server.stop(true),
  };
}

test("the limit applies to the body after it is decompressed", async () => {
  const body = JSON.stringify({
    version: "1.0.0",
    pad: "x".repeat(MAX_MANIFEST_BYTES * 4),
  });
  const compressed = Bun.gzipSync(body);
  // The compressed form is far below the limit; only the decompressed size exceeds it.
  expect(compressed.byteLength).toBeLessThan(MAX_MANIFEST_BYTES);
  const { instance, stop } = localUpdater(
    () =>
      new Response(compressed, {
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
      }),
  );
  try {
    expect((await failure(instance.check())).details).toEqual({
      reason: "tooLarge",
    });
  } finally {
    await stop();
  }
});

test("a server that stalls while sending the body times out", async () => {
  const { instance, stop } = localUpdater(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":'));
          },
        }),
      ),
    200,
  );
  try {
    expect((await failure(instance.check())).code).toBe("TIMEOUT");
  } finally {
    await stop();
  }
});

test("a stalled server times out and a cancelled call is CANCELLED", async () => {
  const hang: Handler = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  const timed = await failure(
    updater(hang, {
      timeoutMs: 20,
    }).instance.check(),
  );
  expect(timed.code).toBe("TIMEOUT");
  const controller = new AbortController();
  const { instance } = updater(hang);
  const pending = failure(instance.check(controller.signal));
  controller.abort();
  expect((await pending).code).toBe("CANCELLED");
  const closing = updater(hang);
  const late = failure(closing.instance.check());
  await closing.instance.dispose();
  expect((await late).code).toBe("CANCELLED");
  expect((await failure(closing.instance.check())).code).toBe("CANCELLED");
});

test("malformed manifests are INTERNAL with a reason and never echo the response", async () => {
  const cases: [
    Handler,
    string,
  ][] = [
    [
      () => new Response("<html>secret-body</html>"),
      "invalidJson",
    ],
    [
      () =>
        json([
          1,
        ]),
      "invalidManifest",
    ],
    [
      () => json("text"),
      "invalidManifest",
    ],
    [
      () =>
        json({
          platforms: {},
        }),
      "invalidVersion",
    ],
    [
      () =>
        json({
          version: "latest",
        }),
      "invalidVersion",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          platforms: {},
        }),
      "platformMissing",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          platforms: [],
        }),
      "invalidManifest",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          url: "http://downloads.example.com/a",
        }),
      "invalidManifest",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          url: "https://u:p@downloads.example.com/a",
        }),
      "invalidManifest",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          url: `https://example.com/${"a".repeat(2100)}`,
        }),
      "invalidManifest",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          url: "https://example.com/a",
          notes: "a\u0000b",
        }),
      "invalidManifest",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          url: "https://example.com/a",
          notes: "x".repeat(16_385),
        }),
      "invalidManifest",
    ],
    [
      () =>
        json({
          version: "2.0.0",
          url: "https://example.com/a",
          pub_date: "yesterday",
        }),
      "invalidManifest",
    ],
    ...[
      "2024-02-31T00:00:00Z",
      "2023-02-29T00:00:00Z",
      "2024-13-01T00:00:00Z",
      "2024-01-01T24:00:00Z",
      "2024-01-01T00:60:00Z",
      "2024-01-01T00:00:60Z",
      "2024-01-01T00:00:00+24:00",
      "9999-12-31T23:00:00-02:00",
      "0000-01-01T00:00:00+02:00",
    ].map(
      (
        pub_date,
      ): [
        Handler,
        string,
      ] => [
        () =>
          json({
            version: "2.0.0",
            url: "https://example.com/a",
            pub_date,
          }),
        "invalidManifest",
      ],
    ),
    [
      // Percent-encoding lengthens the address past the limit that the raw text met.
      () =>
        json({
          version: "2.0.0",
          url: `https://example.com/${"é".repeat(2000)}`,
        }),
      "invalidManifest",
    ],
    ...[
      "a\u009bb",
      "a\u0085b",
      "a\u007fb",
    ].map(
      (
        notes,
      ): [
        Handler,
        string,
      ] => [
        () =>
          json({
            version: "2.0.0",
            url: "https://example.com/a",
            notes,
          }),
        "invalidManifest",
      ],
    ),
  ];
  for (const [handler, reason] of cases) {
    const error = await failure(updater(handler).instance.check());
    expect(error.code).toBe("INTERNAL");
    expect(error.details).toEqual({
      reason,
    });
    expect(error.message).not.toContain("secret-body");
    expect(error.message).not.toContain("updates.example.com");
  }
});

test("existing dates and offsets are normalized to UTC", async () => {
  for (const [pub_date, expected] of [
    [
      "2024-02-29T23:30:00-02:00",
      "2024-03-01T01:30:00.000Z",
    ],
    [
      "2024-12-31T23:59:59.5Z",
      "2024-12-31T23:59:59.500Z",
    ],
    [
      "2024-01-01t00:00:00z",
      "2024-01-01T00:00:00.000Z",
    ],
    [
      "0050-01-01T00:00:00Z",
      "0050-01-01T00:00:00.000Z",
    ],
  ] as const) {
    const { instance } = updater(() =>
      json({
        version: "2.0.0",
        url: "https://example.com/a",
        pub_date,
      }),
    );
    expect((await instance.check()).publishedAt).toBe(expected);
  }
});

test("notes keep tabs and line breaks and may be at the length limit", async () => {
  const notes = `${"a\tb\r\n".repeat(10)}${"x".repeat(16_384 - 50)}`;
  const { instance } = updater(() =>
    json({
      version: "2.0.0",
      url: "https://example.com/a",
      notes,
    }),
  );
  expect((await instance.check()).notes).toBe(notes);
});

test("error statuses and connection failures are classified without the URL", async () => {
  for (const status of [
    404,
    500,
  ]) {
    const error = await failure(
      updater(
        () =>
          new Response("nope", {
            status,
          }),
      ).instance.check(),
    );
    expect(error.details).toEqual({
      reason: "httpStatus",
      status,
    });
    expect(error.message).not.toContain("example.com");
  }
  const network = await failure(
    updater(() => {
      throw new TypeError("connect ECONNREFUSED updates.example.com");
    }).instance.check(),
  );
  expect(network.details).toEqual({
    reason: "network",
  });
  expect(network.message).not.toContain("ECONNREFUSED");
});

test("the registered plugin exposes the check, download and downloadStatus operations with a null input and reads the host environment", async () => {
  const registry = new NativeRegistry([
    updaterPlugin._definition,
  ]);
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "updater.check",
    "updater.download",
    "updater.downloadStatus",
  ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 204,
      }),
  });
  const adapter = updaterPlugin._definition.nativePlatforms.windows?.create(
    environment(
      {
        endpoint: `http://127.0.0.1:${server.port}/`,
      },
      "1.0.0",
      "development",
    ),
  );
  if (!adapter) {
    throw new Error("Missing Windows adapter.");
  }
  try {
    expect(await adapter.execute("updater.check", null, "backend")).toEqual({
      updateAvailable: false,
      currentVersion: "1.0.0",
      version: null,
      notes: null,
      publishedAt: null,
      downloadUrl: null,
    });
    // The caller cannot pick an address: any input other than null is refused.
    await expect(
      adapter.execute(
        "updater.check",
        {
          url: "https://evil.example/",
        },
        "backend",
      ),
    ).rejects.toThrow();
  } finally {
    await adapter.dispose();
    await server.stop(true);
  }
});
