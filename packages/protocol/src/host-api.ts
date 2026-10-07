import type { Infer, Schema } from "./validation.ts";
import { parse, ProtocolError, serialize, validate } from "./validation.ts";

const pathFields = {
  scope: { enum: ["appData", "temp"] },
  // Lexical guard only; the native file-open boundary must still check links and actual scope.
  path: {
    type: "string",
    maxLength: 4096,
    pattern:
      "^(?!/)(?![A-Za-z]:)(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^\\\\\\u0000\\r\\n]+$(?![\\s\\S])",
  },
} as const;

const windowTarget = {
  type: "object",
  properties: { view: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$(?![\\s\\S])" } },
  required: ["view"],
  additionalProperties: false,
} as const;
const windowResult = { input: windowTarget, output: { const: null } } as const;

export const hostOperations = {
  "windows.list": {
    input: { const: null },
    output: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: { view: windowTarget.properties.view, open: { type: "boolean" } },
        required: ["view", "open"],
        additionalProperties: false,
      },
    },
  },
  "windows.create": windowResult,
  "windows.recreate": windowResult,
  "windows.show": windowResult,
  "windows.hide": windowResult,
  "windows.focus": windowResult,
  "windows.close": { input: windowTarget, output: { type: "boolean" } },
  "windows.setSize": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        width: { type: "integer", minimum: 200, maximum: 4096 },
        height: { type: "integer", minimum: 200, maximum: 4096 },
      },
      required: ["view", "width", "height"],
    },
    output: { const: null },
  },
  "windows.setPosition": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        x: { type: "integer", minimum: -32768, maximum: 32767 },
        y: { type: "integer", minimum: -32768, maximum: 32767 },
      },
      required: ["view", "x", "y"],
    },
    output: { const: null },
  },
  "windows.setFullscreen": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        fullscreen: { type: "boolean" },
      },
      required: ["view", "fullscreen"],
    },
    output: { const: null },
  },
  "windows.setCloseConfirmation": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        message: {
          anyOf: [
            { const: null },
            { type: "string", maxLength: 1024, pattern: "^[^\\u0000]+$(?![\\s\\S])" },
          ],
        },
      },
      required: ["view", "message"],
    },
    output: { const: null },
  },
  "storage.readText": {
    input: {
      type: "object",
      properties: pathFields,
      required: ["scope", "path"],
      additionalProperties: false,
    },
    output: { type: "string" },
  },
  "storage.writeText": {
    input: {
      type: "object",
      properties: { ...pathFields, text: { type: "string" } },
      required: ["scope", "path", "text"],
      additionalProperties: false,
    },
    output: { const: null },
  },
  "log.write": {
    input: {
      type: "object",
      properties: {
        level: { enum: ["debug", "info", "warn", "error"] },
        message: { type: "string", maxLength: 1024 },
        details: {},
      },
      required: ["level", "message"],
      additionalProperties: false,
    },
    output: { const: null },
  },
  "capabilities.get": {
    input: { const: null },
    output: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[A-Za-z0-9_.:-]+$(?![\\s\\S])", maxLength: 128 },
          support: { enum: ["supported", "experimental", "unsupported"] },
          permission: { enum: ["granted", "denied", "prompt", "not-required", "unknown"] },
          reason: { type: "string", maxLength: 1024 },
        },
        required: ["name", "support", "permission"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Record<string, { input: Schema; output: Schema }>;

export type HostOperation = keyof typeof hostOperations;
export type HostInput<K extends HostOperation> = Infer<(typeof hostOperations)[K]["input"]>;
export type HostOutput<K extends HostOperation> = Infer<(typeof hostOperations)[K]["output"]>;
export type HostCall = {
  [K in HostOperation]: { operation: K; payload: HostInput<K> };
}[HostOperation];
export type Capabilities = HostOutput<"capabilities.get">;

export const hostCallSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  anyOf: Object.entries(hostOperations).map(
    ([operation, definition]) =>
      ({
        type: "object",
        properties: { operation: { const: operation }, payload: definition.input },
        required: ["operation", "payload"],
        additionalProperties: false,
      }) as const,
  ),
} as const;

export function parseHostCall(text: string): HostCall {
  return parse(hostCallSchema, text) as HostCall;
}

export function serializeHostCall(call: HostCall): string {
  return serialize(hostCallSchema, call);
}

export function validateHostOutput<K extends HostOperation>(
  operation: K,
  value: unknown,
): HostOutput<K> {
  const output = validate(hostOperations[operation].output, value) as HostOutput<K>;
  if (operation === "capabilities.get") {
    const capabilities = output as Capabilities;
    if (new Set(capabilities.map((feature) => feature.name)).size !== capabilities.length) {
      throw new ProtocolError("INVALID_ARGUMENT", "Duplicate capability name.");
    }
  }
  return output;
}

// Bound to the originating command/backend lifetime; callers cannot choose a context.
export interface HostAPI {
  call<K extends HostOperation>(operation: K, payload: HostInput<K>): Promise<HostOutput<K>>;
}

export const CAPABILITIES_COMMAND = "bunaway.capabilities";
export type FrameworkCommands = { [CAPABILITIES_COMMAND]: { input: null; output: Capabilities } };
