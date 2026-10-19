import { expect, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import {
  API_LIMITS,
  type HostContext,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type RuntimeIdentity,
} from "@bunaway/protocol";
import {
  Channel,
  MAX_OPEN_URLS,
  MAX_OPEN_URLS_BYTES,
  type Packet,
  type Route,
  validatePacket,
} from "@bunaway/runtime-bun/worker-channel";

type Side = Parameters<typeof validatePacket>[1];
const sides: readonly Side[] = [
  "main",
  "ui",
  "io",
  "main-io",
  "macos-main",
  "macos-backend",
];
const opposite: Record<Side, Side> = {
  main: "ui",
  ui: "main",
  io: "main-io",
  "main-io": "io",
  "macos-main": "macos-backend",
  "macos-backend": "macos-main",
};
const context = "context:1" as HostContext;
const route: Route = {
  viewId: "view:1",
  documentGeneration: 0,
  context,
};
const request = {
  context,
  requestId: "request:1",
};
const call = {
  operation: "example.run",
  payload: null,
};
const response = {
  kind: "result",
  payload: null,
} as const;
const error = {
  code: "INTERNAL",
  message: "failed",
} as const;
const hello = {
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "test",
} as const;

function fixture<P extends Packet>(
  packet: P,
  ...incoming: [
    Side,
    ...Side[],
  ]
) {
  return {
    packet,
    incoming,
  };
}

// These independent wire fixtures cover every discriminator and every receiving side.
const fixtures = {
  "native-register": fixture(
    {
      kind: "native-register",
      plugins: [],
      complete: true,
    },
    "macos-main",
  ),
  ready: fixture(
    {
      kind: "ready",
    },
    "main",
    "main-io",
    "macos-main",
  ),
  start: fixture(
    {
      kind: "start",
    },
    "ui",
  ),
  shutdown: fixture(
    {
      kind: "shutdown",
    },
    "ui",
    "io",
    "macos-backend",
  ),
  closing: fixture(
    {
      kind: "closing",
      reason: "window-destroyed",
    },
    "main",
    "macos-backend",
  ),
  "desktop-config": fixture(
    {
      kind: "desktop-config",
      closeBehavior: "keep-alive",
      reopenHandler: true,
    },
    "macos-main",
  ),
  "open-urls": fixture(
    {
      kind: "open-urls",
      urls: [
        "bunaway-test://open/path?q=1",
      ],
    },
    "macos-backend",
  ),
  reopen: fixture(
    {
      kind: "reopen",
      hasVisibleWindows: false,
    },
    "macos-backend",
  ),
  "native-stopped": fixture(
    {
      kind: "native-stopped",
    },
    "macos-backend",
  ),
  "windows-empty": fixture(
    {
      kind: "windows-empty",
    },
    "main",
    "macos-backend",
  ),
  "session-end": fixture(
    {
      kind: "session-end",
      flags: {
        logoff: true,
        critical: false,
        closeApp: false,
      },
      release: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    },
    "main",
  ),
  cleaned: fixture(
    {
      kind: "cleaned",
    },
    "main",
    "main-io",
    "macos-main",
  ),
  "desktop-control": fixture(
    {
      kind: "desktop-control",
      action: "show",
    },
    "ui",
    "macos-main",
  ),
  "quit-request": fixture(
    {
      kind: "quit-request",
      reason: "tray",
    },
    "main",
    "macos-backend",
  ),
  "quit-cancelled": fixture(
    {
      kind: "quit-cancelled",
    },
    "ui",
    "macos-main",
  ),
  "shutdown-committed": fixture(
    {
      kind: "shutdown-committed",
    },
    "ui",
    "macos-main",
  ),
  "exit-code": fixture(
    {
      kind: "exit-code",
      exitCode: 3,
      relaunch: false,
    },
    "macos-main",
  ),
  "session-open": fixture(
    {
      kind: "session-open",
      route,
    },
    "main",
    "macos-backend",
  ),
  revoke: fixture(
    {
      kind: "revoke",
      route,
    },
    "main",
    "macos-backend",
  ),
  client: fixture(
    {
      kind: "client",
      route,
      message: {
        kind: "sdk-ready",
        protocol: PROTOCOL_VERSION,
      },
    },
    "main",
    "macos-backend",
  ),
  "native-event": fixture(
    {
      kind: "native-event",
      route,
      event: "example.changed",
      payload: null,
    },
    "main",
    "macos-backend",
  ),
  server: fixture(
    {
      kind: "server",
      route,
      message: {
        kind: "result",
        protocol: PROTOCOL_VERSION,
        id: "request:1",
        payload: null,
      },
    },
    "ui",
    "macos-main",
  ),
  "session-failure": fixture(
    {
      kind: "session-failure",
      route,
      error,
    },
    "ui",
  ),
  "authorize-input": fixture(
    {
      kind: "authorize-input",
      ...request,
      call,
    },
    "ui",
    "main-io",
  ),
  "input-authorized": fixture(
    {
      kind: "input-authorized",
      ...request,
      allowed: true,
    },
    "main",
    "io",
  ),
  authorize: fixture(
    {
      kind: "authorize",
      ...request,
      call,
    },
    "ui",
  ),
  prepare: fixture(
    {
      kind: "prepare",
      ...request,
      call,
    },
    "main",
    "main-io",
  ),
  operation: fixture(
    {
      kind: "operation",
      ...request,
      call,
      source: "backend",
    },
    "ui",
    "io",
    "macos-main",
  ),
  grant: fixture(
    {
      kind: "grant",
      ...request,
      allowed: false,
    },
    "ui",
    "io",
  ),
  authorized: fixture(
    {
      kind: "authorized",
      ...request,
      allowed: false,
    },
    "main",
  ),
  cancel: fixture(
    {
      kind: "cancel",
      ...request,
    },
    "ui",
    "io",
    "macos-main",
  ),
  "cancel-context": fixture(
    {
      kind: "cancel-context",
      context,
    },
    "ui",
    "io",
  ),
  "host-result": fixture(
    {
      kind: "host-result",
      ...request,
      response,
    },
    "ui",
  ),
  "host-response": fixture(
    {
      kind: "host-response",
      ...request,
      response,
    },
    "main",
    "main-io",
    "macos-backend",
  ),
  diagnostic: fixture(
    {
      kind: "diagnostic",
      event: "example.changed",
      fields: {
        count: 1,
      },
    },
    "main",
    "macos-main",
  ),
  fatal: fixture(
    {
      kind: "fatal",
      error,
    },
    "main",
    "main-io",
    "macos-main",
  ),
} satisfies {
  [Kind in Packet["kind"]]: {
    packet: Extract<
      Packet,
      {
        kind: Kind;
      }
    >;
    incoming: [
      Side,
      ...Side[],
    ];
  };
};

test.each(Object.values(fixtures))(
  "$packet.kind accepts only its declared wire directions and exact fields",
  ({ packet, incoming }) => {
    for (const side of sides) {
      if (incoming.some((allowed) => allowed === side)) {
        // Validation preserves the cloned packet, including explicit null payloads.
        expect(validatePacket(packet, side)).toBe(packet);
      } else {
        expect(() => validatePacket(packet, side)).toThrow(
          "Invalid Worker direction",
        );
      }
    }
    const side = incoming[0];
    expect(() =>
      validatePacket(
        {
          ...packet,
          extra: true,
        },
        side,
      ),
    ).toThrow("Invalid Worker fields");
    for (const key of Object.keys(packet).filter((key) => key !== "kind")) {
      const missing: Record<string, unknown> = {
        ...packet,
      };
      delete missing[key];
      expect(() => validatePacket(missing, side)).toThrow(
        "Invalid Worker fields",
      );
      expect(() =>
        validatePacket(
          {
            ...packet,
            [key]: undefined,
          },
          side,
        ),
      ).toThrow();
    }
  },
);

test("Worker packets reject non-records, unknown discriminators and inherited required fields", () => {
  for (const value of [
    null,
    [],
    false,
    "ready",
    {
      kind: "toString",
    },
    {
      kind: "__proto__",
    },
    {
      kind: "unknown",
    },
    {
      kind: 1,
    },
    {},
  ]) {
    expect(() => validatePacket(value, "main")).toThrow();
  }
  const inherited = Object.create({
    route,
  });
  inherited.kind = "session-open";
  expect(() => validatePacket(inherited, "main")).toThrow(
    "Invalid Worker fields",
  );
});

test("Worker packets retain nested Web direction and bidirectional hello negotiation", () => {
  expect(
    validatePacket(
      {
        kind: "client",
        route,
        message: hello,
      },
      "main",
    ).kind,
  ).toBe("client");
  expect(
    validatePacket(
      {
        kind: "server",
        route,
        message: hello,
      },
      "ui",
    ).kind,
  ).toBe("server");
  expect(() =>
    validatePacket(
      {
        ...fixtures.client.packet,
        message: fixtures.server.packet.message,
      },
      "main",
    ),
  ).toThrow("Invalid Web direction");
  expect(() =>
    validatePacket(
      {
        ...fixtures.server.packet,
        message: fixtures.client.packet.message,
      },
      "ui",
    ),
  ).toThrow("Invalid Web direction");
  for (const kind of [
    "client",
    "server",
  ] as const) {
    const side = fixtures[kind].incoming[0];
    expect(() =>
      validatePacket(
        {
          kind,
          route,
          message: {
            ...hello,
            extra: true,
          },
        },
        side,
      ),
    ).toThrow();
    expect(() =>
      validatePacket(
        {
          kind,
          route,
          message: {
            ...hello,
            protocol: {
              major: -1,
              minor: 0,
            },
          },
        },
        side,
      ),
    ).toThrow();
  }
});

test("Worker packets validate route identities, document generations and nested payload contracts", () => {
  for (const invalid of [
    null,
    [],
    {
      ...route,
      context: "",
    },
    {
      ...route,
      viewId: "bad id",
    },
    {
      ...route,
      documentGeneration: -1,
    },
    {
      ...route,
      documentGeneration: 0.5,
    },
    {
      ...route,
      documentGeneration: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      ...route,
      extra: true,
    },
  ]) {
    expect(() =>
      validatePacket(
        {
          kind: "session-open",
          route: invalid,
        },
        "main",
      ),
    ).toThrow();
  }
  for (const kind of [
    "authorize-input",
    "authorize",
    "prepare",
    "operation",
  ] as const) {
    const fixture = fixtures[kind];
    for (const invalid of [
      {
        operation: "example.run",
      },
      {
        ...call,
        operation: "bad operation",
      },
      {
        ...call,
        extra: true,
      },
    ]) {
      expect(() =>
        validatePacket(
          {
            ...fixture.packet,
            call: invalid,
          },
          fixture.incoming[0],
        ),
      ).toThrow();
    }
    expect(() =>
      validatePacket(
        {
          ...fixture.packet,
          context: "",
        },
        fixture.incoming[0],
      ),
    ).toThrow("Invalid Worker identifier");
    expect(() =>
      validatePacket(
        {
          ...fixture.packet,
          requestId: "bad id",
        },
        fixture.incoming[0],
      ),
    ).toThrow("Invalid Worker identifier");
  }
  for (const kind of [
    "input-authorized",
    "authorized",
    "grant",
  ] as const) {
    const fixture = fixtures[kind];
    expect(() =>
      validatePacket(
        {
          ...fixture.packet,
          allowed: "false",
        },
        fixture.incoming[0],
      ),
    ).toThrow("Invalid authorization");
  }
  for (const kind of [
    "host-response",
    "host-result",
  ] as const) {
    const fixture = fixtures[kind];
    expect(() =>
      validatePacket(
        {
          ...fixture.packet,
          response: {
            kind: "result",
          },
        },
        fixture.incoming[0],
      ),
    ).toThrow();
    const failure = {
      ...fixture.packet,
      response: {
        kind: "error",
        error,
      },
    } satisfies Packet;
    expect(validatePacket(failure, fixture.incoming[0])).toBe(failure);
  }
  for (const kind of [
    "fatal",
    "session-failure",
  ] as const) {
    const fixture = fixtures[kind];
    expect(() =>
      validatePacket(
        {
          ...fixture.packet,
          error: {
            ...error,
            code: "UNKNOWN",
          },
        },
        fixture.incoming[0],
      ),
    ).toThrow();
  }
  expect(() =>
    validatePacket(
      {
        ...fixtures["native-event"].packet,
        payload: Number.NaN,
      },
      "main",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        ...fixtures.diagnostic.packet,
        fields: [],
      },
      "main",
    ),
  ).toThrow();
});

