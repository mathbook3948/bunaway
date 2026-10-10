import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDefinition, CommandDefinition } from "@bunaway/core";
import shared from "./app.ts";

// macOS has no native plugin adapter. Keep the common command/event boundary
// fixtures, and write test reports from trusted Bun code instead of a plugin.
const commands: Record<string, CommandDefinition> = {};
for (const name of [
  "echo",
  "ping",
  "count",
  "notAllowed",
  "hold",
  "emit",
  "fail",
]) {
  const command = shared.commands?.[`test.${name}`];
  if (!command) {
    throw new Error(`Missing shared fixture: ${name}`);
  }
  commands[`test.${name}`] = command;
}
let memo = "";
export const macosApp = {
  events: shared.events,
  commands: {
    ...commands,
    "test.report": {
      input: {
        type: "object",
        properties: {
          file: {
            type: "string",
            pattern: "^[a-z0-9]+\\.json$",
          },
          report: {},
        },
        required: [
          "file",
          "report",
        ],
        additionalProperties: false,
      },
      output: {
        const: null,
      },
      async run(payload) {
        const { file, report } = payload as {
          file: string;
          report: unknown;
        };
        await mkdir(tmpdir(), {
          recursive: true,
        });
        await Bun.write(join(tmpdir(), file), JSON.stringify(report));
        return null;
      },
    },
    "memo.save": {
      input: {
        type: "string",
        maxLength: 10000,
      },
      output: {
        const: null,
      },
      async run(payload, context) {
        memo = payload as string;
        await context.events.emit("memo.saved", memo, {
          kind: "broadcast",
        });
        return null;
      },
    },
    "memo.read": {
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      async run() {
        return memo;
      },
    },
  },
} satisfies AppDefinition;
