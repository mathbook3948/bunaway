import { expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import windowsNetworkPlugin from "@bunaway/plugin-network/native/windows";
import type { JsonValue } from "@bunaway/protocol";
import {
  openWinHttp,
  winHttpApi,
} from "#plugins/network/src/platforms/resolve-proxy";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

const WINHTTP_ACCESS_TYPE_NO_PROXY = 1;
const WINHTTP_ACCESS_TYPE_NAMED_PROXY = 3;
const PAC = `function FindProxyForURL(url, host) {
  if (host === "direct.example") {
    return "DIRECT";
  }
  return "PROXY proxy.example:8080";
}
`;

test("generated Windows network adapter resolves proxy routes through WinHTTP", async () => {
  const platform = windowsNetworkPlugin._definition.nativePlatforms.windows;
  assert(platform);
  const adapter = platform.create({
    dataRoot: ".",
    capabilities: [],
  });
  assert(adapter.executeUI);
  const call = (input: JsonValue, signal?: AbortSignal) =>
    adapter.executeUI?.("network.resolveProxy", input, "view:test", {
      requestId: crypto.randomUUID(),
      permissions: {
        permissions: [
          "network.resolveProxy",
        ],
      },
      ...(signal
        ? {
            signal,
          }
        : {}),
    });
  try {
    // Loopback is answered without consulting the user's proxy settings.
    await expect(
      call({
        url: "http://localhost:3000/",
      }),
    ).resolves.toEqual({
      entries: [
        {
          kind: "direct",
        },
      ],
    });
    // The runner's own Internet Options decide this answer; only its shape is fixed.
    const result = (await call({
      url: "https://example.com/",
    })) as {
      entries: {
        kind: string;
        scheme?: string;
        host?: string;
        port?: number;
      }[];
    };
    expect(result.entries.length).toBeGreaterThan(0);
    for (const entry of result.entries) {
      if (entry.kind === "proxy") {
        expect([
          "http",
          "https",
          "socks4",
          "socks5",
        ]).toContain(entry.scheme ?? "");
        expect(entry.host?.length).toBeGreaterThan(0);
        expect(entry.port).toBeGreaterThan(0);
        expect(JSON.stringify(entry)).not.toContain("@");
      } else {
        expect(entry).toEqual({
          kind: "direct",
        });
      }
    }
    await expect(
      call({
        url: "https://user:secret@example.com/",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      call(
        {
          url: "https://example.com/",
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
      url: "https://example.com/",
    }),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("WinHTTP bindings read the user's settings and run a proxy script", () => {
  const libraries = openWinHttp();
  const folder = mkdtempSync(join(tmpdir(), "bunaway-pac-"));
  try {
    const api = winHttpApi(libraries);
    // Whatever the runner has configured, reading it must succeed and free what WinHTTP allocated.
    const config = api.ieProxyConfig();
    for (let repeat = 0; repeat < 3; repeat += 1) {
      expect(api.ieProxyConfig()).toEqual(config);
    }
    const script = join(folder, "proxy.pac");
    writeFileSync(script, PAC);
    const source = {
      kind: "script",
      url: pathToFileURL(script).href,
    } as const;
    expect(
      api.autoProxyForUrl("http://web.example/", source, 10_000),
    ).toMatchObject({
      accessType: WINHTTP_ACCESS_TYPE_NAMED_PROXY,
      proxy: "proxy.example:8080",
    });
    expect(
      api.autoProxyForUrl("http://direct.example/", source, 10_000),
    ).toMatchObject({
      accessType: WINHTTP_ACCESS_TYPE_NO_PROXY,
    });
    // A script that does not exist is a Win32 error code, not an exception.
    expect(
      typeof api.autoProxyForUrl(
        "http://web.example/",
        {
          kind: "script",
          url: pathToFileURL(join(folder, "missing.pac")).href,
        },
        10_000,
      ),
    ).toBe("number");
  } finally {
    libraries.winhttp.close();
    libraries.kernel.close();
    rmSync(folder, {
      recursive: true,
      force: true,
    });
  }
});