test("macOS desktop lifecycle packets travel only in their declared direction with their own values", () => {
  // Main thread to backend: the quit command is a valid quit request reason, `api` never travels.
  for (const reason of [
    "last-window",
    "quit-command",
  ]) {
    expect(
      validatePacket(
        {
          kind: "quit-request",
          reason,
        },
        "macos-backend",
      ).kind,
    ).toBe("quit-request");
  }
  expect(() =>
    validatePacket(
      {
        kind: "quit-request",
        reason: "api",
      },
      "macos-backend",
    ),
  ).toThrow("Invalid quit reason");
  expect(() =>
    validatePacket(
      {
        kind: "quit-request",
        reason: "quit-command",
      },
      "macos-main",
    ),
  ).toThrow("Invalid Worker direction");
  // `closing` is reported to the main thread by the Windows UI and to the macOS backend by its main thread.
  for (const side of [
    "main",
    "macos-backend",
  ] as const) {
    expect(
      validatePacket(
        {
          kind: "closing",
          reason: "session-end",
        },
        side,
      ).kind,
    ).toBe("closing");
  }
  expect(
    validatePacket(
      {
        kind: "closing",
        reason: "quit-command",
      },
      "macos-backend",
    ).kind,
  ).toBe("closing");
  expect(() =>
    validatePacket(
      {
        kind: "closing",
        reason: "session-end",
      },
      "macos-main",
    ),
  ).toThrow("Invalid Worker direction");
  // Backend to main thread.
  for (const kind of [
    "shutdown-committed",
    "quit-cancelled",
  ] as const) {
    expect(
      validatePacket(
        {
          kind,
        },
        "macos-main",
      ).kind,
    ).toBe(kind);
    expect(() =>
      validatePacket(
        {
          kind,
        },
        "macos-backend",
      ),
    ).toThrow("Invalid Worker direction");
  }
  expect(
    validatePacket(
      {
        kind: "desktop-control",
        action: "show",
      },
      "macos-main",
    ).kind,
  ).toBe("desktop-control");
  expect(
    validatePacket(
      {
        kind: "desktop-config",
        closeBehavior: "quit",
        reopenHandler: false,
      },
      "macos-main",
    ).kind,
  ).toBe("desktop-config");
  // A hiding app needs a tray, which macOS does not offer.
  expect(() =>
    validatePacket(
      {
        kind: "desktop-config",
        closeBehavior: "hide",
        reopenHandler: false,
      },
      "macos-main",
    ),
  ).toThrow("Invalid desktop close behavior");
  expect(() =>
    validatePacket(
      {
        kind: "desktop-config",
        closeBehavior: "quit",
        reopenHandler: false,
      },
      "macos-backend",
    ),
  ).toThrow("Invalid Worker direction");
  // Main thread to backend: bounded open-URL lists and the reopen notice.
  expect(
    validatePacket(
      {
        kind: "open-urls",
        urls: [
          "bunaway-test://a",
        ],
      },
      "macos-backend",
    ).kind,
  ).toBe("open-urls");
  for (const urls of [
    "bunaway-test://a",
    [
      1,
    ],
    Array.from(
      {
        length: MAX_OPEN_URLS + 1,
      },
      () => "a:",
    ),
    [
      "x".repeat(MAX_OPEN_URLS_BYTES + 1),
    ],
  ]) {
    expect(() =>
      validatePacket(
        {
          kind: "open-urls",
          urls,
        },
        "macos-backend",
      ),
    ).toThrow("Invalid open URL list");
  }
  expect(() =>
    validatePacket(
      {
        kind: "reopen",
        hasVisibleWindows: "yes",
      },
      "macos-backend",
    ),
  ).toThrow("Invalid Worker flag");
  // Main thread to backend: native teardown finished, and the resident app lost its last window.
  expect(
    validatePacket(
      {
        kind: "native-stopped",
      },
      "macos-backend",
    ).kind,
  ).toBe("native-stopped");
  expect(() =>
    validatePacket(
      {
        kind: "native-stopped",
      },
      "macos-main",
    ),
  ).toThrow("Invalid Worker direction");
  expect(
    validatePacket(
      {
        kind: "windows-empty",
      },
      "macos-backend",
    ).kind,
  ).toBe("windows-empty");
  expect(() =>
    validatePacket(
      {
        kind: "windows-empty",
      },
      "macos-main",
    ),
  ).toThrow("Invalid Worker direction");
});

