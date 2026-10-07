import { expect, test } from "bun:test";
import {
  type AppDefinition,
  type CommandsOf,
  command,
  type EventsOf,
  type PluginDefinition,
} from "../../packages/backend-sdk/src/index.ts";
import {
  type Client,
  type ClientFactory,
  createClient,
  invoke,
  listen,
} from "../../packages/client-sdk/src/index.ts";
import type {
  CommandContext,
  CoreFactory,
  CoreServices,
  CoreSession,
  RuntimeServices,
} from "../../packages/core/src/index.ts";
import {
  BunawayError,
  type CancellationSignal,
  type ClientMessage,
  type HostContext,
  type HostResponse,
  type Infer,
  type JsonValue,
  NativeRegistry,
  type Policy,
  type ProcessFrame,
  parseBootstrap,
  parseHostCall,
  parseMessage,
  parsePolicy,
  parseProcessFrame,
  type ServerMessage,
  serializeHostCall,
  serializeProcessFrame,
  type Transport,
  type TransportEvent,
  validateValue,
} from "../../packages/protocol/src/index.ts";
import {
  bindHostAPI,
  contracts,
  registry,
  validateHostOutput,
} from "../fixtures/host-plugins.ts";
import {
  combinedSchema,
  implicitMixedSchema,
  implicitObjectSchema,
  type implicitRequiredSchema,
  validationCases,
} from "../protocol/validation-cases.ts";

const input = {
  type: "object",
  properties: {
    key: {
      type: "string",
      maxLength: 32,
    },
  },
  required: [
    "key",
  ],
  additionalProperties: false,
} as const;
const output = {
  type: "string",
} as const;
const emptyObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
const emptyApp = {
  commands: {
    "empty.object": command({
      input: emptyObject,
      output: emptyObject,
      handle: (input) => input,
    }),
    "empty.array": command({
      input: {
        type: "array",
        items: emptyObject,
      },
      output: {
        type: "array",
        items: emptyObject,
      },
      handle: (input) => input,
    }),
  },
  events: {},
} satisfies AppDefinition;
const optionalInput = {
  type: "object",
  properties: {
    note: {
      type: "string",
    },
  },
} as const;
const optionalApp = {
  commands: {
    "notes.optional": command({
      input: optionalInput,
      output,
      handle(input) {
        const note: string | undefined = input.note;
        return note ?? "default";
      },
    }),
  },
  events: {
    "notes.optionalChanged": optionalInput,
  },
} satisfies AppDefinition;
const combinedApp = {
  commands: {
    "notes.combined": command({
      input: combinedSchema,
      output: combinedSchema,
      handle(input) {
        const base: string = input.base;
        const note: string | undefined = input.note;
        void base;
        void note;
        if (input.kind === "a") {
          const value: string = input.value;
          void value;
        } else {
          const value: number = input.value;
          void value;
        }
        return input;
      },
    }),
  },
  events: {
    "notes.combinedChanged": combinedSchema,
  },
} satisfies AppDefinition;
const implicitApp = {
  commands: {
    "implicit.object": command({
      input: implicitObjectSchema,
      output: implicitObjectSchema,
      handle(input) {
        const id: string = input.id;
        void id;
        return input;
      },
    }),
    "implicit.mixed": command({
      input: implicitMixedSchema,
      output: implicitMixedSchema,
      handle(input) {
        if (input !== null) {
          const id: string = input.id;
          void id;
        }
        return input;
      },
    }),
  },
  events: {},
} satisfies AppDefinition;
const app = {
  commands: {
    "notes.read": command({
      input,
      output,
      handle: ({ key }, context) =>
        context.host.call(contracts["storage.readText"], {
          scope: "appData",
          path: `notes/${key}.txt`,
        }),
    }),
  },
  events: {
    "notes.changed": input,
  },
} satisfies AppDefinition;

const policy: Policy = {
  version: 1,
  views: [
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "notes.read",
        "plugin.capabilities.get",
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
    },
  ],
  backend: {
    permissions: [],
  },
};
// The fixture stands in for the trusted native/runtime adapter, not a Web payload.
const contextId = "host-session-1" as HostContext;

