import { expect, test } from "bun:test";
import { parseDevArguments, devProject } from "../../packages/cli/src/dev.ts";
import { windowsInspectorArgument } from "../../packages/cli/src/launch.ts";
import { verifyDevelopmentToolsLaunch } from "../../packages/runtime-bun/src/development.ts";

test("DevTools require both a development artifact and an explicit launch flag", () => {
  expect(verifyDevelopmentToolsLaunch(undefined)).toBe(false);
  expect(verifyDevelopmentToolsLaunch(true, true)).toBe(true);
  for (const [marker, requested] of [
    [undefined, true],
    [true, false],
    [false, true],
    ["true", true],
    [{ devtools: true }, true],
  ] as const)
    expect(() => verifyDevelopmentToolsLaunch(marker, requested)).toThrow("DevTools require");
});

test("dev accepts an optional inspector port and rejects ambiguous or remote endpoints", () => {
  expect(parseDevArguments([])).toEqual({ directory: "." });
  expect(parseDevArguments(["--inspect"])).toEqual({ directory: ".", inspect: 6499 });
  expect(parseDevArguments(["my app", "--inspect=6500"])).toEqual({
    directory: "my app",
    inspect: 6500,
  });
  expect(parseDevArguments(["--inspect=65535", "my app"])).toEqual({
    directory: "my app",
    inspect: 65535,
  });
  for (const args of [
    ["--inspect", "--inspect=6500"],
    ["--inspect="],
    ["--inspect=0"],
    ["--inspect=65536"],
    ["--inspect=-1"],
    ["--inspect=1.5"],
    ["--inspect=127.0.0.1:6499"],
    ["--inspect=0.0.0.0:6499"],
    ["--inspect-brk"],
    ["one", "two"],
  ])
    expect(() => parseDevArguments(args)).toThrow();
  for (const port of [0, 65536, NaN, Infinity, 1.5])
    expect(() => windowsInspectorArgument(port)).toThrow("Inspector port");
});

test.skipIf(process.platform === "win32")(
  "backend inspector fails explicitly on unsupported platforms",
  async () => {
    await expect(devProject("missing-project", { inspect: 6499 })).rejects.toThrow(
      "Windows x64 only",
    );
  },
);

test("Bun inspector accepts the CLI endpoint and permits a fresh connection after restart", async () => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = reservation.port;
  reservation.stop(true);
  if (!port) throw new Error("No inspector test port.");
  const endpoint = `ws://127.0.0.1:${port}/bunaway`;
  for (let generation = 0; generation < 2; generation++) {
    const child = Bun.spawn(
      [
        process.execPath,
        windowsInspectorArgument(port),
        "-e",
        `globalThis.debugGeneration = ${generation}; console.log("ready"); setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let socket: WebSocket | undefined;
    let errors: Promise<string> | undefined;
    const timeout = setTimeout(() => child.kill(), 5000);
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      reader.releaseLock();
      const inspectorOutput = child.stderr.getReader();
      let banner = "";
      while (!banner.includes(endpoint)) {
        const next = await inspectorOutput.read();
        if (next.done) throw new Error(`Inspector did not start: ${banner}`);
        banner += new TextDecoder().decode(next.value);
      }
      errors = (async () => {
        let rest = "";
        for (;;) {
          const next = await inspectorOutput.read();
          if (next.done) return rest;
          rest += new TextDecoder().decode(next.value);
        }
      })();
      const result = await new Promise<unknown>((resolveResult, reject) => {
        socket = new WebSocket(endpoint);
        socket.onopen = () =>
          socket?.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression: "globalThis.debugGeneration" },
            }),
          );
        socket.onerror = () => reject(new Error("Inspector connection failed"));
        socket.onclose = () => reject(new Error("Inspector connection closed before reply"));
        socket.onmessage = (event) => {
          const reply = JSON.parse(String(event.data));
          if (reply.id === 1) resolveResult(reply);
        };
      });
      expect(result).toMatchObject({ id: 1, result: { result: { value: generation } } });
    } finally {
      socket?.close();
      child.kill();
      await child.exited;
      clearTimeout(timeout);
      await errors;
    }
  }
}, 15000);
