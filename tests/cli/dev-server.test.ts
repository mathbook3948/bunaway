import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { readDevSettings } from "#cli/config";
import { startDevServer } from "#cli/dev-server";
import type { Policy } from "@bunaway/protocol";
import {
  developmentPolicy,
  verifyDevelopmentLaunch,
} from "@bunaway/runtime-bun/development";

/** Gets an available loopback port for a child process fixture. */
function availablePort(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port;
  server.stop(true);
  if (!port) {
    throw new Error("No test port.");
  }
  return port;
}

/** Builds settings that launch the requested server fixture on loopback. */
function config(mode: string, childPort?: number) {
  const port = availablePort();
  return {
    command: [
      process.execPath,
      resolve(import.meta.dir, "dev-server.fixture.ts"),
      String(port),
      mode,
      ...(childPort
        ? [
            String(childPort),
          ]
        : []),
    ],
    url: `http://127.0.0.1:${port}/`,
    timeoutMs: 5000,
  };
}

async function reachable(port: number): Promise<boolean> {
  try {
    return (
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(200),
      })
    ).ok;
  } catch {
    return false;
  }
}

test("dev settings reject remote origins, unsafe URLs, shell strings and invalid timeouts", () => {
  expect(readDevSettings(undefined)).toBeUndefined();
  const base = {
    command: [
      "bun",
      "run",
      "web:dev",
    ],
    url: "http://localhost:5173",
  };
  expect(readDevSettings(base)).toEqual({
    ...base,
    url: "http://localhost:5173/",
    timeoutMs: 30000,
  });
  for (const invalid of [
    null,
    [],
    {
      ...base,
      command: "bun run web:dev",
    },
    {
      ...base,
      command: [],
    },
    {
      ...base,
      command: [
        "bun",
        123,
      ],
    },
    {
      ...base,
      command: [
        "bun\0",
      ],
    },
    {
      ...base,
      timeoutMs: 0,
    },
    {
      ...base,
      timeoutMs: 300001,
    },
    {
      ...base,
      unexpected: true,
    },
    ...[
      "https://example.com",
      "http://localhost.example.com",
      "http://192.168.1.1",
      "file:///tmp/ui",
      "http://user@localhost:5173",
      "http://localhost:5173/#x",
    ].map((url) => ({
      ...base,
      url,
    })),
  ]) {
    expect(() => readDevSettings(invalid)).toThrow();
  }
});

test("development policy preserves grants and needs a matching artifact and launch flag", () => {
  const policy = {
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [
          "echo",
        ],
        events: [],
        host: {
          permissions: [],
        },
      },
    ],
    backend: {
      permissions: [],
    },
  } as Policy;
  const url = "http://127.0.0.1:5173/";
  const development = developmentPolicy(policy, "main", url);
  expect(development.views[0]?.origins).toEqual([
    "http://127.0.0.1:5173",
  ]);
  expect(development.views[0]?.commands).toEqual([
    "echo",
  ]);
  expect(policy.views[0]?.origins).toEqual([
    "https://app.bunaway.local",
  ]);
  expect(verifyDevelopmentLaunch(undefined)).toBeUndefined();
  expect(
    verifyDevelopmentLaunch(
      {
        url,
      },
      url,
    ),
  ).toBe(url);
  for (const [marker, launch] of [
    [
      {
        url,
      },
      undefined,
    ],
    [
      undefined,
      url,
    ],
    [
      {
        url,
      },
      "http://127.0.0.1:5174/",
    ],
    [
      {
        url,
        extra: true,
      },
      url,
    ],
  ] as const) {
    expect(() => verifyDevelopmentLaunch(marker, launch)).toThrow();
  }
});

test("managed server waits for readiness and closes its process tree on stop", async () => {
  const childPort = availablePort();
  const settings = config("delayed", childPort);
  const started = Date.now();
  const server = await startDevServer(
    settings,
    import.meta.dir,
    new AbortController().signal,
  );
  try {
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect((await fetch(settings.url)).ok).toBe(true);
    expect(await reachable(childPort)).toBe(true);
  } finally {
    await server.stop();
  }
  expect(await reachable(childPort)).toBe(false);
  await server.stop();
}, 10000);

test("an existing listener is rejected rather than adopted as the application's server", async () => {
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unrelated"),
  });
  try {
    await expect(
      startDevServer(
        {
          ...config("ready"),
          url: listener.url.href,
        },
        import.meta.dir,
        new AbortController().signal,
      ),
    ).rejects.toThrow("already in use");
    expect((await fetch(listener.url)).ok).toBe(true);
  } finally {
    listener.stop(true);
  }
});

test("server replacement can immediately reuse a port held by a descendant", async () => {
  const childPort = availablePort();
  const first = await startDevServer(
    config("ready", childPort),
    import.meta.dir,
    new AbortController().signal,
  );
  try {
    expect(await reachable(childPort)).toBe(true);
  } finally {
    await first.stop();
  }
  const settings = config("ready");
  settings.command[2] = String(childPort);
  settings.url = `http://127.0.0.1:${childPort}/`;
  const replacement = await startDevServer(
    settings,
    import.meta.dir,
    new AbortController().signal,
  );
  try {
    expect(await reachable(childPort)).toBe(true);
  } finally {
    await replacement.stop();
  }
}, 15000);

test("early exit reports the exit code and terminates descendants", async () => {
  const childPort = availablePort();
  await expect(
    startDevServer(
      config("exit-tree", childPort),
      import.meta.dir,
      new AbortController().signal,
    ),
  ).rejects.toThrow("exit 7");
  expect(await reachable(childPort)).toBe(false);
}, 10000);

test("exit during an HTTP readiness probe preserves the command's exit code", async () => {
  const childPort = availablePort();
  const probe = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        // Keep the probe pending through the fixture's exit, as a Windows connection failure can be.
        await Bun.sleep(1000);
        throw new Error("Delayed readiness connection failure.");
      },
      {
        preconnect: fetch.preconnect,
      },
    ),
  );
  try {
    await expect(
      startDevServer(
        config("exit-tree", childPort),
        import.meta.dir,
        new AbortController().signal,
      ),
    ).rejects.toThrow("exit 7");
    expect(probe).toHaveBeenCalled();
  } finally {
    probe.mockRestore();
  }
  expect(await reachable(childPort)).toBe(false);
}, 10000);

test.each([
  "timeout",
  "redirect",
])(
  "%s is not readiness and cleans up after timeout",
  async (mode) => {
    const settings = {
      ...config(mode),
      timeoutMs: 800,
    };
    await expect(
      startDevServer(settings, import.meta.dir, new AbortController().signal),
    ).rejects.toThrow("did not return HTTP 2xx");
    expect(await reachable(Number(new URL(settings.url).port))).toBe(false);
  },
  10000,
);

test("startup cancellation and cancellation after readiness both stop the server", async () => {
  const settings = config("timeout");
  const abort = new AbortController();
  const starting = startDevServer(settings, import.meta.dir, abort.signal);
  const timer = setTimeout(() => abort.abort(), 200);
  try {
    await expect(starting).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
  expect(await reachable(Number(new URL(settings.url).port))).toBe(false);
  const runningAbort = new AbortController();
  const running = await startDevServer(
    config("ready"),
    import.meta.dir,
    runningAbort.signal,
  );
  runningAbort.abort();
  await running.stop();
  expect(await running.exited).toBeNumber();
}, 10000);
