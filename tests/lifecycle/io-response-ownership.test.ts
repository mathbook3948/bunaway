import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { HostContext } from "@bunaway/protocol";
import { Channel, type Packet } from "@bunaway/runtime-bun/worker-channel";
import { bundleIOPluginFixture } from "../fixtures/native-worker.ts";

const slots = {
  allocated: 0,
  released: 1,
  aborted: 2,
  retained: 3,
  disposed: 4,
};

test.each([
  "cancel",
  "revoke",
  "shutdown",
  "accepted",
] as const)(
  "I/O resource cancellation ownership lasts until response acceptance: %s",
  async (mode) => {
    const directory = await mkdtemp(resolve(tmpdir(), "bunaway-io-handoff-"));
    const state = new Int32Array(
      new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    );
    const acceptance = Promise.withResolvers<void>();
    let worker: Worker | undefined;
    let channel: Channel | undefined;
    try {
      const plugin = {
        name: "owned",
        version: "development",
        execution: "io" as const,
        native: {
          operations: [
            {
              name: "owned.create",
            },
            {
              name: "owned.inspect",
            },
          ],
        },
      };
      await bundleIOPluginFixture(
        directory,
        [
          plugin,
        ],
        `
        import {workerData} from "node:worker_threads";
        import {defineNativePlugin} from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
        import {ImageResources} from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/image/src/resources.ts"))};
        import {z} from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
        const state=new Int32Array(workerData.state);
        const slots=${JSON.stringify(slots)};
        const resources=new ImageResources();
        let resource;
        let creationSignal;
        const retained=()=>{try{resources.get(resource.id);return true;}catch{return false;}};
        const plugin=defineNativePlugin({name:"owned",operations:{
          create:{input:z.null(),output:z.object({id:z.string()}).strict()},
          inspect:{input:z.null(),output:z.object({retained:z.boolean(),aborted:z.boolean()}).strict()},
        },platforms:{windows:{execution:"io",create:()=>({
          execute(){throw new Error("Context required");},
          executeUI(name,_input,_source,context){
            if(name==="owned.inspect") return {retained:retained(),aborted:creationSignal.aborted};
            creationSignal=context.signal;
            resource=resources.create({width:1,height:1,rgba:Buffer.from([1,2,3,255])},creationSignal);
            Atomics.store(state,slots.retained,Number(retained()));
            creationSignal.addEventListener("abort",()=>{
              Atomics.store(state,slots.aborted,1);
              Atomics.store(state,slots.retained,Number(retained()));
            },{once:true});
            Atomics.store(state,slots.allocated,1);
            while(Atomics.load(state,slots.released)===0) Atomics.wait(state,slots.released,0,1000);
            return {id:resource.id};
          },
          dispose(){resources.dispose();Atomics.store(state,slots.disposed,1);}
        })}}});
        export const pluginImports={owned:{operations:async()=>({createOperations:plugin.definition.nativePlatforms.windows.create})}};
      `,
      );
      const runtime = {
        id: "handoff",
        generation: crypto.randomUUID(),
      };
      const context = "backend" as HostContext;
      worker = new Worker(
        pathToFileURL(resolve(directory, "host-operations.js")),
        {
          workerData: {
            runtime,
            assets: directory,
            dataRoot: directory,
            plugins: [
              plugin,
            ],
            state: state.buffer,
            policy: {
              version: 1,
              views: [],
              backend: {
                permissions: [
                  "owned.create",
                  "owned.inspect",
                ],
              },
            },
          },
        },
      );
      let failure: unknown;
      const exited = new Promise<number>((done) => worker?.once("exit", done));
      worker.on("error", (error) => {
        failure = error;
      });
      const packets: Packet[] = [];
      channel = new Channel(
        worker,
        runtime,
        "main-io",
        (packet) => {
          packets.push(packet);
          if (
            packet.kind === "host-response" &&
            packet.requestId === "creation"
          ) {
            return acceptance.promise;
          }
        },
        (error) => {
          failure = error;
        },
      );
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          if (failure) {
            throw failure;
          }
          if (Date.now() >= deadline) {
            throw new Error("I/O handoff fixture timed out.");
          }
          await Bun.sleep(1);
        }
      };
      const seen = (kind: Packet["kind"], id?: string) =>
        packets.some(
          (packet) =>
            packet.kind === kind &&
            (id === undefined ||
              ("requestId" in packet && packet.requestId === id)),
        );
      await waitFor(() => seen("ready"));
      const prepare = async (requestId: string, operation: string) => {
        await channel?.send({
          kind: "operation",
          context,
          requestId,
          source: "backend",
          call: {
            operation,
            payload: null,
          },
        });
        await waitFor(() => seen("authorize-input", requestId));
        await channel?.send({
          kind: "input-authorized",
          context,
          requestId,
          allowed: true,
        });
        await waitFor(() => seen("prepare", requestId));
      };
      await prepare("creation", "owned.create");
      const granting = channel.send({
        kind: "grant",
        context,
        requestId: "creation",
        allowed: true,
      });
      await waitFor(() => Atomics.load(state, slots.allocated) === 1);
      expect(Atomics.load(state, slots.retained)).toBe(1);
      let control: Promise<void> | undefined;
      if (mode === "cancel") {
        control = channel.send({
          kind: "cancel",
          context,
          requestId: "creation",
        });
      }
      if (mode === "revoke") {
        control = channel.send({
          kind: "cancel-context",
          context,
        });
      }
      if (mode === "shutdown") {
        control = channel.send({
          kind: "shutdown",
        });
      }
      Atomics.store(state, slots.released, 1);
      Atomics.notify(state, slots.released);
      await granting;
      await waitFor(() => seen("host-response", "creation"));
      await control;
      if (mode === "accepted") {
        acceptance.resolve();
        // The next input authorization round trip follows the response ack on this same port.
        await prepare("inspect", "owned.inspect");
        await channel.send({
          kind: "grant",
          context,
          requestId: "inspect",
          allowed: true,
        });
        await waitFor(() => seen("host-response", "inspect"));
        await channel.send({
          kind: "cancel",
          context,
          requestId: "creation",
        });
        expect(Atomics.load(state, slots.aborted)).toBe(0);
        expect(Atomics.load(state, slots.retained)).toBe(1);
      } else {
        expect(Atomics.load(state, slots.aborted)).toBe(1);
        expect(Atomics.load(state, slots.retained)).toBe(0);
        expect(Atomics.load(state, slots.disposed)).toBe(0);
        acceptance.resolve();
      }
      if (mode !== "shutdown") {
        await channel.send({
          kind: "shutdown",
        });
      }
      expect(await exited).toBe(0);
      expect(seen("cleaned")).toBe(true);
      expect(Atomics.load(state, slots.disposed)).toBe(1);
      expect(failure).toBeUndefined();
    } finally {
      Atomics.store(state, slots.released, 1);
      Atomics.notify(state, slots.released);
      acceptance.resolve();
      await worker?.terminate();
      channel?.close();
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
  15_000,
);
