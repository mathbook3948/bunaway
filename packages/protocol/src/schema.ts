// This JSON Schema subset is also exported for native host implementations.
const identifier = {
  type: "string",
  pattern: "^[A-Za-z0-9_.:-]+$(?![\\s\\S])",
  maxLength: 128,
} as const;
const text = {
  type: "string",
  maxLength: 1024,
} as const;
const names = {
  type: "array",
  items: identifier,
  maxItems: 256,
  uniqueItems: true,
} as const;
const version = {
  type: "object",
  properties: {
    major: {
      type: "integer",
      minimum: 0,
      maximum: 65535,
    },
    minor: {
      type: "integer",
      minimum: 0,
      maximum: 65535,
    },
  },
  required: [
    "major",
    "minor",
  ],
  additionalProperties: false,
} as const;

export const errorSchema = {
  type: "object",
  properties: {
    code: {
      enum: [
        "INVALID_ARGUMENT",
        "PERMISSION_DENIED",
        "UNSUPPORTED",
        "TIMEOUT",
        "CANCELLED",
        "BUSY",
        "INTERNAL",
      ],
    },
    message: text,
    details: {},
  },
  required: [
    "code",
    "message",
  ],
  additionalProperties: false,
} as const;

export const messageSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  anyOf: [
    {
      type: "object",
      properties: {
        kind: {
          const: "hello",
        },
        protocol: version,
        features: names,
        buildId: identifier,
      },
      required: [
        "kind",
        "protocol",
        "features",
        "buildId",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "invoke",
        },
        protocol: version,
        id: identifier,
        command: identifier,
        payload: {},
        deadline: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
        },
      },
      required: [
        "kind",
        "protocol",
        "id",
        "command",
        "payload",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "cancel",
        },
        protocol: version,
        id: identifier,
      },
      required: [
        "kind",
        "protocol",
        "id",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "listen",
        },
        protocol: version,
        id: identifier,
        event: identifier,
      },
      required: [
        "kind",
        "protocol",
        "id",
        "event",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "unlisten",
        },
        protocol: version,
        id: identifier,
        subscriptionId: identifier,
      },
      required: [
        "kind",
        "protocol",
        "id",
        "subscriptionId",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "close",
        },
        protocol: version,
      },
      required: [
        "kind",
        "protocol",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "result",
        },
        protocol: version,
        id: identifier,
        payload: {},
      },
      required: [
        "kind",
        "protocol",
        "id",
        "payload",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "error",
        },
        protocol: version,
        id: identifier,
        error: errorSchema,
      },
      required: [
        "kind",
        "protocol",
        "id",
        "error",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "event",
        },
        protocol: version,
        subscriptionId: identifier,
        source: identifier,
        target: identifier,
        event: identifier,
        sequence: {
          type: "integer",
          minimum: 1,
          maximum: 9007199254740991,
        },
        payload: {},
      },
      required: [
        "kind",
        "protocol",
        "subscriptionId",
        "source",
        "target",
        "event",
        "sequence",
        "payload",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "subscription-error",
        },
        protocol: version,
        subscriptionId: identifier,
        error: errorSchema,
      },
      required: [
        "kind",
        "protocol",
        "subscriptionId",
        "error",
      ],
      additionalProperties: false,
    },
  ],
} as const;

const scopedPermission = {
  type: "object",
  properties: {
    identifier,
    allow: {
      type: "array",
      items: {},
      maxItems: 128,
    },
    deny: {
      type: "array",
      items: {},
      maxItems: 128,
    },
  },
  required: [
    "identifier",
  ],
  additionalProperties: false,
} as const;
const hostPermissions = {
  type: "object",
  properties: {
    permissions: {
      type: "array",
      items: {
        anyOf: [
          identifier,
          scopedPermission,
        ],
      },
      maxItems: 256,
    },
  },
  required: [
    "permissions",
  ],
  additionalProperties: false,
} as const;

export const policySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    version: {
      const: 1,
    },
    views: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          id: identifier,
          origins: {
            type: "array",
            maxItems: 16,
            uniqueItems: true,
            items: {
              type: "string",
              pattern:
                "^https?://[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?$(?![\\s\\S])",
              maxLength: 256,
            },
          },
          commands: names,
          events: names,
          host: hostPermissions,
        },
        required: [
          "id",
          "origins",
          "commands",
          "events",
          "host",
        ],
        additionalProperties: false,
      },
    },
    backend: hostPermissions,
  },
  required: [
    "version",
    "views",
    "backend",
  ],
  additionalProperties: false,
} as const;

// Native-host-only JSON: never accepted from a WebView transport.
export const bootstrapSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    entrypoint: {
      type: "string",
      pattern: "^(?:[A-Za-z]:[\\\\/]|/)[^\\u0000\\r\\n]+$(?![\\s\\S])",
      maxLength: 4096,
    },
    buildId: identifier,
    policy: policySchema,
    backendContext: identifier,
  },
  required: [
    "entrypoint",
    "buildId",
  ],
  additionalProperties: false,
} as const;

// Correlation and authorization context travel in the host-only process envelope.
export const hostResponseSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  anyOf: [
    {
      type: "object",
      properties: {
        kind: {
          const: "result",
        },
        payload: {},
      },
      required: [
        "kind",
        "payload",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: {
          const: "error",
        },
        error: errorSchema,
      },
      required: [
        "kind",
        "error",
      ],
      additionalProperties: false,
    },
  ],
} as const;

const processBase = {
  ipc: {
    type: "object",
    properties: {
      major: {
        const: 1,
      },
      minor: {
        const: 0,
      },
    },
    required: [
      "major",
      "minor",
    ],
    additionalProperties: false,
  },
  runtime: {
    type: "object",
    properties: {
      id: identifier,
      generation: identifier,
    },
    required: [
      "id",
      "generation",
    ],
    additionalProperties: false,
  },
} as const;

function processVariant<
  const K extends string,
  const P extends Record<string, object>,
>(kind: K, properties: P) {
  return {
    type: "object",
    properties: {
      ...processBase,
      kind: {
        const: kind,
      },
      ...properties,
    },
    required: [
      "ipc",
      "runtime",
      "kind",
      ...Object.keys(properties),
    ] as ("ipc" | "runtime" | "kind" | keyof P)[],
    additionalProperties: false,
  } as const;
}

// This envelope is carried only by host-owned pipes, never a WebView bridge.
export const processSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  anyOf: [
    processVariant("boot", {
      payload: bootstrapSchema,
    }),
    processVariant("hello", {
      payload: messageSchema.anyOf[0],
    }),
    processVariant("ready", {
      pid: {
        type: "integer",
        minimum: 1,
        maximum: 4294967295,
      },
      bunVersion: identifier,
      revision: identifier,
    } as const),
    processVariant("web", {
      context: identifier,
      payload: messageSchema,
    }),
    processVariant("host-request", {
      context: identifier,
      requestId: identifier,
      operation: identifier,
      payload: {},
    }),
    processVariant("host-response", {
      context: identifier,
      requestId: identifier,
      payload: hostResponseSchema,
    }),
    processVariant("host-cancel", {
      context: identifier,
      requestId: identifier,
    }),
    processVariant("revoke", {
      context: identifier,
    }),
    processVariant("session-open", {
      context: identifier,
      viewId: identifier,
    }),
    processVariant("shutdown", {}),
    processVariant("stopping", {}),
    processVariant("fatal", {
      error: errorSchema,
    }),
  ],
} as const;
