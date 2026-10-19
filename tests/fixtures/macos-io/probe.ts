import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
import { BunawayError, defineNativePlugin } from "@bunaway/plugin";
import { z } from "zod";
import { ImageResources } from "../../../plugins/image/src/platforms/resources.ts";

const id = z.string().regex(/^[a-z0-9-]+$/);
const input = z
  .object({
    id,
    mode: z.enum([
      "normal",
      "block",
      "hold",
      "fail",
      "wait-abort",
      "resource",
    ]),
  })
  .strict();

/** Controlled adapter with real filesystem effects for host lifecycle regression tests. */
export const probe = defineNativePlugin({
  name: "probe",
  operations: {
    run: {
      input: input.transform(async (value) => {
        const directory = process.env.TMPDIR;
        if (!directory) {
          throw new Error("Missing host temp directory.");
        }
        if (value.mode === "hold") {
          writeFileSync(resolve(directory, `${value.id}-parsing`), "started");
          while (!existsSync(resolve(directory, `${value.id}-release`))) {
            await Bun.sleep(5);
          }
        }
        return value;
      }),
      output: z
        .object({
          source: z.string(),
          thread: z.number(),
          main: z.boolean(),
        })
        .strict(),
    },
    inspect: {
      input: id,
      output: z.boolean(),
    },
    resourceState: {
      input: z.null(),
      output: z
        .object({
          retained: z.boolean(),
          aborted: z.boolean(),
        })
        .strict(),
    },
    snapshot: {
      input: z.null(),
      output: z.array(
        z
          .object({
            name: z.string(),
            support: z.enum([
              "supported",
              "unsupported",
              "experimental",
            ]),
          })
          .strict(),
      ),
    },
    denied: {
      input: z.null().transform((value) => {
        writeFileSync(
          resolve(process.env.TMPDIR ?? "", "denied-parsed"),
          "forbidden",
        );
        return value;
      }),
      output: z.null(),
    },
    unsupported: {
      input: z.null(),
      output: z.null(),
    },
  },
  platforms: {
    macos: {
      thread: "worker",
      operations: [
        "run",
        "inspect",
        "resourceState",
        "snapshot",
        "denied",
      ],
      create(environment) {
        if (isMainThread || environment.windows) {
          throw new Error("I/O adapter initialized on the UI thread.");
        }
        if (existsSync(resolve(environment.dataRoot, "init-failure"))) {
          throw new Error("Fixture I/O initialization failed.");
        }
        const temporary = resolve(environment.dataRoot, "temp");
        const resources = new ImageResources();
        let allocation:
          | {
              id: string;
              signal: AbortSignal;
            }
          | undefined;
        /** Reports whether the allocated image is still retained and whether its request was aborted. */
        const resourceState = () => {
          if (!allocation) {
            throw new Error("Missing resource creation.");
          }
          let retained = true;
          try {
            resources.get(allocation.id);
          } catch {
            retained = false;
          }
          return {
            retained,
            aborted: allocation.signal.aborted,
          };
        };
        /** Resolves only when the request is aborted, recording the abort for the host test. */
        const waitForAbort = (
          requestId: string,
          signal: AbortSignal,
          source: string,
        ) => {
          writeFileSync(resolve(temporary, `${requestId}-source`), source);
          return new Promise((resolveCall) => {
            signal.addEventListener(
              "abort",
              () => {
                if (existsSync(resolve(temporary, "io-disposing"))) {
                  throw new Error(
                    "Native abort arrived after adapter disposal.",
                  );
                }
                writeFileSync(
                  resolve(temporary, `${requestId}-aborted`),
                  "aborted",
                );
                resolveCall({
                  source,
                  thread: threadId,
                  main: isMainThread,
                });
              },
              {
                once: true,
              },
            );
          });
        };
        /** Allocates an image tied to the request and blocks until the host releases it. */
        const holdResource = (requestId: string, signal: AbortSignal) => {
          const created = resources.create(
            {
              width: 1,
              height: 1,
              rgba: Buffer.from([
                1,
                2,
                3,
                255,
              ]),
            },
            signal,
          );
          allocation = {
            id: created.id,
            signal,
          };
          writeFileSync(
            resolve(temporary, `${requestId}-allocated`),
            "allocated",
          );
          const pause = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(resolve(temporary, `${requestId}-release`))) {
            Atomics.wait(pause, 0, 0, 25);
          }
        };
        return {
          execute() {
            throw new BunawayError({
              code: "UNSUPPORTED",
              message: "Fixture requires contextual execution.",
            });
          },
          executeUI(operation, value, source, context) {
            if (
              !context.requestId ||
              !context.signal ||
              !context.permissions.permissions.includes(operation)
            ) {
              throw new Error("I/O request context was not preserved.");
            }
            context.signal.throwIfAborted();
            context.beforeExecute?.();
            if (operation === "probe.resourceState") {
              return resourceState();
            }
            if (operation === "probe.inspect") {
              return existsSync(
                resolve(temporary, `${id.parse(value)}-executed`),
              );
            }
            if (operation === "probe.snapshot") {
              return environment.capabilities;
            }
            const request = input.parse(value);
            writeFileSync(
              resolve(temporary, `${request.id}-executing`),
              "started",
            );
            if (request.mode === "wait-abort") {
              return waitForAbort(request.id, context.signal, source);
            }
            if (request.mode === "resource") {
              holdResource(request.id, context.signal);
            }
            if (request.mode === "fail") {
              throw new BunawayError({
                code: "INVALID_ARGUMENT",
                message: "Fixture execution rejected.",
              });
            }
            if (request.mode === "block") {
              // Block only the adapter's Worker while the actual WKWebView keeps exchanging messages.
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                2500,
              );
            }
            writeFileSync(resolve(temporary, `${request.id}-executed`), "done");
            return {
              source,
              thread: threadId,
              main: isMainThread,
            };
          },
          dispose() {
            resources.dispose();
            writeFileSync(resolve(temporary, "io-disposing"), "started");
            if (!existsSync(resolve(temporary, "core-cleaned"))) {
              throw new Error("Native cleanup ran before Core hooks.");
            }
            if (existsSync(resolve(environment.dataRoot, "block-cleanup"))) {
              while (true) {}
            }
            writeFileSync(
              resolve(temporary, "io-cleaned"),
              readFileSync(resolve(temporary, "core-cleaned")),
            );
          },
        };
      },
    },
  },
});
