import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DevelopmentApp } from "../../native/windows/bun/development-app.ts";
import { WindowsAppReload } from "../../packages/cli/src/windows-app-reload.ts";
import type {
  AppDefinition,
  CoreServices,
} from "../../packages/core/src/index.ts";
import { createCore } from "../../packages/core/src/index.ts";
import {
  type Hello,
  type HostContext,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "../../packages/protocol/src/index.ts";
import {
  type AppReloadRequest,
  readAppReloadRequest,
  readAppReloadResult,
} from "../../packages/runtime-bun/src/development.ts";

const hello: Hello = {
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "reload-test",
};
function app(
  version: number,
  step: number,
  wait: Promise<void> = Promise.resolve(),
): AppDefinition {
  return {
    state: {
      count: 0,
    },
    events: {
      changed: {
        type: "integer",
      },
    },
    commands: {
      step: {
        input: {
          type: "boolean",
        },
        output: {},
        async run(hold, context) {
          if (hold) {
            await wait;
          }
          const previous = context.state.get("count");
          if (typeof previous !== "number") {
            throw new Error("Missing counter state");
          }
          const count = previous + step;
          context.state.set("count", count);
          await context.events.emit("changed", count, {
            kind: "broadcast",
          });
          return {
            version,
            count,
          };
        },
      },
    },
  };
}

test("app replacement keeps state, sessions, subscriptions and the code of an in-flight call", async () => {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const development = new DevelopmentApp(app(1, 1, wait));
  const messages: ServerMessage[] = [];
  const services: CoreServices = {
    hello,
    platform: "windows",
    backendContext: "backend-reload" as HostContext,
    policy: {
      version: 1,
      backend: {
        permissions: [],
      },
      views: [
        {
          id: "main",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [
            "step",
          ],
          events: [
            "changed",
          ],
          host: {
            permissions: [],
          },
        },
      ],
    },
    runtime: {
      createCancellation: () => new AbortController(),
      now: () => Date.now(),
      schedule(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    async send(_context, message) {
      messages.push(message);
    },
    async callHost() {
      throw new Error("Unexpected Host API call");
    },
  };
  const core = await createCore(development.definition, services);
  try {
    // The test host issues these fixed context IDs.
    const session = core.openSession("view-reload" as HostContext, "main");
    await session.receive(hello);
    await session.receive({
      kind: "listen",
      protocol: PROTOCOL_VERSION,
      id: "listen",
      event: "changed",
    });
    const invoke = (id: string, payload = false) =>
      session.receive({
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id,
        command: "step",
        payload,
      });
    await invoke("first");
    await Bun.sleep(0);
    await invoke("held", true);
    expect(development.replace(app(2, 10))).toBe(true);
    await invoke("second");
    await Bun.sleep(0);
    const invalid = app(3, 100);
    const invalidCommand = invalid.commands.step;
    if (!invalidCommand) {
      throw new Error("Missing fixture command");
    }
    Object.assign(invalidCommand, {
      run: null,
    });
    expect(() => development.replace(invalid)).toThrow("run function");
    await invoke("retained");
    await Bun.sleep(0);
    release();
    await Bun.sleep(0);
    const results = messages.filter(
      (
        message,
      ): message is Extract<
        ServerMessage,
        {
          kind: "result";
        }
      > => message.kind === "result" && message.id !== "listen",
    );
    expect(results.map((message) => message.payload)).toEqual([
      {
        version: 1,
        count: 1,
      },
      {
        version: 2,
        count: 11,
      },
      {
        version: 2,
        count: 21,
      },
      {
        version: 1,
        count: 22,
      },
    ]);
    const events = messages.filter((message) => message.kind === "event");
    expect(events.map((event) => event.sequence)).toEqual([
      1,
      2,
      3,
      4,
    ]);
    expect(events.map((event) => event.payload)).toEqual([
      1,
      11,
      21,
      22,
    ]);
    expect(new Set(events.map((event) => event.subscriptionId)).size).toBe(1);
  } finally {
    release();
    await core.stop();
  }
});

test("private process IPC rejects corrupt bundles, recovers after import failure and bounds cached generations", async () => {
  const assets = await mkdtemp(resolve(tmpdir(), "bunaway-app-reload-"));
  const connection = new WindowsAppReload();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "app-reload.fixture.ts"),
      assets,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
      ipc: (message) => connection.receive(message),
    },
  );
  connection.attach(child);
  const errors = new Response(child.stderr).text();
  const source =
    "export default { commands: { read: { input: { const: null }, output: {}, async run() { return 1; } } }, events: {} };\n";
  async function candidate(
    code: string,
    hash = createHash("sha256").update(code).digest("hex"),
  ) {
    const id = crypto.randomUUID();
    const directory = resolve(assets, "reloads", id);
    await mkdir(directory, {
      recursive: true,
    });
    await writeFile(resolve(directory, "app.js"), code);
    return connection.reload({
      kind: "bunaway:reload-app",
      id,
      sha256: hash,
    });
  }
  try {
    expect((await candidate(source, "0".repeat(64))).status).toBe("failed");
    expect((await candidate("export default ;")).status).toBe("failed");
    expect((await candidate(source)).status).toBe("reloaded");
    expect(
      (await candidate(source.replace("events: {}", "events: { changed: {} }")))
        .status,
    ).toBe("restart");
    for (let index = 0; index < 96; index++) {
      expect((await candidate(source)).status).toBe("reloaded");
    }
    expect((await candidate(source)).status).toBe("restart");
  } finally {
    connection.close();
    child.kill();
    await child.exited;
    await errors;
    await rm(assets, {
      recursive: true,
      force: true,
    });
  }
});

