import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildProject } from "../../packages/cli/src/build.ts";
import { createProject } from "./project.ts";

const macos = process.platform === "darwin" && process.arch === "arm64";

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