test("Worker packets retain desktop values, operation sources and bounded registration batches", () => {
  expect(
    validatePacket(
      {
        kind: "desktop-control",
        action: "hide",
      },
      "ui",
    ).kind,
  ).toBe("desktop-control");
  expect(
    validatePacket(
      {
        kind: "quit-request",
        reason: "last-window",
      },
      "main",
    ).kind,
  ).toBe("quit-request");
  expect(() =>
    validatePacket(
      {
        kind: "desktop-control",
        action: "quit",
      },
      "ui",
    ),
  ).toThrow("Invalid desktop action");
  expect(() =>
    validatePacket(
      {
        kind: "quit-request",
        reason: "backend",
      },
      "main",
    ),
  ).toThrow("Invalid quit reason");
  for (const reason of [
    "last-window",
    "tray",
    "api",
    "window-destroyed",
    "session-end",
    "interrupted",
  ]) {
    expect(
      validatePacket(
        {
          kind: "closing",
          reason,
        },
        "main",
      ).kind,
    ).toBe("closing");
  }
  for (const closing of [
    {
      kind: "closing",
    },
    {
      kind: "closing",
      reason: "backend",
    },
  ]) {
    expect(() => validatePacket(closing, "main")).toThrow();
  }
  expect(() =>
    validatePacket(
      {
        kind: "windows-empty",
      },
      "ui",
    ),
  ).toThrow("Invalid Worker direction");
  const sessionEnd = fixtures["session-end"].packet;
  expect(validatePacket(sessionEnd, "main").kind).toBe("session-end");
  expect(() => validatePacket(sessionEnd, "ui")).toThrow(
    "Invalid Worker direction",
  );
  for (const invalid of [
    {
      ...sessionEnd,
      flags: {
        logoff: true,
        critical: false,
      },
    },
    {
      ...sessionEnd,
      flags: {
        logoff: 1,
        critical: false,
        closeApp: false,
      },
    },
    {
      ...sessionEnd,
      release: new ArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    },
    {
      ...sessionEnd,
      release: new SharedArrayBuffer(8),
    },
    {
      ...sessionEnd,
      release: undefined,
    },
  ]) {
    expect(() => validatePacket(invalid, "main")).toThrow();
  }
  for (const source of [
    "view:view:1",
    "backend",
  ]) {
    expect(
      validatePacket(
        {
          ...fixtures.operation.packet,
          source,
        },
        "ui",
      ).kind,
    ).toBe("operation");
  }
  for (const source of [
    "view:",
    "view:bad id",
    "unknown",
    1,
  ]) {
    expect(() =>
      validatePacket(
        {
          ...fixtures.operation.packet,
          source,
        },
        "ui",
      ),
    ).toThrow("Invalid operation source");
  }
  const plugin = {
    name: "example",
    version: "1",
    native: {
      operations: [
        {
          name: "example.run",
        },
      ],
    },
  };
  for (const complete of [
    false,
    true,
  ]) {
    const packet = {
      kind: "native-register",
      plugins: [
        plugin,
      ],
      complete,
    } satisfies Packet;
    expect(validatePacket(packet, "macos-main")).toBe(packet);
  }
  for (const plugins of [
    [
      plugin,
      plugin,
    ],
    [
      {
        ...plugin,
        extra: true,
      },
    ],
    [
      {
        ...plugin,
        native: {
          operations: [
            {
              name: "other.run",
            },
          ],
        },
      },
    ],
  ]) {
    expect(() =>
      validatePacket(
        {
          kind: "native-register",
          plugins,
          complete: true,
        },
        "macos-main",
      ),
    ).toThrow();
  }
  expect(() =>
    validatePacket(
      {
        ...fixtures["native-register"].packet,
        complete: false,
      },
      "macos-main",
    ),
  ).toThrow("Invalid native registrations");
});

