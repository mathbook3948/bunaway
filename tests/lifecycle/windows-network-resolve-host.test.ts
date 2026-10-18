import { expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import macosNetworkPlugin from "@bunaway/plugin-network/native/macos";
import windowsNetworkPlugin from "@bunaway/plugin-network/native/windows";
import type { JsonValue } from "@bunaway/protocol";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

const platforms = [
  [
    "windows",
    windowsNetworkPlugin._definition.nativePlatforms.windows,
  ],
  [
    "macos",
    macosNetworkPlugin._definition.nativePlatforms.macos,
  ],
] as const;

test.each(platforms)(
  "generated %s network adapter resolves a host through the system resolver",
  async (_name, platform) => {
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    assert(adapter.executeUI);
    const call = (input: JsonValue, signal?: AbortSignal) =>
      adapter.executeUI?.("network.resolveHost", input, "view:test", {
        requestId: crypto.randomUUID(),
        permissions: {
          permissions: [
            "network.resolveHost",
          ],
        },
        ...(signal
          ? {
              signal,
            }
          : {}),
      });
    try {
      // localhost comes from the hosts file or the resolver's loopback rule, so no network is needed.
      const result = (await call({
        host: "localhost",
      })) as {
        endpoints: {
          address: string;
          family: string;
        }[];
      };
      expect(result.endpoints.length).toBeGreaterThan(0);
      expect(
        result.endpoints.every(
          (entry) =>
            (entry.family === "ipv4" && entry.address.includes(".")) ||
            (entry.family === "ipv6" && entry.address.includes(":")),
        ),
      ).toBe(true);
      expect(
        result.endpoints.some(
          (entry) => entry.address === "127.0.0.1" || entry.address === "::1",
        ),
      ).toBe(true);
      // The schema runs before the resolver, so a URL is refused without a lookup.
      await expect(
        call({
          host: "http://localhost",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        call(
          {
            host: "localhost",
          },
          cancelled.signal,
        ),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
    } finally {
      await adapter.dispose();
    }
    await expect(
      call({
        host: "localhost",
      }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
  },
);
