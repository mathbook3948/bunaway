import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import storage from "@bunaway/plugin-storage";
import windows from "@bunaway/plugin-windows";

const directory = process.env.HOME;
if (!directory) {
  throw new Error("Missing storage fixture root.");
}
const root = resolve(directory, "storage");
let restarted = false;

export default defineApp({
  modules: [],
  plugins: [
    storage,
    windows,
    {
      name: "storage-fixture",
      version: "1",
      async setup() {
        const path = resolve(root, "restart.txt");
        restarted = await storage.exists({
          path,
        });
        if (restarted) {
          if (
            (await storage.readText({
              path,
            })) !== "persistent 한글\0✓"
          ) {
            throw new Error("Restart data was lost.");
          }
        } else {
          await storage.writeText({
            path,
            text: "persistent 한글\0✓",
          });
        }
        return () => writeFile(resolve(root, "core-cleaned"), "done");
      },
    },
  ],
  events: {},
  commands: {
    "test.paths": {
      input: {
        const: null,
      },
      output: {
        type: "object",
        properties: {
          root: {
            type: "string",
          },
          restarted: {
            type: "boolean",
          },
        },
        required: [
          "root",
          "restarted",
        ],
        additionalProperties: false,
      },
      run: async () => ({
        root,
        restarted,
      }),
    },
    "test.backendViaView": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run() {
        await storage.writeText({
          path: resolve(root, "command.txt"),
          text: "view authority",
        });
        return null;
      },
    },
    "test.report": {
      input: {
        type: "object",
        properties: {
          view: {
            enum: [
              "main",
            ],
          },
          ok: {
            type: "boolean",
          },
          restarted: {
            type: "boolean",
          },
          message: {
            type: "string",
          },
        },
        required: [
          "view",
          "ok",
          "restarted",
          "message",
        ],
        additionalProperties: false,
      },
      output: {
        const: null,
      },
      async run(input: unknown) {
        if (
          !input ||
          typeof input !== "object" ||
          !("view" in input) ||
          typeof input.view !== "string" ||
          input.view !== "main"
        ) {
          throw new Error("Invalid report.");
        }
        await writeFile(
          resolve(root, `${input.view}-report.json`),
          JSON.stringify(input),
        );
        return null;
      },
    },
  },
});