test("Worker packet size includes UTF-8 envelope metadata and rejects cyclic input", () => {
  const packet = {
    ...fixtures.diagnostic.packet,
    fields: {
      text: "",
    },
  };
  const capacity =
    MAX_MESSAGE_BYTES + 1024 - Buffer.byteLength(JSON.stringify(packet));
  packet.fields.text =
    "é".repeat(Math.floor(capacity / 2)) + "x".repeat(capacity % 2);
  expect(validatePacket(packet, "main")).toBe(packet);
  packet.fields.text += "x";
  expect(() => validatePacket(packet, "main")).toThrow(
    "Worker packet too large",
  );
  const fields: Record<string, unknown> = {};
  fields.self = fields;
  expect(() =>
    validatePacket(
      {
        ...fixtures.diagnostic.packet,
        fields,
      },
      "main",
    ),
  ).toThrow();
});

const runtime: RuntimeIdentity = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  generation: "test-generation",
};
const dataPackets: Record<Side, Packet> = {
  main: fixtures.operation.packet,
  ui: fixtures["session-open"].packet,
  io: fixtures["host-response"].packet,
  "main-io": fixtures.operation.packet,
  "macos-main": fixtures.client.packet,
  "macos-backend": fixtures.operation.packet,
};
const reservedPackets: {
  kind: Packet["kind"];
  limit: number;
}[] = [
  ...(
    [
      "authorize-input",
      "input-authorized",
      "authorize",
      "prepare",
      "grant",
      "authorized",
    ] as const
  ).map((kind) => ({
    kind,
    limit: API_LIMITS.maxPending,
  })),
  ...(
    [
      "native-register",
      "ready",
      "start",
      "shutdown",
      "closing",
      "desktop-config",
      "open-urls",
      "reopen",
      "native-stopped",
      "windows-empty",
      "session-end",
      "cleaned",
      "desktop-control",
      "quit-request",
      "quit-cancelled",
      "shutdown-committed",
      "exit-code",
      "fatal",
    ] as const
  ).map((kind) => ({
    kind,
    limit: 16,
  })),
];