function context(
  host: CommandContext["host"],
  signal: CancellationSignal,
): CommandContext {
  const state = new Map<string, JsonValue>();
  return {
    host,
    signal,
    state: {
      get: (key) => state.get(key),
      set: (key, value) => {
        state.set(key, value);
      },
      delete: (key) => state.delete(key),
    },
    events: {
      async emit() {},
    },
  };
}

test("command value validation accepts decoded numbers without applying a send byte limit", async () => {
  const signal = new AbortController().signal;
  const ctx = context(
    bindHostAPI(contextId, signal, async () => ({
      kind: "result",
      payload: null,
    })),
    signal,
  );
  const definition = command({
    input: {
      type: "array",
      items: {},
    },
    output: {
      type: "integer",
    },
    handle: (input) => input.length,
  });
  expect(await definition.run(Array<number>(50000).fill(1e20), ctx)).toBe(
    50000,
  );
  await expect(
    definition.run(
      [
        Infinity,
      ],
      ctx,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("empty object command schemas retain object and array shapes at runtime", async () => {
  const signal = new AbortController().signal;
  const ctx = context(
    bindHostAPI(contextId, signal, async () => ({
      kind: "result",
      payload: null,
    })),
    signal,
  );
  expect(await emptyApp.commands["empty.object"].run({}, ctx)).toEqual({});
  expect(
    await emptyApp.commands["empty.array"].run(
      [
        {},
      ],
      ctx,
    ),
  ).toEqual([
    {},
  ]);
  for (const value of [
    42,
    null,
    [],
    {
      extra: true,
    },
  ]) {
    await expect(
      emptyApp.commands["empty.object"].run(value, ctx),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const badOutput = command({
      input: {},
      output: emptyObject,
      handle: () => value as unknown as Infer<typeof emptyObject>,
    });
    await expect(badOutput.run(null, ctx)).rejects.toMatchObject({
      code: "INTERNAL",
    });
  }
  await expect(
    emptyApp.commands["empty.array"].run(
      [
        42,
      ],
      ctx,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("anyOf commands retain common required fields and discriminate branch fields", async () => {
  const signal = new AbortController().signal;
  const ctx = context(
    bindHostAPI(contextId, signal, async () => ({
      kind: "result",
      payload: null,
    })),
    signal,
  );
  const definition = combinedApp.commands["notes.combined"];
  for (const value of [
    {
      base: "root",
      kind: "a",
      value: "text",
    },
    {
      base: "root",
      kind: "b",
      value: 42,
    },
  ]) {
    expect(await definition.run(value, ctx)).toEqual(value);
  }
  await expect(
    definition.run(
      {
        kind: "a",
        value: "text",
      },
      ctx,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});
test("implicit outer object constraints apply to object branches while preserving null branches", async () => {
  const signal = new AbortController().signal;
  const ctx = context(
    bindHostAPI(contextId, signal, async () => ({
      kind: "result",
      payload: null,
    })),
    signal,
  );
  for (const kind of [
    "a",
    "b",
  ]) {
    const value = {
      id: "root",
      kind,
    };
    expect(
      await implicitApp.commands["implicit.object"].run(value, ctx),
    ).toEqual(value);
  }
  await expect(
    implicitApp.commands["implicit.object"].run(
      {
        kind: "a",
      },
      ctx,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(
    await implicitApp.commands["implicit.mixed"].run(null, ctx),
  ).toBeNull();
});

test("duplicate policy view IDs fail on standalone, bootstrap and process boot routes", () => {
  const duplicate: Policy = {
    ...policy,
    views: [
      ...policy.views,
      ...policy.views.map((view) => ({
        ...view,
        commands: [
          "notes.delete",
        ],
      })),
    ],
  };
  for (const candidate of [
    policy,
    duplicate,
  ]) {
    const bootstrap = {
      entrypoint: "C:/app/backend.js",
      buildId: "test",
      policy: candidate,
    };
    const frame: ProcessFrame = {
      kind: "boot",
      ipc: {
        major: 1,
        minor: 0,
      },
      runtime: {
        id: "test",
        generation: "1",
      },
      payload: bootstrap,
    };
    const actions = [
      () => parsePolicy(JSON.stringify(candidate)),
      () => parseBootstrap(JSON.stringify(bootstrap)),
      () => parseProcessFrame(JSON.stringify(frame)),
      () => serializeProcessFrame(frame),
    ];
    for (const action of actions) {
      if (candidate === duplicate) {
        expect(action).toThrow("Duplicate policy view.");
      } else {
        expect(action).not.toThrow();
      }
    }
  }
});

test("command input properties are optional when required is omitted", async () => {
  const signal = new AbortController().signal;
  const ctx = context(
    bindHostAPI(contextId, signal, async () => ({
      kind: "result",
      payload: null,
    })),
    signal,
  );
  const definition = optionalApp.commands["notes.optional"];
  expect(await definition.run({}, ctx)).toBe("default");
  expect(
    await definition.run(
      {
        note: "present",
      },
      ctx,
    ),
  ).toBe("present");
  await expect(
    definition.run(
      {
        note: 42,
      },
      ctx,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("invalid combined constraints and duplicate JSON values never reach command handlers", async () => {
  const controller = new AbortController();
  const host = bindHostAPI(contextId, controller.signal, async () => ({
    kind: "result",
    payload: null,
  }));
  const ctx = context(host, controller.signal);
  for (const { schema, value, accepted } of validationCases) {
    if (accepted) {
      continue;
    }
    let called = false;
    const definition = command({
      input: schema,
      output: {},
      handle() {
        called = true;
        return null;
      },
    });
    await expect(definition.run(value, ctx)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(called).toBe(false);
    const badOutput = command({
      input: {},
      output: schema,
      handle: () => value,
    });
    await expect(badOutput.run(null, ctx)).rejects.toMatchObject({
      code: "INTERNAL",
    });
  }
});

test("a typed backend command validates input/output and preserves its bound Host context", async () => {
  const controller = new AbortController();
  const seen: unknown[] = [];
  const host = bindHostAPI(
    contextId,
    controller.signal,
    async (id, call, signal) => {
      seen.push({
        id,
        call,
        signal,
      });
      return {
        kind: "result",
        payload: "welcome",
      };
    },
  );
  const ctx = context(host, controller.signal);
  expect(
    await app.commands["notes.read"].run(
      {
        key: "welcome",
      },
      ctx,
    ),
  ).toBe("welcome");
  expect(seen).toEqual([
    {
      id: contextId,
      call: {
        operation: "storage.readText",
        payload: {
          scope: "appData",
          path: "notes/welcome.txt",
        },
      },
      signal: controller.signal,
    },
  ]);
  await expect(
    app.commands["notes.read"].run(
      {
        key: 42,
      },
      ctx,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Invalid command input.",
  });
  await expect(
    app.commands["notes.read"].run(
      {
        key: "welcome",
        context: "backend",
      },
      ctx,
    ),
  ).rejects.toThrow();
  expect(seen).toHaveLength(1);
  const bad = command({
    input: {
      const: null,
    },
    output,
    handle: () => 42 as unknown as string,
  });
  await expect(bad.run(null, ctx)).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Invalid command output.",
  });
});

test("Host operations share exact request/result schemas and safe errors", async () => {
  expect(
    parseHostCall(
      serializeHostCall({
        operation: "storage.writeText",
        payload: {
          scope: "temp",
          path: "notes/new.txt",
          text: "한글",
        },
      }),
    ),
  ).toEqual({
    operation: "storage.writeText",
    payload: {
      scope: "temp",
      path: "notes/new.txt",
      text: "한글",
    },
  });
  for (const call of [
    {
      operation: "unknown",
      payload: null,
    },
    {
      operation: "storage.readText",
      payload: {
        scope: "root",
        path: "notes/a",
      },
    },
    {
      operation: "storage.readText",
      payload: {
        scope: "appData",
        path: "a\0b",
      },
    },
    {
      operation: "storage.readText",
      payload: {
        scope: "appData",
        path: "a",
        context: "backend",
      },
    },
    {
      operation: "capabilities.get",
      payload: {},
    },
  ]) {
    expect(() =>
      registry.validateCall(parseHostCall(JSON.stringify(call))),
    ).toThrow();
  }
  expect(validateHostOutput("storage.writeText", null)).toBeNull();
  expect(() => validateHostOutput("storage.writeText", true)).toThrow();
  expect(
    validateHostOutput("capabilities.get", [
      {
        name: "storage",
        support: "supported",
        permission: "denied",
      },
    ]),
  ).toHaveLength(1);
  expect(() =>
    validateHostOutput("capabilities.get", [
      {
        name: "storage",
        support: "yes",
        permission: "denied",
      },
    ]),
  ).toThrow();
  expect(() =>
    validateHostOutput("capabilities.get", [
      {
        name: "storage",
        support: "supported",
        permission: "denied",
      },
      {
        name: "storage",
        support: "unsupported",
        permission: "unknown",
      },
    ]),
  ).toThrow();
  const signal = new AbortController().signal;
  const denied = bindHostAPI(contextId, signal, async () => ({
    kind: "error",
    error: {
      code: "PERMISSION_DENIED",
      message: "Access denied.",
    },
  }));
  const raw = bindHostAPI(contextId, signal, async () => {
    throw new Error("private-native-path");
  });
  const invalid = bindHostAPI(contextId, signal, async () => ({
    kind: "result",
    payload: 42,
  }));
  await expect(
    denied.call(contracts["storage.readText"], {
      scope: "appData",
      path: "notes/a",
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
    message: "Access denied.",
  });
  await expect(
    raw.call(contracts["log.write"], {
      level: "info",
      message: "safe",
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Host operation failed.",
  });
  await expect(
    invalid.call(contracts["storage.readText"], {
      scope: "appData",
      path: "notes/a",
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Invalid host response.",
  });
  expect(
    new BunawayError({
      code: "BUSY",
      message: "Queue full.",
    }),
  ).toBeInstanceOf(Error);
});

test("cancelled Host calls cannot start or deliver a late successful result", async () => {
  const controller = new AbortController();
  let calls = 0;
  const host = bindHostAPI(contextId, controller.signal, async () => {
    calls++;
    return {
      kind: "result",
      payload: null,
    };
  });
  controller.abort();
  await expect(
    host.call(contracts["log.write"], {
      level: "info",
      message: "cancelled",
    }),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(calls).toBe(0);
  const lateController = new AbortController();
  const late = bindHostAPI(contextId, lateController.signal, async () => {
    lateController.abort();
    return {
      kind: "result",
      payload: "late",
    };
  });
  await expect(
    late.call(contracts["storage.readText"], {
      scope: "temp",
      path: "a",
    }),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("Host paths use relative forward-slash paths while native access checks remain required", () => {
  for (const path of [
    "",
    "/absolute",
    "C:/absolute",
    "C:relative-drive",
    "../escape",
    "notes/../escape",
    "notes/./a",
    "notes\\a",
    "notes\u2028/../escape",
    "notes\u2029/../escape",
    "notes\u2028/./a",
    "notes\u2029/./a",
  ]) {
    expect(() =>
      registry.validateCall(
        parseHostCall(
          JSON.stringify({
            operation: "storage.readText",
            payload: {
              scope: "appData",
              path,
            },
          }),
        ),
      ),
    ).toThrow();
  }
  const call = {
    operation: "storage.readText",
    payload: {
      scope: "appData",
      path: "notes/한글 파일.txt",
    },
  } as const;
  expect(parseHostCall(JSON.stringify(call))).toEqual(call);
});

test("the windows name follows the generic plugin registration rules", () => {
  expect(
    () =>
      new NativeRegistry([
        {
          name: "windows",
          version: "1.0.0",
          native: {
            operations: [],
            permissions: [],
          },
        },
      ]),
  ).not.toThrow();
});

test("host-only boot policy and session-open never enter the Web message bridge", () => {
  const boot = parseBootstrap(
    JSON.stringify({
      entrypoint: "C:/app/backend.js",
      buildId: "test",
      policy,
      backendContext: "native-backend-context",
    }),
  );
  expect(boot.policy).toEqual(policy);
  expect(boot.backendContext).toBe("native-backend-context");
  const frame = {
    ipc: {
      major: 1,
      minor: 0,
    },
    runtime: {
      id: "app",
      generation: "1",
    },
    kind: "session-open",
    context: "native-context",
    viewId: "main",
  } as const;
  expect(parseProcessFrame(JSON.stringify(frame))).toEqual(frame);
  expect(() => parseMessage(JSON.stringify(frame))).toThrow();
  const cancel = {
    ipc: frame.ipc,
    runtime: frame.runtime,
    kind: "host-cancel",
    context: "native-context",
    requestId: "host-request-1",
  } as const;
  expect(parseProcessFrame(JSON.stringify(cancel))).toEqual(cancel);
  expect(() => parseMessage(JSON.stringify(cancel))).toThrow();
});

test("pending Host calls abort promptly and release their cancellation listener", async () => {
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const signal: CancellationSignal = {
    get aborted() {
      return controller.signal.aborted;
    },
    addEventListener(type, listener) {
      listeners.add(listener);
      controller.signal.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
      controller.signal.removeEventListener(type, listener);
    },
  };
  let complete!: (response: HostResponse) => void;
  const pending = new Promise<HostResponse>((resolve) => {
    complete = resolve;
  });
  let started = false;
  const host = bindHostAPI(contextId, signal, () => {
    started = true;
    return pending;
  });
  const task = host.call(contracts["storage.readText"], {
    scope: "temp",
    path: "notes/a",
  });
  await Promise.resolve();
  expect(started).toBe(true);
  expect(listeners.size).toBe(1);
  controller.abort();
  await expect(task).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(listeners.size).toBe(0);
  complete({
    kind: "result",
    payload: "late",
  });
  await pending;
});

// Type assertions below are not executed by the runtime tests.
export function checkImplicitObjectTypes(
  client: Client<CommandsOf<typeof implicitApp>>,
) {
  client.invoke("implicit.object", {
    id: "root",
    kind: "a",
  });
  client.invoke("implicit.object", {
    id: "root",
    kind: "b",
  });
  client.invoke("implicit.mixed", null);
  // @ts-expect-error implicit outer required id cannot disappear
  client.invoke("implicit.object", {
    kind: "a",
  });
  client.invoke("implicit.object", {
    // @ts-expect-error implicit properties constrain the common id type
    id: 42,
    kind: "a",
  });
  client.invoke("implicit.object", {
    id: "root",
    // @ts-expect-error common fields do not widen branch discriminants
    kind: "c",
  });
  command({
    input: implicitObjectSchema,
    output: implicitObjectSchema,
    handle: () =>
      // @ts-expect-error output must also retain common required fields
      ({
        kind: "a",
      }) as const,
  });
  const required: Infer<typeof implicitRequiredSchema> = {
    id: 42,
    kind: "a",
  };
  const present: JsonValue = required.id;
  void present;
  // @ts-expect-error required applies even without a properties declaration
  const missing: Infer<typeof implicitRequiredSchema> = {
    kind: "a",
  };
  void missing;
  const implicit = {
    properties: implicitObjectSchema.properties,
    required: [
      "id",
    ],
  } as const;
  const nonObjects: Infer<typeof implicit>[] = [
    42,
    null,
    [
      42,
    ],
    "text",
  ];
  void nonObjects;
  // @ts-expect-error implicit keywords still constrain object values
  const wrong: Infer<typeof implicit> = {
    id: 42,
  };
  void wrong;
}

export function checkContainerSchemaTypes(
  client: Client<CommandsOf<typeof emptyApp>>,
) {
  const objectResult: Promise<Infer<typeof emptyObject>> = client.invoke(
    "empty.object",
    {},
  );
  const arrayResult: Promise<Infer<typeof emptyObject>[]> = client.invoke(
    "empty.array",
    [
      {},
    ],
  );
  void objectResult;
  void arrayResult;
  // @ts-expect-error an empty object schema does not accept a number
  client.invoke("empty.object", 42);
  // @ts-expect-error an empty object schema does not accept an array
  client.invoke("empty.object", []);
  client.invoke("empty.object", {
    // @ts-expect-error a closed empty object schema does not accept extra properties
    extra: true,
  });
  client.invoke(
    "empty.array",
    [
      // @ts-expect-error nested empty objects do not accept numeric items
      42,
    ],
  );
  command({
    input: emptyObject,
    output: emptyObject,
    // @ts-expect-error empty object outputs cannot be numbers
    handle: () => 42,
  });
  command({
    input: emptyObject,
    output: emptyObject,
    // @ts-expect-error empty object outputs cannot be arrays
    handle: () => [],
  });
  const objectOnly = {
    type: "object",
  } as const;
  const openEmpty = {
    type: "object",
    properties: {},
  } as const;
  const closedOnly = {
    type: "object",
    additionalProperties: false,
  } as const;
  const arrayOnly = {
    type: "array",
  } as const;
  const containers: [
    Infer<typeof objectOnly>,
    Infer<typeof openEmpty>,
    Infer<typeof closedOnly>,
    Infer<typeof arrayOnly>,
  ] = [
    {
      anything: [
        42,
      ],
    },
    {
      anything: null,
    },
    {},
    [
      42,
      {},
    ],
  ];
  void containers;
  // @ts-expect-error an object without properties is still an object
  const numericObject: Infer<typeof objectOnly> = 42;
  // @ts-expect-error an open empty object is not an array
  const arrayObject: Infer<typeof openEmpty> = [];
  const extraObject: Infer<typeof closedOnly> = {
    // @ts-expect-error a closed object without properties remains empty
    extra: true,
  };
  // @ts-expect-error an array without items is still an array
  const objectArray: Infer<typeof arrayOnly> = {};
  // @ts-expect-error even optional properties named length must not admit arrays
  const optionalArray: Infer<{
    type: "object";
    properties: {
      length: {
        type: "integer";
      };
    };
  }> = [];
  void numericObject;
  void arrayObject;
  void extraObject;
  void objectArray;
  void optionalArray;
}

export function checkCombinedSchemaTypes(
  client: Client<CommandsOf<typeof combinedApp>, EventsOf<typeof combinedApp>>,
) {
  const result: Promise<Infer<typeof combinedSchema>> = client.invoke(
    "notes.combined",
    {
      base: "root",
      kind: "a",
      value: "text",
    },
  );
  result.then((input) => {
    const base: string = input.base;
    void base;
    if (input.kind === "b") {
      const value: number = input.value;
      void value;
    }
  });
  // @ts-expect-error anyOf does not remove the common required base
  client.invoke("notes.combined", {
    kind: "a",
    value: "text",
  });
  // @ts-expect-error branch a still requires a string value
  client.invoke("notes.combined", {
    base: "root",
    kind: "a",
    value: 42,
  });
  client.invoke("notes.combined", {
    // @ts-expect-error the shared base must be a string
    base: 42,
    kind: "b",
    value: 42,
  });
  client.listen(
    "notes.combinedChanged",
    (event) => {
      const base: string = event.payload.base;
      void base;
    },
    {
      onError() {},
    },
  );
}

export function checkOptionalObjectTypes(
  client: Client<CommandsOf<typeof optionalApp>, EventsOf<typeof optionalApp>>,
) {
  const missing: Promise<string> = client.invoke("notes.optional", {});
  const present: Promise<string> = client.invoke("notes.optional", {
    note: "present",
  });
  void missing;
  void present;
  client.invoke("notes.optional", {
    // @ts-expect-error a present optional field must still be a string
    note: 42,
  });
  // @ts-expect-error the optional object is not nullable
  client.invoke("notes.optional", null);
  client.listen(
    "notes.optionalChanged",
    (event) => {
      const note: string | undefined = event.payload.note;
      void note;
      // @ts-expect-error note may be absent
      const required: string = event.payload.note;
      void required;
    },
    {
      onError() {},
    },
  );
  const nested = command({
    input: {
      type: "object",
      properties: {
        options: optionalInput,
      },
      required: [],
    },
    output,
    handle(input) {
      return input.options?.note ?? "nested-default";
    },
  });
  void nested;
}

export function checkClientTypes(
  client: Client<CommandsOf<typeof app>, EventsOf<typeof app>>,
  factory: ClientFactory,
  transport: Transport,
) {
  const result: Promise<string> = client.invoke(
    "notes.read",
    {
      key: "welcome",
    },
    {
      signal: new AbortController().signal,
    },
  );
  void result;
  client.listen(
    "notes.changed",
    (event) => {
      const key: string = event.payload.key;
      void key;
    },
    {
      onError: (error) => {
        const code: string = error.code;
        void code;
      },
    },
  );
  // @ts-expect-error unknown command
  client.invoke("notes.delete", {
    key: "welcome",
  });
  client.invoke("notes.read", {
    // @ts-expect-error wrong input type
    key: 42,
  });
  // @ts-expect-error wrong output type
  const incorrect: Promise<number> = client.invoke("notes.read", {
    key: "welcome",
  });
  void incorrect;
  // @ts-expect-error unknown event
  client.listen("notes.missing", () => {}, {
    onError() {},
  });
  // @ts-expect-error subscription failure must have an observer
  client.listen("notes.changed", () => {});
  const created = factory<CommandsOf<typeof app>, EventsOf<typeof app>>({
    transport,
    hello: {
      kind: "hello",
      protocol: {
        major: 1,
        minor: 0,
      },
      features: [],
      buildId: "client",
    },
  });
  // @ts-expect-error optional plugin commands require an explicit client command map
  created.invoke("plugin.capabilities.get", null);
  // @ts-expect-error capabilities belongs to the optional plugin facade
  created.capabilities();
}

export function checkDefaultClientTypes() {
  const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
  const result: Promise<string> = client.invoke("notes.read", {
    key: "welcome",
  });
  void result;
  // @ts-expect-error the default connection retains known command names
  client.invoke("notes.missing", null);
  client.invoke("notes.read", {
    // @ts-expect-error the default connection retains command input validation
    key: 42,
  });
  client.listen(
    "notes.changed",
    (event) => {
      const key: string = event.payload.key;
      void key;
    },
    {
      onError() {},
    },
  );
  const direct: Promise<string> = invoke<string>("notes.read", {
    key: "welcome",
  });
  void direct;
  listen<string>(
    "notes.changed",
    (event) => {
      const payload: string = event.payload;
      void payload;
    },
    {
      onError() {},
    },
  );
  // @ts-expect-error direct subscription failures still require an observer
  listen("notes.changed", () => {});
  // @ts-expect-error functions cannot be sent as command input
  invoke("notes.read", () => {});
}

export function checkCoreTypes(
  factory: CoreFactory,
  services: CoreServices,
  session: CoreSession,
  clientMessage: ClientMessage,
  serverMessage: ServerMessage,
  runtime: RuntimeServices,
) {
  factory(app, services).then((core) => {
    core.openSession(contextId, "main").receive(clientMessage);
    core.stop();
  });
  session.receive(clientMessage);
  // @ts-expect-error server replies are not inbound client requests
  session.receive(serverMessage);
  services.callHost(
    // @ts-expect-error callers may not substitute an unbranded Web-supplied context ID
    "from-web",
    {
      operation: "capabilities.get",
      payload: null,
    },
    new AbortController().signal,
  );
  const plugin = {
    name: "storage",
    version: "0.0.0",
    platforms: [
      "windows",
    ],
    commands: app.commands,
    events: app.events,
    setup(ctx) {
      ctx.state.set("ready", true);
      return async () => {
        ctx.state.delete("ready");
      };
    },
  } satisfies PluginDefinition;
  void plugin;
  const stop = runtime.schedule(() => {}, 100);
  stop();
  services.callHost(
    contextId,
    {
      operation: "storage.writeText",
      payload: {
        scope: "temp",
        path: "a",
      },
    },
    new AbortController().signal,
  );
}

export function checkTransportTypes(transport: Transport) {
  const off = transport.subscribe((event: TransportEvent) => {
    if (event.kind === "message") {
      parseMessage(event.text);
    }
  });
  off();
  transport.close();
  // @ts-expect-error transport carries serialized JSON, not authority-bearing objects
  transport.send({
    context: "backend",
  });
  const response: HostResponse = {
    kind: "result",
    payload: null,
    // @ts-expect-error host results are separate from Web results
    id: "web-request",
  };
  void response;
  validateValue(
    {
      const: null,
    },
    null,
  );
}
