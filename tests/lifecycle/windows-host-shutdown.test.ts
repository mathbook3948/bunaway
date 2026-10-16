import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  bundleIOPluginFixture,
  bundleUIPluginFixture,
} from "../fixtures/native-worker.ts";

test.each([
  "pending",
  "undelivered",
  "handoff",
] as const)(
  "Windows coordinator aborts %s native I/O before Core stop hooks and adapter disposal",
  (mode) => checkShutdown(mode),
  15_000,
);

test.skipIf(process.platform !== "win32")(
  "actual Windows UI Worker aborts backend I/O before Core hooks and native disposal",
  async () => {
    await checkShutdown("pending", true);
    await checkShutdown("undelivered", true);
  },
  30_000,
);

/** Run the production coordinator and I/O Worker, optionally with real Win32 UI and Job ownership. */
async function checkShutdown(
  mode: "pending" | "undelivered" | "handoff",
  nativeUI = false,
) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "bunaway-windows-io-stop-"),
  );
  try {
    const started = resolve(directory, "started");
    const aborted = resolve(directory, "aborted");
    const cleaned = resolve(directory, "core-cleaned");
    const disposed = resolve(directory, "disposed");
    const definition = {
      name: "waiting",
      version: "development",
      thread: "worker" as const,
      native: {
        operations: [
          {
            name: "waiting.run",
          },
        ],
      },
    };
    const adapter = resolve(directory, "adapter.ts");
    await Bun.write(
      adapter,
      `
      import {existsSync,writeFileSync} from "node:fs";
      import {ImageResources} from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/image/src/platforms/resources.ts"))};
      import {defineNativePlugin} from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
      import {z} from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
      const resources=new ImageResources();
      export const plugin=defineNativePlugin({name:"waiting",operations:{run:{input:z.null(),output:z.null()}},platforms:{windows:{thread:"worker",create:()=>({
        execute(){throw new Error("Context required");},
        executeUI(_name,_input,source,context){
          if(source!=="backend") throw new Error("Wrong source");
          const resource=resources.create({width:1,height:1,rgba:Buffer.from([1,2,3,255])},context.signal);
          writeFileSync(${JSON.stringify(started)},"started");
          return new Promise(resolveCall=>{
            ${mode !== "pending" ? "setTimeout(()=>resolveCall(null),100);" : ""}
            context.signal.addEventListener("abort",()=>{
            if(existsSync(${JSON.stringify(disposed)})) throw new Error("Disposed before abort");
            let retained=true;try{resources.get(resource.id);}catch{retained=false;}
            if(retained) throw new Error("Undelivered image resource retained after abort");
            writeFileSync(${JSON.stringify(aborted)},"aborted");resolveCall(null);
          },{once:true});});
        },
        dispose(){
          if(!existsSync(${JSON.stringify(cleaned)})) throw new Error("Disposed before Core hooks completed");
          resources.dispose();writeFileSync(${JSON.stringify(disposed)},"disposed");
        }
      })}}});
    `,
    );
    const imports = `
      import {plugin} from ${JSON.stringify(adapter)};
      export const pluginImports={waiting:{operations:async()=>({createOperations:plugin._definition.nativePlatforms.windows.create})}};
    `;
    await bundleIOPluginFixture(
      directory,
      [
        definition,
      ],
      imports,
    );
    if (nativeUI) {
      await bundleUIPluginFixture(
        directory,
        [
          definition,
        ],
        imports,
      );
    } else {
      await Bun.write(
        resolve(directory, "ui.js"),
        `
      import {parentPort,workerData} from "node:worker_threads";
      import {Channel} from ${JSON.stringify(resolve(import.meta.dir, "../../packages/runtime-bun/src/worker-channel.ts"))};
      const channel=new Channel(parentPort,workerData.runtime,"ui",packet=>{
        if(packet.kind==="authorize-input" || packet.kind==="authorize") channel.notify({
          kind:packet.kind==="authorize-input" ? "input-authorized" : "authorized",
          context:packet.context,requestId:packet.requestId,allowed:true
        });
        else if(packet.kind==="start") {${mode === "handoff" ? "" : 'channel.notify({kind:"closing",reason:"window-destroyed"});'}}
        // Accept the result into UI ownership, then close before forwarding it to Core.
        else if(packet.kind==="host-result") setTimeout(()=>channel.notify({kind:"closing",reason:"window-destroyed"}),100);
        else if(packet.kind==="shutdown") void (async()=>{
          await channel.send({kind:"cleaned"});await channel.drain();channel.close();parentPort.close();
        })().catch(error=>{console.error(error);process.exit(1);});
        else if(packet.kind!=="cancel" && packet.kind!=="cancel-context") throw new Error("Unexpected UI control");
      },error=>{console.error(error);process.exit(1);});
      channel.notify({kind:"ready"});
    `,
      );
    }
    const config = {
      runtime: {
        id: "windows-shutdown",
        generation: crypto.randomUUID(),
      },
      backendContext: "backend",
      dataRoot: directory,
      assets: directory,
      loader: "fixture",
      windows: [],
      policy: {
        version: 1,
        views: [],
        backend: {
          permissions: [
            "waiting.run",
          ],
        },
      },
    };
    const source = resolve(directory, "run-source.ts");
    await Bun.write(
      source,
      `
      import {existsSync,writeFileSync} from "node:fs";
      import {defineApp} from ${JSON.stringify(Bun.resolveSync("@bunaway/backend", import.meta.dir))};
      import {runWindowsApp} from ${JSON.stringify(resolve(import.meta.dir, "../../native/windows/bun/entry.ts"))};
      import {plugin} from ${JSON.stringify(adapter)};
      const app=defineApp({modules:[],commands:{},events:{},desktop:{closeBehavior:"keep-alive"},plugins:[plugin._definition,{name:"setup",version:"1",async setup(){
        const pending=plugin.run(null).catch(error=>{if(error.code!=="CANCELLED") throw error;});
        while(!existsSync(${JSON.stringify(started)})) await Bun.sleep(5);
        return async()=>{
          await pending;
          const deadline=Date.now()+2000;
          while(!existsSync(${JSON.stringify(aborted)})) {
            if(Date.now()>=deadline) throw new Error("Native abort did not precede Core cleanup");
            await Bun.sleep(5);
          }
          if(existsSync(${JSON.stringify(disposed)})) throw new Error("Disposal ran before the Core hook");
          writeFileSync(${JSON.stringify(cleaned)},"cleaned");
        };
      }}]});
      const inbox=${nativeUI || mode === "undelivered" ? `{start(){${nativeUI ? 'process.emit("SIGINT");' : ""}},async close(){${mode === "undelivered" ? "await Bun.sleep(250);" : ""}}}` : "undefined"};
      try{await runWindowsApp(app,${JSON.stringify(config)},undefined,inbox);}catch(error){console.error(error);process.exitCode=1;}
    `,
    );
    const build = await Bun.build({
      entrypoints: [
        source,
      ],
      target: "bun",
      outdir: directory,
      naming: "run.js",
      plugins: [
        {
          name: "windows-coordinator-platform-fixture",
          setup(build) {
            if (!nativeUI) {
              build.onResolve(
                {
                  filter: /^\.\/job\.ts$/,
                },
                () => ({
                  path: "job",
                  namespace: "fixture-job",
                }),
              );
            }
            build.onLoad(
              {
                filter: /.*/,
                namespace: "fixture-job",
              },
              () => ({
                contents:
                  "export function containAppProcess(){} export function activeDescendants(){return 0;}",
                loader: "js",
              }),
            );
            build.onResolve(
              {
                filter: /^bunaway:plugin-imports$/,
              },
              () => ({
                path: resolve(directory, "plugin-imports.js"),
              }),
            );
          },
        },
      ],
    });
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    for (const output of build.outputs) {
      await Bun.write(output.path, await output.arrayBuffer());
    }
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(directory, "run.js"),
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const errors = new Response(child.stderr).text();
    expect(await child.exited, await errors).toBe(0);
    expect(await Bun.file(aborted).text()).toBe("aborted");
    expect(await Bun.file(cleaned).text()).toBe("cleaned");
    expect(await Bun.file(disposed).text()).toBe("disposed");
    const records = (await Bun.file(resolve(directory, "logs/host.log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      event: "host-stopped",
      failed: false,
      forced: false,
      activeProcesses: 0,
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}
