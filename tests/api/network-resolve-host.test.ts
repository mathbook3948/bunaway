import { expect, setDefaultTimeout, test } from "bun:test";
import network from "@bunaway/plugin-network";
import { NativeRegistry } from "@bunaway/protocol";
import {
  MAX_RESOLVED_ENDPOINTS,
  resolveHostInputSchema,
} from "#plugins/network/src/contract";
import { windowsOperations } from "#plugins/network/src/operations";
import { resolveHost } from "#plugins/network/src/platforms/resolve-host";
import {
  dispose,
  initialize,
  runResolveHost,
} from "#plugins/network/src/platforms/shared";
import { deadline } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

test("network.resolveHost needs its own grant", () => {
  const registry = new NativeRegistry([
    network._definition,
  ]);
  const call = {
    operation: "network.resolveHost",
    payload: {
      host: "example.com",
    },
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "network.resolveHost",
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

test("network.resolveHost accepts only plain ASCII host names", () => {
  const parse = (host: string) =>
    resolveHostInputSchema.safeParse({
      host,
    }).success;
  for (const host of [
    "example.com",
    "example.com.",
    "localhost",
    "127.0.0.1",
    "255.255.255.255",
    "1password.example",
    "xn--9t4b11yi5a.example",
    "_dmarc.example.com",
    "a".repeat(63),
  ]) {
    expect(parse(host)).toBe(true);
  }
  for (const host of [
    "",
    ".",
    "a..b",
    "-a.example",
    "a-.example",
    "a".repeat(64),
    `${"a.".repeat(127)}a`,
    "http://example.com",
    "example.com:80",
    "example.com/path",
    "user@example.com",
    "[::1]",
    "1",
    "2130706433",
    "0x7f.1",
    "0x7f.0.0.1",
    "017700000001",
    "127.1",
    "010.0.0.1",
    "999.999.999.999",
    "1.2.3.4.5",
    "host.123",
    "예시.테스트",
    "exa mple.com",
    "example.com\n",
  ]) {
    expect(parse(host)).toBe(false);
  }
  expect(
    resolveHostInputSchema.safeParse({
      host: "example.com",
      timeoutMs: 0,
    }).success,
  ).toBe(false);
  expect(
    resolveHostInputSchema.safeParse({
      host: "example.com",
      extra: true,
    }).success,
  ).toBe(false);
  expect(
    resolveHostInputSchema.parse({
      host: "example.com",
    }).timeoutMs,
  ).toBe(30_000);
});

test("network.resolveHost output is a bounded endpoint list", () => {
  const output = windowsOperations.resolveHost.output;
  expect(
    output.safeParse({
      endpoints: [
        {
          address: "93.184.216.34",
          family: "ipv4",
        },
        {
          address: "2606:2800:220:1::1",
          family: "ipv6",
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    output.safeParse({
      endpoints: [
        {
          address: "1.2.3.4",
          family: 4,
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    output.safeParse({
      endpoints: Array.from(
        {
          length: MAX_RESOLVED_ENDPOINTS + 1,
        },
        () => ({
          address: "1.2.3.4",
          family: "ipv4",
        }),
      ),
    }).success,
  ).toBe(false);
});

test("resolveHost maps families, drops repeats and keeps resolver order", async () => {
  const result = await resolveHost(
    "example.com",
    new AbortController().signal,
    async (host) => {
      expect(host).toBe("example.com");
      return [
        {
          address: "2606:2800:220:1::1",
          family: 6,
        },
        {
          address: "93.184.216.34",
          family: 4,
        },
        {
          address: "2606:2800:220:1::1",
          family: 6,
        },
      ];
    },
  );
  expect(result).toEqual({
    endpoints: [
      {
        address: "2606:2800:220:1::1",
        family: "ipv6",
      },
      {
        address: "93.184.216.34",
        family: "ipv4",
      },
    ],
  });
});

test("resolveHost truncates to the endpoint limit", async () => {
  const result = await resolveHost(
    "many.example",
    new AbortController().signal,
    async () =>
      Array.from(
        {
          length: MAX_RESOLVED_ENDPOINTS + 10,
        },
        (_, index) => ({
          address: `10.0.0.${index}`,
          family: 4,
        }),
      ),
  );
  expect(result.endpoints).toHaveLength(MAX_RESOLVED_ENDPOINTS);
  expect(result.endpoints[0]?.address).toBe("10.0.0.0");
});

test("resolveHost rejects at once on abort while the lookup keeps running", async () => {
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  const lookup = new Promise<
    {
      address: string;
      family: number;
    }[]
  >((resolve) => {
    finish = () =>
      resolve([
        {
          address: "1.2.3.4",
          family: 4,
        },
      ]);
  });
  const pending = resolveHost("slow.example", controller.signal, () => lookup);
  controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");
  finish?.();
  await lookup;
  await expect(
    resolveHost("slow.example", controller.signal, () => lookup),
  ).rejects.toThrow("stop");
});

test("resolveHost ignores a lookup failure after the caller left", async () => {
  const controller = new AbortController();
  let fail: ((error: Error) => void) | undefined;
  const lookup = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const pending = resolveHost("slow.example", controller.signal, () => lookup);
  controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");
  fail?.(new Error("late failure"));
  await Bun.sleep(0);
});

test("resolveHost does not abort-reject after the lookup finished", async () => {
  const controller = new AbortController();
  await resolveHost("done.example", controller.signal, async () => []);
  controller.abort(new Error("late"));
  await Bun.sleep(0);
});

test("resolveHost propagates a resolver failure", async () => {
  await expect(
    resolveHost("missing.example", new AbortController().signal, async () => {
      throw new Error("ENOTFOUND");
    }),
  ).rejects.toThrow("ENOTFOUND");
});

test("runResolveHost resolves loopback and stops after disposal", async () => {
  const state = initialize();
  const local = await runResolveHost(state, {
    host: "localhost",
    timeoutMs: deadline("childStep"),
  });
  expect(local.endpoints.length).toBeGreaterThan(0);
  expect(
    local.endpoints.some(
      (entry) => entry.address === "127.0.0.1" || entry.address === "::1",
    ),
  ).toBe(true);
  await dispose(state);
  await expect(
    runResolveHost(state, {
      host: "localhost",
      timeoutMs: deadline("childStep"),
    }),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

const never = () => new Promise<never>(() => undefined);

test("runResolveHost ends with TIMEOUT when the resolver is slow", async () => {
  const state = initialize();
  await expect(
    runResolveHost(
      state,
      {
        host: "slow.example",
        timeoutMs: 20,
      },
      undefined,
      never,
    ),
  ).rejects.toMatchObject({
    code: "TIMEOUT",
  });
  await dispose(state);
});

test("runResolveHost shares the active request limit and frees the slot on abort", async () => {
  const state = initialize();
  const controllers = Array.from(
    {
      length: 16,
    },
    () => new AbortController(),
  );
  const held = controllers.map((controller) =>
    runResolveHost(
      state,
      {
        host: "slow.example",
        timeoutMs: deadline("childStep"),
      },
      controller.signal,
      never,
    ),
  );
  await expect(
    runResolveHost(
      state,
      {
        host: "slow.example",
        timeoutMs: deadline("childStep"),
      },
      undefined,
      never,
    ),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  const first = controllers[0];
  first?.abort();
  await expect(held[0]).rejects.toMatchObject({
    code: "CANCELLED",
  });
  for (const controller of controllers) {
    controller.abort();
  }
  await Promise.allSettled(held);
  await dispose(state);
});

test("dispose cancels a resolution that is still pending", async () => {
  const state = initialize();
  const pending = runResolveHost(
    state,
    {
      host: "slow.example",
      timeoutMs: deadline("childStep"),
    },
    undefined,
    never,
  );
  await dispose(state);
  await expect(pending).rejects.toMatchObject({
    code: "CANCELLED",
  });
});
