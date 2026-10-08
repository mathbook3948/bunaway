import { defineNativePlugin, s } from "@bunaway/plugin";
import manifest from "../package.json";
import { matches } from "./scope.ts";

const storageScopeName = s.enum([
  "appData",
  "temp",
]);
const pathFields = {
  scope: storageScopeName,
  // Lexical guard only; the native file-open boundary still checks links and actual scope.
  path: s.string({
    maxLength: 4096,
    pattern:
      "^(?!\\/)(?![A-Za-z]:)(?![\\s\\S]*(?:^|\\/)\\.{1,2}(?:\\/|$))[^\\\\\\u0000\\r\\n]+$(?![\\s\\S])",
  }),
};
const storageScope = s.object({
  scope: storageScopeName,
  pathPrefix: s.string({
    pattern: "^(?:[A-Za-z0-9_-]+(?:\\/[A-Za-z0-9_-]+)*)?$(?![\\s\\S])",
    maxLength: 256,
  }),
});
const storageTimes = {
  createdAtMs: {
    anyOf: [
      s.integer(),
      s.null(),
    ],
  },
  modifiedAtMs: {
    anyOf: [
      s.integer(),
      s.null(),
    ],
  },
  accessedAtMs: {
    anyOf: [
      s.integer(),
      s.null(),
    ],
  },
} as const;
const storageMetadata = {
  anyOf: [
    s.object({
      kind: s.enum([
        "file",
      ]),
      sizeBytes: s.integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
      ...storageTimes,
    }),
    s.object({
      kind: s.enum([
        "directory",
      ]),
      sizeBytes: s.null(),
      ...storageTimes,
    }),
  ],
} as const;
const plugin = defineNativePlugin({
  name: "storage",
  version: manifest.version,
  operations: {
    readText: {
      input: s.object(pathFields),
      output: s.string(),
      permission: "read-text",
      osPermission: "not-required",
    },
    writeText: {
      input: s.object({
        ...pathFields,
        text: s.string(),
      }),
      output: s.null(),
      permission: "write-text",
      osPermission: "not-required",
    },
    exists: {
      input: s.object(pathFields),
      output: s.boolean(),
      permission: "read-metadata",
      osPermission: "not-required",
    },
    stat: {
      input: s.object(pathFields),
      output: {
        anyOf: [
          storageMetadata,
          s.null(),
        ],
      },
      permission: "read-metadata",
      osPermission: "not-required",
    },
  },
  scopes: {
    "read-text": storageScope,
    "write-text": storageScope,
    "read-metadata": storageScope,
  },
  matches,
});
export const storagePlugin = plugin.definition;
export default storagePlugin;
export const storage = plugin.api;
export type StorageLocation = Parameters<typeof storage.readText>[0];
export type StorageWrite = Parameters<typeof storage.writeText>[0];
export type StorageMetadata = NonNullable<
  Awaited<ReturnType<typeof storage.stat>>
>;
