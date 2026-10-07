import { defineNativePlugin, s } from "@bunaway/plugin";
import manifest from "../package.json";
import { matches } from "./scope.ts";

const pathFields = {
  scope: s.enum(["appData", "temp"]),
  // Lexical guard only; the native file-open boundary still checks links and actual scope.
  path: s.string({
    maxLength: 4096,
    pattern:
      "^(?!\\/)(?![A-Za-z]:)(?![\\s\\S]*(?:^|\\/)\\.{1,2}(?:\\/|$))[^\\\\\\u0000\\r\\n]+$(?![\\s\\S])",
  }),
};
const storageScope = s.object({
  scope: s.enum(["appData", "temp"]),
  pathPrefix: s.string({
    pattern: "^(?:[A-Za-z0-9_-]+(?:\\/[A-Za-z0-9_-]+)*)?$(?![\\s\\S])",
    maxLength: 256,
  }),
});
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
      input: s.object({ ...pathFields, text: s.string() }),
      output: s.null(),
      permission: "write-text",
      osPermission: "not-required",
    },
  },
  scopes: { "read-text": storageScope, "write-text": storageScope },
  matches,
});
export const storagePlugin = plugin.definition;
export default storagePlugin;
export const storage = plugin.api;
export type StorageLocation = Parameters<typeof storage.readText>[0];
export type StorageWrite = Parameters<typeof storage.writeText>[0];
