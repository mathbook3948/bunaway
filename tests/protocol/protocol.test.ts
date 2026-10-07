import { describe, expect, test } from "bun:test";
import type {
  Hello,
  Message,
  Policy,
} from "../../packages/protocol/src/index.ts";
import {
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  negotiateProtocol,
  ProtocolError,
  parseHostCall,
  parseMessage,
  parsePolicy,
  serializeMessage,
} from "../../packages/protocol/src/index.ts";
import { parseWindowCall } from "../../plugins/windows/src/index.ts";
import { registry } from "../fixtures/host-plugins.ts";

const protocol = {
  major: 1,
  minor: 0,
} as const;

function invoke(payload: unknown): Message {
  return {
    kind: "invoke",
    protocol,
    id: "request:1",
    command: "notes.read",
    payload,
  } as Message;
}

function expectProtocolError(
  action: () => unknown,
  code: ProtocolError["code"] = "INVALID_ARGUMENT",
): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProtocolError);
  expect((error as ProtocolError).code).toBe(code);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function messageTextAtBytes(size: number, prefix = ""): string {
  const base = JSON.stringify(invoke(""));
  const marker = '"payload":';
  const valueStart = base.indexOf(marker) + marker.length;
  const contentBytes = size - utf8Bytes(base) - utf8Bytes(prefix);
  if (contentBytes < 0) {
    throw new Error("Requested size is smaller than the message envelope.");
  }
  const text = `${base.slice(0, valueStart)}"${prefix}${"a".repeat(contentBytes)}"${base.slice(valueStart + 2)}`;
  if (utf8Bytes(text) !== size) {
    throw new Error("Could not construct the requested UTF-8 size.");
  }
  return text;
}

function nested(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index++) {
    value = {
      next: value,
    };
  }
  return value;
}

const validView = {
  id: "main",
  origins: [
    "https://app.bunaway.local",
  ],
  commands: [
    "notes.read",
  ],
  events: [
    "notes.changed",
  ],
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
} satisfies Policy["views"][number];

const validPolicy = {
  version: 1,
  views: [
    validView,
  ],
  backend: {
    permissions: [],
  },
} satisfies Policy;

