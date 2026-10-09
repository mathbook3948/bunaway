import type {
  AppDefinition,
  CommandContext,
  CommandDefinition,
} from "../../../../packages/core/src/index.ts";
import {
  BunawayError,
  type JsonValue,
} from "../../../../packages/protocol/src/index.ts";
import { contracts, plugins } from "../../host-plugins.ts";
import { memoApp } from "./memo-app.ts";

let invokeCount = 0;
const command = (run: CommandDefinition["run"]): CommandDefinition => ({
  input: {},
  output: {},
  async run(payload, context) {
    return run(payload, context);
  },
});
// BunawayError host-call failures are returned as data; other failures still reject.
const host = async (
  context: CommandContext,
  operation: string,
  payload: JsonValue,
): Promise<JsonValue> => {
  try {
    return {
      ok: true,
      value: (await context.host.call(
        contracts[
          operation as keyof typeof contracts
        ] as import("../../../../packages/protocol/src/index.ts").HostOperationContract,
        payload as never,
      )) as JsonValue,
    };
  } catch (error) {
    if (error instanceof BunawayError) {
      return {
        ok: false,
        code: error.code,
      };
    }
    throw error;
  }
};
const object = (payload: unknown) => payload as Record<string, JsonValue>;
/** Shared host-command fixture adapted by the Windows and macOS test hosts. */
const app: AppDefinition = {
  plugins: [
    ...plugins,
    {
      name: "startup-log",
      version: "1",
      async setup(context) {
        await context.host.call(contracts["log.write"], {
          level: "info",
          message: "core-startup",
          details: null,
        });
      },
    },
  ],
  events: {
    "test.changed": {},
    ...memoApp.events,
  },
  commands: {
    "test.echo": command(async (payload) => payload as JsonValue),
    "test.ping": command(async () => "pong"),
    "test.count": command(async () => invokeCount),
    "test.notAllowed": command(async () => {
      invokeCount++;
      return null;
    }),
    "test.hold": command(
      async (_payload, { signal }) =>
        new Promise((_, reject) => {
          const abort = () =>
            reject(
              new BunawayError({
                code: "CANCELLED",
                message: "Cancelled.",
              }),
            );
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort);
          }
        }),
    ),
    "test.writeNote": command(async (p, c) =>
      host(c, "storage.writeText", {
        scope: "appData",
        path: `notes/${object(p).name}.txt`,
        text: object(p).text ?? "",
      }),
    ),
    "test.readNote": command(async (p, c) =>
      host(c, "storage.readText", {
        scope: "appData",
        path: `notes/${object(p).name}.txt`,
      }),
    ),
    "test.readEscape": command(async (p, c) =>
      host(c, "storage.readText", {
        scope: "appData",
        path: String(object(p).path),
      }),
    ),
    "test.tempRead": command(async (p, c) =>
      host(c, "storage.readText", {
        scope: "temp",
        path: String(object(p).path),
      }),
    ),
    "test.tempWrite": command(async (p, c) =>
      host(c, "storage.writeText", {
        scope: "temp",
        path: String(object(p).path),
        text: String(object(p).text),
      }),
    ),
    "test.capabilities": command(async (_p, c) => ({
      ...object(await host(c, "capabilities.get", null)),
      platform: process.platform,
    })),
    "test.log": command(async (p, c) =>
      host(c, "log.write", {
        level: "info",
        message: String(object(p).message),
        details: object(p).details ?? null,
      }),
    ),
    "test.emit": command(async (p, c) => {
      await c.events.emit("test.changed", p as JsonValue, {
        kind: "broadcast",
      });
      return null;
    }),
    "test.hostCancel": command(async (_p, c) =>
      c.host.call(contracts["storage.readText"], {
        scope: "temp",
        path: "cancel-me.txt",
      }),
    ),
    "test.report": command(async (p, c) =>
      host(c, "storage.writeText", {
        scope: "temp",
        path: String(object(p).file),
        text: JSON.stringify(object(p).report),
      }),
    ),
    "test.fail": command(async () => {
      throw new Error("private backend detail");
    }),
    ...memoApp.commands,
  },
};
export default app;