test("contract, initial state, desktop callbacks and plugin instance changes require a restart", () => {
  const initial = app(1, 1);
  const development = new DevelopmentApp(initial);
  expect(
    development.replace({
      ...app(2, 10),
      events: {
        changed: {
          type: "string",
        },
      },
    }),
  ).toBe(false);
  expect(
    development.replace({
      ...app(2, 10),
      state: {
        count: 100,
      },
    }),
  ).toBe(false);
  expect(
    development.replace({
      ...app(2, 10),
      commands: {},
    }),
  ).toBe(false);
  expect(
    development.replace({
      ...app(2, 10),
      desktop: {
        beforeQuit: () => true,
      },
    }),
  ).toBe(false);
  const plugin = {
    name: "owned",
    version: "1",
    setup: () => () => {},
  };
  const withPlugin = new DevelopmentApp({
    ...initial,
    plugins: [
      plugin,
    ],
  });
  expect(
    withPlugin.replace({
      ...app(2, 10),
      plugins: [
        plugin,
      ],
    }),
  ).toBe(true);
  expect(
    withPlugin.replace({
      ...app(2, 10),
      plugins: [
        {
          ...plugin,
        },
      ],
    }),
  ).toBe(false);
  expect(development.replace(app(2, 10))).toBe(true);
});

test("private reload IPC validates generation IDs, hashes and bounded replies", () => {
  const id = crypto.randomUUID();
  const request: AppReloadRequest = {
    kind: "bunaway:reload-app",
    id,
    sha256: "a".repeat(64),
  };
  expect(readAppReloadRequest(request)).toEqual(request);
  for (const value of [
    {
      ...request,
      id: "../app",
    },
    {
      ...request,
      sha256: "bad",
    },
    {
      ...request,
      entry: "outside.js",
    },
    null,
  ]) {
    expect(() => readAppReloadRequest(value)).toThrow();
  }
  expect(
    readAppReloadResult({
      kind: "bunaway:reload-result",
      id,
      status: "reloaded",
    }).status,
  ).toBe("reloaded");
  expect(() =>
    readAppReloadResult({
      kind: "bunaway:reload-result",
      id,
      status: "failed",
      message: "x".repeat(4097),
    }),
  ).toThrow();
});