describe("protocol messages", () => {
  test("round-trips every message variant", () => {
    const messages: Message[] = [
      {
        kind: "hello",
        protocol,
        features: [
          "events",
        ],
        buildId: "ui.1",
      },
      invoke({
        origin: "app supplied data",
        nested: [
          1,
          true,
          null,
        ],
      }),
      {
        kind: "cancel",
        protocol,
        id: "request:1",
      },
      {
        kind: "listen",
        protocol,
        id: "request:2",
        event: "notes.changed",
      },
      {
        kind: "unlisten",
        protocol,
        id: "request:3",
        subscriptionId: "sub:1",
      },
      {
        kind: "result",
        protocol,
        id: "request:1",
        payload: {
          value: "ok",
        },
      },
      {
        kind: "error",
        protocol,
        id: "request:1",
        error: {
          code: "PERMISSION_DENIED",
          message: "Denied",
          details: {
            scope: "notes",
          },
        },
      },
      {
        kind: "event",
        protocol,
        subscriptionId: "sub:1",
        source: "backend",
        target: "main",
        event: "notes.changed",
        sequence: 1,
        payload: {
          key: "welcome",
        },
      },
      {
        kind: "subscription-error",
        protocol,
        subscriptionId: "sub:1",
        error: {
          code: "BUSY",
          message: "Queue full",
        },
      },
    ];

    for (const message of messages) {
      expect(parseMessage(serializeMessage(message))).toEqual(message);
    }
  });

  test("rejects malformed JSON and envelopes with spoofed host metadata", () => {
    expectProtocolError(() => parseMessage("{"));
    expectProtocolError(() => parseMessage("null"));
    expectProtocolError(() =>
      parseMessage(
        JSON.stringify({
          ...messagesHello(),
          kind: "unknown",
        }),
      ),
    );

    for (const field of [
      "origin",
      "frame",
      "frameId",
      "viewId",
      "permissions",
      "token",
      "context",
    ]) {
      const spoofed = {
        ...messagesHello(),
        [field]: "https://evil.example",
      };
      expectProtocolError(() => parseMessage(JSON.stringify(spoofed)));
    }

    expectProtocolError(() =>
      parseMessage(
        JSON.stringify({
          ...messagesHello(),
          protocol: {
            major: 1.5,
            minor: 0,
          },
        }),
      ),
    );
  });

  test("rejects values JSON cannot faithfully represent without invoking getters", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    class CustomPayload {
      value = 1;
    }

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      },
    });

    const sparse = Array(1);
    const SubclassArray = class extends Array<unknown> {};
    const invalidPayloads: unknown[] = [
      cycle,
      new CustomPayload(),
      accessor,
      undefined,
      {
        value: undefined,
      },
      () => 1,
      {
        value: () => 1,
      },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      sparse,
      new SubclassArray("value"),
      {
        [Symbol("hidden")]: 1,
      },
      Object.defineProperty({}, "hidden", {
        value: 1,
      }),
      Object.assign(
        [
          1,
        ],
        {
          extra: 2,
        },
      ),
      1n,
    ];

    for (const payload of invalidPayloads) {
      expectProtocolError(() => serializeMessage(invoke(payload)));
    }
    expect(getterCalls).toBe(0);
  });

  test("accepts the exact UTF-8 byte limit and rejects one byte over", () => {
    const atLimit = messageTextAtBytes(MAX_MESSAGE_BYTES, "é한💡");
    const parsed = parseMessage(atLimit);
    expect(utf8Bytes(serializeMessage(parsed))).toBe(MAX_MESSAGE_BYTES);

    const overLimit = messageTextAtBytes(MAX_MESSAGE_BYTES + 1, "é한💡");
    expectProtocolError(() => parseMessage(overLimit));
    expectProtocolError(() =>
      serializeMessage(JSON.parse(overLimit) as Message),
    );
  });

  test("measures JSON depth from root depth zero through the limit", () => {
    expect(MAX_JSON_DEPTH).toBe(64);
    const atLimit = invoke(nested(MAX_JSON_DEPTH - 1));
    expect(parseMessage(serializeMessage(atLimit))).toEqual(atLimit);

    const overLimit = invoke(nested(MAX_JSON_DEPTH));
    expectProtocolError(() => serializeMessage(overLimit));
    expectProtocolError(() => parseMessage(JSON.stringify(overLimit)));
  });

  test("rejects invalid identifier, numeric, and feature fields", () => {
    for (const invalid of [
      {
        ...invoke(null),
        id: "request\n",
      },
      {
        ...invoke(null),
        id: "",
      },
      {
        ...invoke(null),
        deadline: -1,
      },
      {
        ...invoke(null),
        deadline: 1.5,
      },
      {
        ...invoke(null),
        deadline: Number.MAX_SAFE_INTEGER + 1,
      },
      {
        ...messagesHello(),
        features: [
          "events",
          "events",
        ],
      },
      {
        ...messagesHello(),
        protocol: {
          major: 1,
          minor: -1,
        },
      },
      {
        ...messagesHello(),
        protocol: {
          major: 65536,
          minor: 0,
        },
      },
    ]) {
      expectProtocolError(() => parseMessage(JSON.stringify(invalid)));
    }
    expectProtocolError(() =>
      parseMessage(
        JSON.stringify(invoke("PLACEHOLDER")).replace('"PLACEHOLDER"', "1e999"),
      ),
    );
  });

  test("permits repeated references without cycles and null-prototype JSON objects", () => {
    const shared = {
      key: "value",
    };
    const data = Object.assign(Object.create(null), {
      first: shared,
      second: shared,
    });
    expect(parseMessage(serializeMessage(invoke(data)))).toEqual(
      invoke({
        first: shared,
        second: shared,
      }),
    );
  });

  test("serializes the validated snapshot without reading dynamic properties again", () => {
    const source = invoke({
      value: 1,
    });
    let dynamicReads = 0;
    const dynamic = new Proxy(source, {
      get(target, key, receiver) {
        if (key === "kind") {
          dynamicReads++;
          return undefined;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(parseMessage(serializeMessage(dynamic))).toEqual(source);
    expect(dynamicReads).toBe(0);

    const throwing = new Proxy(source, {
      ownKeys() {
        throw new Error("private diagnostic");
      },
    });
    expectProtocolError(() => serializeMessage(throwing));
    expect(() => serializeMessage(throwing)).toThrow("Invalid protocol data.");
  });

  test("bounds repeated subtrees before creating an oversized JSON string", () => {
    let payload: unknown = null;
    for (let i = 0; i < 32; i++) {
      payload = {
        left: payload,
        right: payload,
      };
    }
    expectProtocolError(() => serializeMessage(invoke(payload)));
  });

  test("uses IEEE-754 numbers and the last duplicate member, matching the wire contract", () => {
    const text = JSON.stringify(invoke("NUMBER"))
      .replace('"NUMBER"', "9007199254740993")
      .replace('"kind":"invoke"', '"kind":"hello","kind":"invoke"');
    expect(parseMessage(text)).toEqual(invoke(9007199254740992));
  });
});

describe("protocol negotiation", () => {
  test("chooses the lower minor version and sorted feature intersection", () => {
    const local: Hello = {
      kind: "hello",
      protocol: {
        major: 1,
        minor: 7,
      },
      features: [
        "storage",
        "events",
        "logging",
      ],
      buildId: "host.1",
    };
    const remote: Hello = {
      kind: "hello",
      protocol: {
        major: 1,
        minor: 2,
      },
      features: [
        "events",
        "unknown",
      ],
      buildId: "ui.1",
    };

    expect(negotiateProtocol(local, remote)).toEqual({
      protocol: {
        major: 1,
        minor: 2,
      },
      features: [
        "events",
      ],
    });
  });

  test("rejects incompatible major versions", () => {
    const local: Hello = {
      kind: "hello",
      protocol: {
        major: 1,
        minor: 0,
      },
      features: [],
      buildId: "host.1",
    };
    const remote: Hello = {
      kind: "hello",
      protocol: {
        major: 2,
        minor: 0,
      },
      features: [],
      buildId: "ui.1",
    };

    expectProtocolError(() => negotiateProtocol(local, remote), "UNSUPPORTED");
  });
});

describe("policy validation", () => {
  test("accepts a valid policy", () => {
    expect(parsePolicy(JSON.stringify(validPolicy))).toEqual(validPolicy);
  });

  test("rejects duplicate view IDs", () => {
    const policy = {
      ...validPolicy,
      views: [
        validView,
        validView,
      ],
    };
    expectProtocolError(() => parsePolicy(JSON.stringify(policy)));
  });

  test("rejects wildcard origins and command names", () => {
    const wildcardOrigin = {
      ...validPolicy,
      views: [
        {
          ...validView,
          origins: [
            "https://*.example.com",
          ],
        },
      ],
    };
    expectProtocolError(() => parsePolicy(JSON.stringify(wildcardOrigin)));

    const wildcardCommand = {
      ...validPolicy,
      views: [
        {
          ...validView,
          commands: [
            "*",
          ],
        },
      ],
    };
    expectProtocolError(() => parsePolicy(JSON.stringify(wildcardCommand)));
  });

  test("rejects path traversal in storage prefixes", () => {
    for (const pathPrefix of [
      "notes/../private",
      "notes\n",
      "/absolute",
      "notes\\other",
    ]) {
      const view = {
        ...validView,
        host: {
          ...validView.host,
          permissions: [
            {
              identifier: "storage:read-text",
              allow: [
                {
                  scope: "appData",
                  pathPrefix,
                },
              ],
            },
          ],
        },
      };
      expect(() =>
        registry.validatePolicy(
          parsePolicy(
            JSON.stringify({
              ...validPolicy,
              views: [
                view,
              ],
            }),
          ),
        ),
      ).toThrow();
    }
  });

  test("rejects unknown policy fields and trailing newlines", () => {
    expectProtocolError(() =>
      parsePolicy(
        JSON.stringify({
          ...validPolicy,
          allowAll: true,
        }),
      ),
    );
    const policy = {
      ...validPolicy,
      views: [
        {
          ...validView,
          origins: [
            "https://app.bunaway.local\n",
          ],
        },
      ],
    };
    expectProtocolError(() => parsePolicy(JSON.stringify(policy)));
  });

  test("the protocol rejects the former built-in window grants", () => {
    expect(() =>
      parsePolicy(
        JSON.stringify({
          ...validPolicy,
          backend: {
            permissions: [],
            windows: [
              "main",
            ],
          },
        }),
      ),
    ).toThrow();
  });
});

function messagesHello(): Message {
  return {
    kind: "hello",
    protocol,
    features: [],
    buildId: "ui.1",
  };
}

test("window operations reject invalid geometry, arbitrary fields and invalid close messages", () => {
  const invalid = [
    {
      operation: "windows.create",
      payload: {
        view: "main",
        home: "https://remote.example",
      },
    },
    {
      operation: "windows.setSize",
      payload: {
        view: "main",
        width: 199,
        height: 600,
      },
    },
    {
      operation: "windows.setSize",
      payload: {
        view: "main",
        width: 800.5,
        height: 600,
      },
    },
    {
      operation: "windows.setPosition",
      payload: {
        view: "main",
        x: 32768,
        y: 0,
      },
    },
    {
      operation: "windows.setFullscreen",
      payload: {
        view: "main",
        fullscreen: 1,
      },
    },
    {
      operation: "windows.setCloseConfirmation",
      payload: {
        view: "main",
        message: "",
      },
    },
    {
      operation: "windows.setCloseConfirmation",
      payload: {
        view: "main",
        message: "bad\0message",
      },
    },
    {
      operation: "windows.show",
      payload: {
        view: "bad\n",
      },
    },
  ];
  for (const call of invalid) {
    expect(() => parseWindowCall(JSON.stringify(call))).toThrow();
  }
  expect(
    parseWindowCall(
      JSON.stringify({
        operation: "windows.setCloseConfirmation",
        payload: {
          view: "main",
          message: null,
        },
      }),
    ),
  ).toEqual({
    operation: "windows.setCloseConfirmation",
    payload: {
      view: "main",
      message: null,
    },
  });
  expect(
    parseHostCall(
      JSON.stringify({
        operation: "plugin.custom.action",
        payload: {
          enabled: true,
        },
      }),
    ),
  ).toEqual({
    operation: "plugin.custom.action",
    payload: {
      enabled: true,
    },
  });
  expect(() =>
    parseWindowCall(
      JSON.stringify({
        operation: "plugin.custom.action",
        payload: null,
      }),
    ),
  ).toThrow();
});
