import { expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import windowsNetworkPlugin from "@bunaway/plugin-network/native/windows";
import type { JsonValue } from "@bunaway/protocol";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

const KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** The values the system proxy reading looks at; each is put back as it was. */
const VALUES = [
  "ProxyEnable",
  "ProxyServer",
  "ProxyOverride",
  "AutoConfigURL",
] as const;
/** A host name no resolver answers, so a request succeeds only through the proxy. */
const ORIGIN = "origin.invalid";

type Saved = Record<
  (typeof VALUES)[number],
  | {
      type: string;
      data: string;
    }
  | undefined
>;

async function reg(...args: string[]) {
  const child = Bun.spawn(
    [
      "reg.exe",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return {
    out,
    code,
  };
}

async function readValue(name: string) {
  const { out, code } = await reg("query", KEY, "/v", name);
  if (code !== 0) {
    return undefined;
  }
  const match = new RegExp(`^\\s+${name}\\s+(REG_\\w+)\\s*(.*)$`, "m").exec(
    out,
  );
  return match
    ? {
        type: match[1] ?? "REG_SZ",
        data: (match[2] ?? "").trim(),
      }
    : undefined;
}

async function snapshot(): Promise<Saved> {
  const saved: Partial<Saved> = {};
  for (const name of VALUES) {
    saved[name] = await readValue(name);
  }
  return saved as Saved;
}

async function restore(saved: Saved) {
  for (const name of VALUES) {
    const value = saved[name];
    if (value) {
      await reg(
        "add",
        KEY,
        "/v",
        name,
        "/t",
        value.type,
        "/d",
        value.data,
        "/f",
      );
    } else {
      await reg("delete", KEY, "/v", name, "/f");
    }
  }
}

async function configure(proxy: string | undefined) {
  await reg("delete", KEY, "/v", "AutoConfigURL", "/f");
  await reg("delete", KEY, "/v", "ProxyOverride", "/f");
  if (proxy === undefined) {
    await reg(
      "add",
      KEY,
      "/v",
      "ProxyEnable",
      "/t",
      "REG_DWORD",
      "/d",
      "0",
      "/f",
    );
    return;
  }
  await reg("add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", proxy, "/f");
  await reg(
    "add",
    KEY,
    "/v",
    "ProxyEnable",
    "/t",
    "REG_DWORD",
    "/d",
    "1",
    "/f",
  );
}

/**
 * The test rewrites the current user's Internet Options, so it runs on CI runners or when a
 * developer opts in; an interrupted run on a personal machine would leave a dead proxy behind.
 */
const MAY_CHANGE_INTERNET_OPTIONS =
  process.platform === "win32" &&
  (Boolean(process.env.CI) ||
    process.env.BUNAWAY_ALLOW_INTERNET_OPTIONS_TEST === "1");

test.skipIf(!MAY_CHANGE_INTERNET_OPTIONS)(
  "generated Windows network adapter sends requests through the proxy set in Internet Options",
  async () => {
    const lines: string[] = [];
    const proxy = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (chunk) => {
        lines.push(chunk.toString("latin1").split("\r\n")[0] ?? "");
        socket.end(
          "HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\nproxied",
        );
      });
    });
    await new Promise<void>((resolve) =>
      proxy.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = proxy.address();
    assert(address && typeof address === "object");
    const platform = windowsNetworkPlugin._definition.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    assert(adapter.executeUI);
    const call = (input: JsonValue) => {
      assert(adapter.executeUI);
      return adapter.executeUI("network.request", input, "view:test", {
        requestId: crypto.randomUUID(),
        permissions: {
          permissions: [
            "network.request",
          ],
        },
      });
    };
    // A proxy named by the environment would skip the system lookup this test is about.
    const environment = new Map<string, string | undefined>();
    for (const name of [
      "http_proxy",
      "HTTP_PROXY",
    ]) {
      environment.set(name, process.env[name]);
      delete process.env[name];
    }
    const saved = await snapshot();
    try {
      await configure(`127.0.0.1:${address.port}`);
      const answer = (await call({
        url: `http://${ORIGIN}/through-proxy`,
        timeoutMs: 20000,
      })) as {
        status: number;
        bodyBase64: string;
      };
      expect(answer.status).toBe(200);
      expect(Buffer.from(answer.bodyBase64, "base64").toString()).toBe(
        "proxied",
      );
      expect(lines).toEqual([
        `GET http://${ORIGIN}/through-proxy HTTP/1.1`,
      ]);
      // With the proxy switched off the same request goes direct and cannot reach the host.
      await configure(undefined);
      await expect(
        call({
          url: `http://${ORIGIN}/direct`,
          timeoutMs: 20000,
        }),
      ).rejects.toBeTruthy();
      expect(lines).toHaveLength(1);
    } finally {
      for (const [name, value] of environment) {
        if (value !== undefined) {
          process.env[name] = value;
        }
      }
      await adapter.dispose();
      await restore(saved);
      proxy.close();
    }
  },
);