test.each(reservedPackets)(
  "$kind retains reserved capacity when the data lane is full",
  async ({ kind, limit }) => {
    const fixture = fixtures[kind];
    const side = opposite[fixture.incoming[0]];
    const { port1, port2 } = new MessageChannel();
    const failures: unknown[] = [];
    const sender = new Channel(
      port1,
      runtime,
      side,
      () => {},
      (error) => failures.push(error),
    );
    const pending: Promise<void>[] = [];
    // Leave the peer unacknowledged so every send keeps its lane's capacity occupied.
    const retain = (packet: Packet) => {
      const sent = sender.send(packet);
      void sent.catch(() => {});
      pending.push(sent);
    };
    try {
      for (let i = 0; i < API_LIMITS.maxPending; i++) {
        retain(dataPackets[side]);
      }
      expect(sender.canSend()).toBe(false);
      for (let i = 0; i < limit; i++) {
        retain(fixture.packet);
      }
      await expect(sender.send(fixture.packet)).rejects.toThrow(
        "Worker channel full",
      );
      sender.close();
      const results = await Promise.allSettled(pending);
      // Every retained send reached the bounded channel, then rejected only on close.
      expect(
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof Error &&
            result.reason.message === "Worker channel closed",
        ),
      ).toBe(true);
      expect(failures).toEqual([]);
    } finally {
      sender.close();
      port1.close();
      port2.close();
    }
  },
);

