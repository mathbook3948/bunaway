import { command, defineApp } from "@bunaway/backend";
import { BunawayError } from "@bunaway/protocol";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const infoSchema = {
  type: "object",
  properties: {
    count: {
      type: "integer",
    },
    cancelled: {
      type: "integer",
    },
    pid: {
      type: "integer",
    },
  },
  required: [
    "count",
    "cancelled",
    "pid",
  ],
  additionalProperties: false,
} as const;

const echoSchema = {
  type: "string",
  maxLength: 196_608,
} as const;

/** Same app-definition surface as desktop, with no native plugin dependencies. */
export const app = defineApp({
  modules: [],
  state: {
    count: 0,
    cancelled: 0,
  },
  events: {
    "test.changed": {
      type: "integer",
    },
  },
  commands: {
    "test.echo": command({
      input: echoSchema,
      output: echoSchema,
      handle(input) {
        return input;
      },
    }),
    "test.environment": command({
      input: {},
      output: {
        type: "object",
        properties: {
          temporary: {
            type: "string",
          },
          home: {
            type: "string",
          },
          writable: {
            type: "boolean",
          },
        },
        required: [
          "temporary",
          "home",
          "writable",
        ],
        additionalProperties: false,
      },
      async handle() {
        const temporary = tmpdir();
        const directory = await mkdtemp(join(temporary, "bunaway-test-"));
        try {
          const path = join(directory, "probe.txt");
          await writeFile(path, "Android temporary data");
          return {
            temporary,
            home: homedir(),
            writable:
              (await readFile(path, "utf8")) === "Android temporary data",
          };
        } finally {
          await rm(directory, {
            recursive: true,
            force: true,
          });
        }
      },
    }),
    "test.info": command({
      input: {},
      output: infoSchema,
      handle(_input, { state }) {
        return {
          count: Number(state.get("count")),
          cancelled: Number(state.get("cancelled")),
          pid: process.pid,
        };
      },
    }),
    "test.increment": command({
      input: {
        type: "integer",
        minimum: 1,
        maximum: 10,
      },
      output: {
        type: "integer",
      },
      async handle(input, { state, events }) {
        const count = Number(state.get("count")) + input;
        state.set("count", count);
        await events.emit("test.changed", count, {
          kind: "broadcast",
        });
        return count;
      },
    }),
    "test.hold": command({
      input: {},
      output: {},
      handle(_input, { signal, state }) {
        return new Promise<never>((_resolve, reject) => {
          const cancel = () => {
            signal.removeEventListener("abort", cancel);
            state.set("cancelled", Number(state.get("cancelled")) + 1);
            reject(
              new BunawayError({
                code: "CANCELLED",
                message: "Cancelled.",
              }),
            );
          };
          if (signal.aborted) {
            cancel();
          } else {
            signal.addEventListener("abort", cancel);
          }
        });
      },
    }),
    "test.error": command({
      input: {},
      output: {},
      handle() {
        throw new Error("trusted backend diagnostic");
      },
    }),
    "test.denied": command({
      input: {},
      output: {},
      handle() {
        throw new Error("denied command executed");
      },
    }),
  },
});
export default app;
