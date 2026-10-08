import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  MAX_MESSAGE_BYTES,
  type ProcessFrame,
  parseProcessFrame,
} from "../../packages/protocol/src/index.ts";
import { readJsonLines } from "../../packages/runtime-bun/src/index.ts";

test("process event limits reject the entire broadcast and preserve sessions and sequences", async () => {
  const entrypoint = fileURLToPath(
    new URL("./event-limits.fixture.ts", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      entrypoint,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 5000);
  const errors = new Response(child.stderr).text();
  const output = readJsonLines(child.stdout)[Symbol.asyncIterator]();
  const next = async () => {
    const line = await output.next();
    if (line.done) {
      throw new Error("Unexpected runtime EOF.");
    }
    return {
      frame: parseProcessFrame(line.value),
      bytes: Buffer.byteLength(line.value),
    };
  };
  const send = (body: Record<string, unknown>) =>
    child.stdin.write(
      `${JSON.stringify({
        ...body,
        ipc: PROTOCOL_VERSION,
        runtime: {
          id: "event-limits",
          generation: "1",
        },
      })}\n`,
    );
  const web = (context: string, message: ClientMessage) =>
    send({
      kind: "web",
      context,
      payload: message,
    });
  const contexts = [
    "view-main",
    "view-main-long",
  ];
  const ping = async (id: string) => {
    for (const context of contexts) {
      web(context, {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id,
        command: "ping",
        payload: null,
      });
      expect((await next()).frame).toMatchObject({
        kind: "web",
        context,
        payload: {
          kind: "result",
          id,
          payload: null,
        },
      });
    }
  };
  const emit = (mode: string) =>
    web("view-main", {
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: mode,
      command: "emit",
      payload: mode,
    });
  const expectDelivered = async (mode: string, sequence: number) => {
    emit(mode);
    const replies = [
      await next(),
      await next(),
      await next(),
    ];
    for (const context of contexts) {
      const event = replies.find(
        ({ frame }) =>
          frame.kind === "web" &&
          frame.context === context &&
          frame.payload.kind === "event",
      );
      expect(event?.frame).toMatchObject({
        kind: "web",
        context,
        payload: {
          kind: "event",
          sequence,
        },
      });
      if (mode === "byte-boundary" && context === "view-main-long") {
        expect(event?.bytes).toBe(MAX_MESSAGE_BYTES);
      }
      if (mode === "valid") {
        expect(event?.frame).toMatchObject({
          payload: {
            payload: "after-rejection",
          },
        });
      }
    }
    expect(replies.map(({ frame }) => frame)).toContainEqual({
      kind: "web",
      context: "view-main",
      ipc: PROTOCOL_VERSION,
      runtime: {
        id: "event-limits",
        generation: "1",
      },
      payload: {
        kind: "result",
        protocol: PROTOCOL_VERSION,
        id: mode,
        payload: null,
      },
    });
  };
  try {
    send({
      kind: "boot",
      payload: {
        entrypoint,
        buildId: "test",
        backendContext: "backend-test",
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
                "emit",
                "ping",
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
      },
    });
    expect((await next()).frame.kind).toBe("hello");
    send({
      kind: "hello",
      payload: {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [],
        buildId: "host",
      },
    });
    expect((await next()).frame.kind).toBe("ready");
    for (const context of contexts) {
      send({
        kind: "session-open",
        context,
        viewId: "main",
      });
      web(context, {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [],
        buildId: "ui",
      });
      expect((await next()).frame).toMatchObject({
        kind: "web",
        context,
        payload: {
          kind: "hello",
        },
      });
      web(context, {
        kind: "listen",
        protocol: PROTOCOL_VERSION,
        id: "listen",
        event: "changed",
      });
      expect((await next()).frame).toMatchObject({
        kind: "web",
        context,
        payload: {
          kind: "result",
          id: "listen",
          payload: {
            subscriptionId: "sub-1",
          },
        },
      });
    }
    await expectDelivered("byte-boundary", 1);
    for (const mode of [
      "byte-overflow",
      "message-boundary",
      "depth-overflow",
    ]) {
      emit(mode);
      expect((await next()).frame).toMatchObject({
        kind: "web",
        context: "view-main",
        payload: {
          kind: "error",
          id: mode,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Invalid event message.",
          },
        },
      });
      await ping(`ping-${mode}`);
    }
    await expectDelivered("depth-boundary", 2);
    await expectDelivered("valid", 3);
    await ping("ping-valid");
    send({
      kind: "shutdown",
    });
    child.stdin.end();
    expect((await next()).frame.kind).toBe("stopping");
    expect(await child.exited).toBe(0);
    expect(await errors).toBe("");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
});

for (const [fixture, command, detail, stackFile] of [
  [
    "./command-error.fixture.ts",
    "fail",
    "runtime diagnostic sentinel",
    "command-error.fixture.ts",
  ],
  [
    "../fixtures/desktop/host/macos-backend.ts",
    "test.fail",
    "private backend detail",
    "app.ts",
  ],
] as const) {
  test(`runtime starts without native permissions and sanitizes ${command} errors (${fixture})`, async () => {
    const entrypoint = fileURLToPath(new URL(fixture, import.meta.url));
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entrypoint,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill(), 5000);
    const errors = new Response(child.stderr).text();
    const output = readJsonLines(child.stdout)[Symbol.asyncIterator]();
    const next = async () => {
      const line = await output.next();
      if (line.done) {
        throw new Error("Unexpected runtime EOF.");
      }
      return parseProcessFrame(line.value);
    };
    const send = (body: Record<string, unknown>) =>
      child.stdin.write(
        `${JSON.stringify({
          ...body,
          ipc: PROTOCOL_VERSION,
          runtime: {
            id: "diagnostic",
            generation: "1",
          },
        })}\n`,
      );
    try {
      send({
        kind: "boot",
        payload: {
          entrypoint,
          buildId: "test",
          backendContext: "backend-test",
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
                  command,
                ],
                events: [],
                host: {
                  permissions: [],
                },
              },
            ],
          },
        },
      });
      expect((await next()).kind).toBe("hello");
      send({
        kind: "hello",
        payload: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          features: [],
          buildId: "host",
        },
      });
      expect((await next()).kind).toBe("ready");
      send({
        kind: "session-open",
        context: "view-test",
        viewId: "main",
      });
      send({
        kind: "web",
        context: "view-test",
        payload: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          features: [],
          buildId: "ui",
        },
      });
      expect((await next()).kind).toBe("web");
      send({
        kind: "web",
        context: "view-test",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: "fail-1",
          command,
          payload: null,
        },
      });
      const reply = await next();
      expect(reply.kind).toBe("web");
      if (reply.kind !== "web") {
        throw new Error("Expected web response.");
      }
      expect(reply.payload).toEqual({
        kind: "error",
        protocol: PROTOCOL_VERSION,
        id: "fail-1",
        error: {
          code: "INTERNAL",
          message: "Command failed.",
        },
      });
      send({
        kind: "shutdown",
      });
      child.stdin.end();
      expect((await next()).kind).toBe("stopping");
      expect(await child.exited).toBe(0);
      const stderr = await errors;
      expect(stderr).toContain(`Command ${command} failed:`);
      expect(stderr).toContain(detail);
      expect(stderr).toContain(stackFile);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  });
}

