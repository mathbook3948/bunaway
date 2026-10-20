import { expect, setDefaultTimeout, test } from "bun:test";
import { resolveHostInputSchema } from "#plugins/network/src/contract";
import { resolveHost } from "#plugins/network/src/platforms/resolve-host";
import {
  dispose,
  initialize,
  runResolveHost,
} from "#plugins/network/src/platforms/shared";
import { deadline } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

test("resolveHost keeps only the asked family and drops repeats", async () => {
  const mixed = [
    {
      address: "93.184.216.34",
      family: 4,
    },
    {
      address: "2606:2800:220:1::1",
      family: 6,
    },
    {
      address: "93.184.216.34",
      family: 4,
    },
  ];
  const find = async () => mixed;
  const signal = new AbortController().signal;
  expect(await resolveHost("a.example", signal, find, "A")).toEqual({
    endpoints: [
      {
        address: "93.184.216.34",
        family: "ipv4",
      },
    ],
  });
  expect(await resolveHost("a.example", signal, find, "AAAA")).toEqual({
    endpoints: [
      {
        address: "2606:2800:220:1::1",
        family: "ipv6",
      },
    ],
  });
  expect((await resolveHost("a.example", signal, find)).endpoints).toHaveLength(
    2,
  );
});

test("resolveHost returns no endpoints when the asked family has no address", async () => {
  const result = await resolveHost(
    "127.0.0.1",
    new AbortController().signal,
    async () => [
      {
        address: "127.0.0.1",
        family: 4,
      },
    ],
    "AAAA",
  );
  expect(result).toEqual({
    endpoints: [],
  });
});

test("network.resolveHost accepts only A and AAAA as queryType", () => {
  for (const queryType of [
    "A",
    "AAAA",
  ]) {
    expect(
      resolveHostInputSchema.safeParse({
        host: "example.com",
        queryType,
      }).success,
    ).toBe(true);
  }
  for (const queryType of [
    "a",
    "MX",
    "",
    4,
    null,
  ]) {
    expect(
      resolveHostInputSchema.safeParse({
        host: "example.com",
        queryType,
      }).success,
    ).toBe(false);
  }
});

test("runResolveHost resolves localhost by family with the system resolver", async () => {
  const state = initialize();
  try {
    const v4 = await runResolveHost(state, {
      host: "localhost",
      queryType: "A",
      timeoutMs: deadline("childStep"),
    });
    expect(v4.endpoints.length).toBeGreaterThan(0);
    expect(v4.endpoints.every((entry) => entry.family === "ipv4")).toBe(true);
    const literal = await runResolveHost(state, {
      host: "127.0.0.1",
      queryType: "AAAA",
      timeoutMs: deadline("childStep"),
    });
    expect(literal.endpoints).toEqual([]);
  } finally {
    await dispose(state);
  }
});

test("resolveHost answers a name without the asked family with an empty result", async () => {
  const lookups: string[] = [];
  const result = await resolveHost(
    "ipv4-only.example",
    new AbortController().signal,
    async (host) => {
      lookups.push(host);
      return [
        {
          address: "93.184.216.34",
          family: 4,
        },
      ];
    },
    "AAAA",
  );
  expect(result).toEqual({
    endpoints: [],
  });
  expect(lookups).toEqual([
    "ipv4-only.example",
  ]);
});

test("resolveHost still fails when the resolver fails for a queryType", async () => {
  await expect(
    resolveHost(
      "flaky.example",
      new AbortController().signal,
      async () => {
        throw new Error("EAI_AGAIN");
      },
      "AAAA",
    ),
  ).rejects.toThrow("EAI_AGAIN");
});
