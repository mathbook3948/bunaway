import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppDefinition } from "../../../packages/core/src/index.ts";
import {
  type AppReloadRequest,
  type AppReloadResult,
  MAX_APP_RELOAD_MESSAGE_CHARS,
  readAppReloadRequest,
} from "../../../packages/runtime-bun/src/development.ts";
import type { DevelopmentApp } from "./development-app.ts";

const MAX_APP_RELOADS = 100;

export function listenForAppReload(
  app: DevelopmentApp,
  assets: string,
): () => void {
  let closed = false;
  let busy = false;
  let reloads = 1;
  const send = (result: AppReloadResult) => {
    if (!closed) {
      process.send?.(result);
    }
  };
  const receive = (value: unknown) => {
    let request: AppReloadRequest;
    try {
      request = readAppReloadRequest(value);
    } catch (error) {
      console.error(error);
      return;
    }
    if (busy || reloads >= MAX_APP_RELOADS) {
      send({
        kind: "bunaway:reload-result",
        id: request.id,
        status: "restart",
      });
      return;
    }
    busy = true;
    const reload = async () => {
      const entry = resolve(assets, "reloads", request.id, "app.js");
      const canonical = await realpath(entry);
      if (
        relative(assets, canonical).replaceAll("\\", "/") !==
        `reloads/${request.id}/app.js`
      ) {
        throw new Error("App reload entry escapes its generation directory.");
      }
      const bytes = await readFile(canonical);
      if (createHash("sha256").update(bytes).digest("hex") !== request.sha256) {
        throw new Error("App reload hash does not match.");
      }
      // ponytail: Bun retains imported generations; restart after 100 loads until it supports eviction.
      reloads += 1;
      const module: {
        default?: AppDefinition;
      } = await import(pathToFileURL(canonical).href);
      if (closed) {
        return;
      }
      if (!module.default?.commands || !module.default.events) {
        throw new Error("App must default-export an AppDefinition.");
      }
      const replaced = app.replace(module.default);
      send({
        kind: "bunaway:reload-result",
        id: request.id,
        status: replaced ? "reloaded" : "restart",
      });
    };
    void reload()
      .catch((error: unknown) => {
        console.error("App reload failed:", error);
        send({
          kind: "bunaway:reload-result",
          id: request.id,
          status: "failed",
          message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, MAX_APP_RELOAD_MESSAGE_CHARS),
        });
      })
      .finally(() => {
        busy = false;
      });
  };
  process.on("message", receive);
  process.send?.({
    kind: "bunaway:reload-ready",
  });
  return () => {
    closed = true;
    process.off("message", receive);
  };
}