for (const phase of [
  "before boot",
  "during plugin setup",
] as const) {
  test(`Bun runtime shutdown ${phase} releases stdin without waiting for a Host reply`, async () => {
    const entrypoint = fileURLToPath(
      new URL("./runtime-fixture.ts", import.meta.url),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entrypoint,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill(), 3000);
    try {
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      const envelope = {
        ipc: PROTOCOL_VERSION,
        runtime: {
          id: "test",
          generation: "1",
        },
      };
      if (phase === "during plugin setup") {
        child.stdin.write(
          `${JSON.stringify({
            ...envelope,
            kind: "boot",
            payload: {
              entrypoint,
              buildId: "test",
              backendContext: "backend-test",
              policy: {
                version: 1,
                views: [],
                backend: {
                  permissions: [
                    "log:write",
                  ],
                },
              },
            },
          })}\n`,
        );
      }
      child.stdin.write(
        `${JSON.stringify({
          ...envelope,
          kind: "shutdown",
        })}\n`,
      );
      child.stdin.end();
      expect(await child.exited).toBe(0);
      const frames = (await output).trim().split("\n").map(parseProcessFrame);
      expect(frames.at(-1)?.kind).toBe("stopping");
      expect(
        frames.some(
          (frame) => frame.kind === "fatal" || frame.kind === "ready",
        ),
      ).toBe(false);
      expect(await errors).toBe("");
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  });
}

test("Bun core startup Host API, response correlation, cancel, revoke and shutdown", async () => {
  const entrypoint = fileURLToPath(
    new URL("./runtime-fixture.ts", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      entrypoint,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 5000);
  const errors = new Response(child.stderr).text();
  const output = readJsonLines(child.stdout)[Symbol.asyncIterator]();
  const next = async () => {
    const line = await output.next();
    expect(line.done).toBe(false);
    if (line.done) {
      throw new Error("Unexpected runtime EOF.");
    }
    return parseProcessFrame(line.value);
  };
  const send = (body: Record<string, unknown>) =>
    child.stdin.write(
      `${JSON.stringify({
        ...body,
        ipc: PROTOCOL_VERSION,
        runtime: {
          id: "test",
          generation: "1",
        },
      })}\n`,
    );
  const web = (context: string, payload: Record<string, unknown>) =>
    send({
      kind: "web",
      context,
      payload: {
        protocol: PROTOCOL_VERSION,
        ...payload,
      },
    });
  try {
    send({
      kind: "boot",
      payload: {
        entrypoint,
        buildId: "test",
        backendContext: "backend-test",
        policy: {
          version: 1,
          backend: {
            permissions: [
              "log:write",
            ],
          },
          views: [
            {
              id: "main",
              origins: [
                "https://app.bunaway.local",
              ],
              commands: [
                "read",
              ],
              events: [],
              host: {
                permissions: [
                  {
                    identifier: "storage:read-text",
                    allow: [
                      {
                        scope: "appData",
                        pathPrefix: "notes",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    });
    expect((await next()).kind).toBe("hello");
    send({
      kind: "hello",
      payload: {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [],
        buildId: "host",
      },
    });
    const setup = await next();
    expect(setup.kind).toBe("host-request");
    if (setup.kind !== "host-request") {
      throw new Error("Expected startup Host API");
    }
    send({
      kind: "host-response",
      context: setup.context,
      requestId: setup.requestId,
      payload: {
        kind: "result",
        payload: null,
      },
    });
    expect((await next()).kind).toBe("ready");
    send({
      kind: "session-open",
      context: "ctx-first",
      viewId: "main",
    });
    web("ctx-first", {
      kind: "hello",
      features: [],
      buildId: "ui",
    });
    expect((await next()).kind).toBe("web");
    web("ctx-first", {
      kind: "invoke",
      id: "read-1",
      command: "read",
      payload: null,
    });
    const request = await next();
    expect(request.kind).toBe("host-request");
    if (request.kind !== "host-request") {
      throw new Error("Expected host request");
    }
    // A response with the wrong context must not resolve the request.
    send({
      kind: "host-response",
      context: "ctx-wrong",
      requestId: request.requestId,
      payload: {
        kind: "result",
        payload: "wrong",
      },
    });
    web("ctx-first", {
      kind: "cancel",
      id: "read-1",
    });
    const cancelled = [
      await next(),
      await next(),
    ];
    expect(
      cancelled.some(
        (frame) =>
          frame.kind === "host-cancel" && frame.requestId === request.requestId,
      ),
    ).toBe(true);
    expect(
      cancelled.some(
        (frame) =>
          frame.kind === "web" &&
          frame.payload.kind === "error" &&
          frame.payload.error.code === "CANCELLED",
      ),
    ).toBe(true);
    send({
      kind: "host-response",
      context: request.context,
      requestId: request.requestId,
      payload: {
        kind: "result",
        payload: "late",
      },
    });
    web("ctx-first", {
      kind: "invoke",
      id: "read-2",
      command: "read",
      payload: null,
    });
    const revoked = await next();
    expect(revoked.kind).toBe("host-request");
    send({
      kind: "revoke",
      context: "ctx-first",
    });
    expect((await next()).kind).toBe("host-cancel");
    send({
      kind: "session-open",
      context: "ctx-second",
      viewId: "main",
    });
    web("ctx-second", {
      kind: "hello",
      features: [],
      buildId: "ui",
    });
    expect((await next()).kind).toBe("web");
    web("ctx-second", {
      kind: "invoke",
      id: "read-3",
      command: "read",
      payload: null,
    });
    const success = await next();
    if (success.kind !== "host-request") {
      throw new Error("Expected host request");
    }
    send({
      kind: "host-response",
      context: success.context,
      requestId: success.requestId,
      payload: {
        kind: "result",
        payload: "saved",
      },
    });
    const result: ProcessFrame = await next();
    expect(
      result.kind === "web" &&
        result.payload.kind === "result" &&
        result.payload.payload,
    ).toBe("saved");
    send({
      kind: "shutdown",
    });
    expect((await next()).kind).toBe("stopping");
    expect(await child.exited).toBe(0);
    expect((await output.next()).done).toBe(true);
    expect(await errors).toBe("plugin-stopped\n");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
}, 10000);
