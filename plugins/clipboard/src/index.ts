import { defineNativePlugin, s } from "@bunaway/plugin";
import manifest from "../package.json";
import { textSchema, writeTextSchema } from "./text.ts";

const plugin = defineNativePlugin({
  name: "clipboard",
  version: manifest.version,
  operations: {
    readText: {
      input: s.null(),
      output: {
        anyOf: [
          textSchema,
          s.null(),
        ],
      },
      permission: "read-text",
      osPermission: "not-required",
    },
    writeText: {
      input: writeTextSchema,
      output: s.null(),
      permission: "write-text",
      osPermission: "not-required",
    },
    clear: {
      input: s.null(),
      output: s.null(),
      permission: "clear",
      osPermission: "not-required",
    },
  },
});

/** Optional text clipboard contract; registration does not grant permissions. */
export const clipboardPlugin = plugin.definition;
export default clipboardPlugin;

/** Read Unicode text, replace all formats with text, or clear all clipboard formats. */
export const clipboard = plugin.api;
