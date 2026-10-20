import { expect, setDefaultTimeout, test } from "bun:test";
import { resolveHostInputSchema } from "#plugins/network/src/contract";
import {
  familyLookup,
  resolveHost,
} from "#plugins/network/src/platforms/resolve-host";
import {
  dispose,
  initialize,
  runResolveHost,
} from "#plugins/network/src/platforms/shared";
import { deadline } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

test("resolveHost passes the family hint and keeps only the asked family", async () => {
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
  const seen: (4 | 6 | undefined)[] = [];
  const find = async (_host: string, family?: 4 | 6) => {
    seen.push(family);
    return mixed;
  };
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
  expect(seen).toEqual([
    4,
    6,
    undefined,
  ]);
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

test("familyLookup answers a name without that family with an empty result", async () => {
  const calls: (4 | 6 | undefined)[] = [];
  const find = familyLookup(async (host, options) => {
    calls.push(options.family);
    if (options.family === 6) {
      throw Object.assign(new Error(`queryAaaa ENODATA ${host}`), {
        code: "ENODATA",
      });
    }
    return [
      {
        address: "93.184.216.34",
        family: 4,
      },
    ];
  });
  const result = await resolveHost(
    "ipv4-only.example",
    new AbortController().signal,
    find,
    "AAAA",
  );
  expect(result).toEqual({
    endpoints: [],
  });
  expect(calls).toEqual([
    6,
    undefined,
  ]);
});

test("familyLookup still fails for a name that does not exist", async () => {
  const find = familyLookup(async () => {
    throw new Error("ENOTFOUND");
  });
  await expect(
    resolveHost("missing.example", new AbortController().signal, find, "AAAA"),
  ).rejects.toThrow("ENOTFOUND");
});
