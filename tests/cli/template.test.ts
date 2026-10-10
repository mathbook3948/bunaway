import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type Project, validateProject } from "#cli/config";
import { appModules } from "#cli/app-modules";
import { installedPackageRoot } from "#cli/files";
import { assertAppDefinitionExport, buildWithSdk, sdkPlugin } from "#cli/sdk";
import { createClient } from "@bunaway/client";
import {
  PROTOCOL_VERSION,
  type ProcessFrame,
  parseHostCall,
  parseProcessFrame,
  type TransportEvent,
} from "@bunaway/protocol";
import { readJsonLines } from "@bunaway/runtime-bun";
import { createProject } from "./project.ts";

/** Bundle the legacy process adapter only for its SDK contract test. */
async function bundleProcessBackend(
  project: Project,
  assets: string,
): Promise<void> {
  await assertAppDefinitionExport(project.appEntry);
  await mkdir(assets, {
    recursive: true,
  });
  const runtime = resolve(
    await installedPackageRoot(project.frameworkRoot, "@bunaway/runtime-bun"),
    "src/index.ts",
  );
  const sdk = await sdkPlugin(project.root, [], project.nativePlugins);
  const outputs = await buildWithSdk(
    {
      entrypoints: [
        "bunaway-generated/backend.ts",
      ],
      root: project.root,
      target: "bun",
      packages: "bundle",
    },
    {
      name: "process-contract-entry",
      setup(build) {
        sdk.setup(build);
        appModules({
          appEntry: project.appEntry,
          processRuntime: runtime,
        }).setup(build);
      },
    },
  );
  const output = outputs[0];
  if (outputs.length !== 1 || !output) {
    throw new Error("Missing backend bundle.");
  }
  await Bun.write(resolve(assets, "backend.js"), await output.arrayBuffer());
}

test("external generated backend uses actual SDK command/storage/event; revoked saves are not replayed", async () => {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-template-")),
  );
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const project = await createProject(resolve(root, "independent"));
    const install = Bun.spawn(
      [
        process.execPath,
        "install",
      ],
      {
        cwd: project,
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const installErrors = new Response(install.stderr).text();
    expect(await install.exited, await installErrors).toBe(0);
    const assets = resolve(root, "assets");
    const definition = await validateProject(project);
    await bundleProcessBackend(definition, assets);
    const backend = resolve(assets, "backend.js");
    const processChild = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-install",
        backend,
      ],
      {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child = processChild;
    const timeout = setTimeout(() => processChild.kill(), 12000);
    const errors = new Response(processChild.stderr).text();
    const frames = readJsonLines(processChild.stdout)[Symbol.asyncIterator]();
    // Attach one runtime identity to every test-side frame sent to the backend.
    const send = (body: Record<string, unknown>) =>
      processChild.stdin.write(
        `${JSON.stringify({
          ...body,
          ipc: PROTOCOL_VERSION,
          runtime: {
            id: "template",
            generation: "fresh",
          },
        })}\n`,
      );
    const next = async () => {
      const line = await frames.next();
      if (line.done) {
        throw new Error("Unexpected EOF");
      }
      return parseProcessFrame(line.value);
    };
    try {
      send({
        kind: "boot",
        payload: {
          entrypoint: backend,
          buildId: "template",
          backendContext: "backend-test",
          policy: definition.policy,
        },
      });
      expect((await next()).kind).toBe("hello");
      send({
        kind: "hello",
        payload: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          features: [],
          buildId: "host",
        },
      });
      expect((await next()).kind).toBe("ready");
      const receivers = new Map<string, (event: TransportEvent) => void>();
      const completedWrites: string[] = [];
      let stored = "";
      let held:
        | Extract<
            ProcessFrame,
            {
              kind: "host-request";
            }
          >
        | undefined;
      let holdReached: (() => void) | undefined;
      const hold = new Promise<void>((resolveHold) => {
        holdReached = resolveHold;
      });
      const reading = (async () => {
        // Act as the native host and hold one write while its UI session is revoked.
        for (;;) {
          const line = await frames.next();
          if (line.done) {
            break;
          }
          const frame = parseProcessFrame(line.value);
          if (frame.kind === "web") {
            receivers.get(frame.context)?.({
              kind: "message",
              text: JSON.stringify(frame.payload),
            });
          }
          if (frame.kind === "host-request") {
            expect(frame.context).toMatch(/^ctx-/);
            const call = parseHostCall(
              JSON.stringify({
                operation: frame.operation,
                payload: frame.payload,
              }),
            );
            if (
              call.operation === "storage.writeText" &&
              (
                call.payload as {
                  text: string;
                }
              ).text === "pending save"
            ) {
              held = frame;
              holdReached?.();
              continue;
            }
            if (call.operation === "storage.writeText") {
              expect(
                (
                  call.payload as {
                    scope: string;
                  }
                ).scope,
              ).toBe("appData");
              expect(
                (
                  call.payload as {
                    path: string;
                  }
                ).path,
              ).toBe("messages/current.txt");
              stored = (
                call.payload as {
                  text: string;
                }
              ).text;
              completedWrites.push(stored);
            }
            send({
              kind: "host-response",
              context: frame.context,
              requestId: frame.requestId,
              payload: {
                kind: "result",
                payload: call.operation === "storage.readText" ? stored : null,
              },
            });
          }
        }
      })();
      /** Creates a UI client whose close operation revokes its runtime context. */
      const session = (context: string) => {
        send({
          kind: "session-open",
          context,
          viewId: "main",
        });
        return createClient({
          hello: {
            kind: "hello",
            protocol: PROTOCOL_VERSION,
            features: [],
            buildId: "ui",
          },
          transport: {
            async send(text) {
              send({
                kind: "web",
                context,
                payload: JSON.parse(text),
              });
            },
            subscribe(listener) {
              receivers.set(context, listener);
              return () => {
                receivers.delete(context);
              };
            },
            async close() {
              send({
                kind: "revoke",
                context,
              });
              receivers.delete(context);
            },
          },
        });
      };
      const first = session("ctx-first");
      await first.ready;
      const events: unknown[] = [];
      await first.listen(
        "message.saved",
        (event) => {
          events.push(event.payload);
        },
        {
          onError() {},
        },
      );
      expect(await first.invoke("message.save", "saved via SDK")).toBeNull();
      expect(await first.invoke("message.read", null)).toBe("saved via SDK");
      expect(events).toEqual([
        "saved via SDK",
      ]);
      const pending = first
        .invoke("message.save", "pending save")
        .catch((error: unknown) => error);
      await hold;
      await first.close();
      expect(await pending).toBeInstanceOf(Error);
      const second = session("ctx-second");
      await second.ready;
      if (!held) {
        throw new Error("Missing held request.");
      }
      // A late response for the revoked context must not replay its pending save.
      send({
        kind: "host-response",
        context: held.context,
        requestId: held.requestId,
        payload: {
          kind: "result",
          payload: null,
        },
      });
      expect(await second.invoke("message.read", null)).toBe("saved via SDK");
      expect(completedWrites).toEqual([
        "saved via SDK",
      ]);
      expect(events).toEqual([
        "saved via SDK",
      ]);
      await second.close();
      send({
        kind: "shutdown",
      });
      processChild.stdin.end();
      expect(await processChild.exited).toBe(0);
      await reading;
      expect(await errors).toBe("");
    } finally {
      clearTimeout(timeout);
      processChild.kill();
      await processChild.exited;
    }
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}, 30000);