test("a nested client cancellation retains its separate lane when client data is full", async () => {
  const { port1, port2 } = new MessageChannel();
  const sender = new Channel(
    port1,
    runtime,
    "ui",
    () => {},
    () => {},
  );
  const pending: Promise<void>[] = [];
  const cancellation: Packet = {
    kind: "client",
    route,
    message: {
      kind: "cancel",
      protocol: PROTOCOL_VERSION,
      id: "request:1",
    },
  };
  try {
    for (const packet of [
      fixtures.client.packet,
      cancellation,
    ]) {
      for (let i = 0; i < API_LIMITS.maxPending; i++) {
        const sent = sender.send(packet);
        void sent.catch(() => {});
        pending.push(sent);
      }
      await expect(sender.send(packet)).rejects.toThrow("Worker channel full");
    }
    sender.close();
    const results = await Promise.allSettled(pending);
    expect(
      results.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          result.reason.message === "Worker channel closed",
      ),
    ).toBe(true);
  } finally {
    sender.close();
    port1.close();
    port2.close();
  }
});

test("modal polling observes validated control intent immediately but defers resource dispatch", async () => {
  const { port1, port2 } = new MessageChannel();
  const observed: Packet["kind"][] = [];
  const dispatched: Packet["kind"][] = [];
  const failures: unknown[] = [];
  const receiver = new Channel(
    port2,
    runtime,
    "ui",
    (packet) => {
      dispatched.push(packet.kind);
    },
    (error) => {
      failures.push(error);
    },
    (packet) => {
      observed.push(packet.kind);
    },
  );
  try {
    let sequence = 0;
    for (const packet of [
      fixtures.cancel.packet,
      fixtures["cancel-context"].packet,
      fixtures["session-failure"].packet,
      fixtures.shutdown.packet,
      fixtures.operation.packet,
    ]) {
      port1.postMessage({
        runtime,
        sequence: ++sequence,
        packet,
      });
    }
    receiver.poll();
    expect(observed).toEqual([
      "cancel",
      "cancel-context",
      "session-failure",
      "shutdown",
    ]);
    expect(dispatched).toEqual([]);
    await Promise.resolve();
    expect(dispatched).toEqual([
      ...observed,
      "operation",
    ]);
    port1.postMessage({
      runtime,
      sequence: ++sequence,
      packet: {
        kind: "cancel",
        context: 3,
        requestId: "bad",
      },
    });
    receiver.poll();
    expect(observed).toHaveLength(4);
    expect(failures).toHaveLength(1);
  } finally {
    receiver.close();
    port1.close();
    port2.close();
  }
});

test("polled cancellation interrupts native loops synchronously while ordinary cleanup remains deferred", async () => {
  const { port1, port2 } = new MessageChannel();
  const received: string[] = [];
  const interrupted: string[] = [];
  const errors: unknown[] = [];
  const receiver = new Channel(
    port2,
    runtime,
    "ui",
    (packet) => {
      received.push(packet.kind);
    },
    (error) => errors.push(error),
    (packet) => interrupted.push(packet.kind),
  );
  try {
    const packets: Packet[] = [
      {
        kind: "shutdown",
      },
      fixtures.cancel.packet,
      fixtures["cancel-context"].packet,
      fixtures.operation.packet,
    ];
    for (const [index, packet] of packets.entries()) {
      port1.postMessage({
        runtime,
        sequence: index + 1,
        packet,
      });
    }
    receiver.poll();
    expect(interrupted).toEqual([
      "shutdown",
      "cancel",
      "cancel-context",
    ]);
    expect(received).toEqual([]);
    await Promise.resolve();
    expect(received).toEqual(packets.map((packet) => packet.kind));
    expect(errors).toEqual([]);
  } finally {
    receiver.close();
    port1.close();
    port2.close();
  }
});
