import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildProject } from "#cli/build";
import { bundleMacosHost } from "#cli/assets";
import { compileMacosApp } from "#cli/macos-compile";
import { createProject } from "./project.ts";

const macos = process.platform === "darwin" && process.arch === "arm64";

test.skipIf(!macos)(
  "compiled macOS main and backend Worker read file imports after source and staging removal",
  async () => {
    const root = await realpath(
      await mkdtemp(resolve(tmpdir(), "bunaway-macos-file-assets-")),
    );
    try {
      const host = resolve(root, "host");
      const source = resolve(root, "source");
      const assets = resolve(root, "assets");
      for (const directory of [
        host,
        source,
        assets,
      ]) {
        await mkdir(directory);
      }
      await Bun.write(resolve(host, "main.txt"), "main asset");
      await Bun.write(
        resolve(host, "boot.ts"),
        `import { Worker } from "node:worker_threads";
import file from "./main.txt" with { type: "file" };
const worker = new Worker(new URL("./backend.js", import.meta.url));
const backend = await new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
});
console.log(JSON.stringify({main: await Bun.file(new URL(file, import.meta.url)).text(), backend}));`,
      );
      await Bun.write(
        resolve(host, "backend.ts"),
        `import { parentPort } from "node:worker_threads";
const { default: app } = await import("./app.js");
parentPort.postMessage(await app.read());
parentPort.close();`,
      );
      const text = "backend 한글 😀";
      const binary = Buffer.from([
        0,
        128,
        255,
      ]);
      const raw = "not valid JavaScript!";
      await Bun.write(resolve(source, "data.txt"), text);
      await Bun.write(resolve(source, "data.bin"), binary);
      await Bun.write(resolve(source, "raw.js"), raw);
      await Bun.write(
        resolve(source, "app.ts"),
        `import text from "./data.txt" with { type: "file" };
import binary from "./data.bin" with { type: "file" };
import raw from "./raw.js" with { type: "file" };
export default { read() {
  return Promise.all([text, binary, raw].map(async file =>
    Buffer.from(await Bun.file(new URL(file, import.meta.url)).arrayBuffer()).toString("hex")));
} };`,
      );
      await Bun.write(resolve(assets, "manifest.json"), "{}");
      const bundledAssets = await bundleMacosHost(
        host,
        assets,
        resolve(source, "app.ts"),
      );
      const executable = resolve(root, "probe");
      await compileMacosApp(
        assets,
        process.execPath,
        executable,
        bundledAssets,
      );
      for (const directory of [
        host,
        source,
        assets,
      ]) {
        await rm(directory, {
          recursive: true,
          force: true,
        });
      }
      const child = Bun.spawn(
        [
          executable,
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        },
      );
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(0);
      expect(JSON.parse(await output)).toEqual({
        main: "main asset",
        backend: [
          Buffer.from(text).toString("hex"),
          binary.toString("hex"),
          Buffer.from(raw).toString("hex"),
        ],
      });
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  15000,
);

test.skipIf(!macos)(
  "installed macOS CLI builds a signed Bun app without a native compiler or child runtime",
  async () => {
    const root = await realpath(
      await mkdtemp(resolve(tmpdir(), "bunaway macOS 한글 ")),
    );
    try {
      const project = await createProject(resolve(root, "app"));
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
      const errors = new Response(install.stderr).text();
      expect(await install.exited, await errors).toBe(0);
      const configPath = resolve(project, "src-bunaway/bunaway.json");
      const config = await Bun.file(configPath).json();
      const policyPath = resolve(project, "src-bunaway/policy.json");
      const policy = await Bun.file(policyPath).json();
      policy.backend.permissions = [];
      policy.views[0].commands = [
        "ping",
      ];
      policy.views[0].events = [];
      policy.views[0].host = {
        permissions: [],
      };
      await Bun.write(policyPath, JSON.stringify(policy));
      await Bun.write(configPath, JSON.stringify(config));
      await Bun.write(
        resolve(project, "src-bunaway/app.ts"),
        `export default {
      events: {}, commands: {ping: {input:{const:null},output:{const:"pong"},run:()=>"pong"}}
    };`,
      );
      const built = await buildProject(project);
      expect(built.executable).toEndWith("Contents/MacOS/bunaway-host");
      const manifest = await Bun.file(
        resolve(built.package, "manifest.json"),
      ).json();
      expect(manifest.host.kind).toBe("bun-compiled");
      expect(manifest.assets["assets/manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.assets["licenses/LICENSE.nlohmann-json"]).toBeUndefined();
      expect(
        await Bun.file(resolve(built.package, "runtime/bun")).exists(),
      ).toBe(false);
      const signature = Bun.spawn(
        [
          "/usr/bin/codesign",
          "--verify",
          "--deep",
          "--strict",
          built.output,
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const diagnostics = new Response(signature.stderr).text();
      expect(await signature.exited, await diagnostics).toBe(0);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);
