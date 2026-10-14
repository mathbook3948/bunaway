import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageFilename } from "#cli/distribution";
import { writeJson } from "#cli/files";
import { installedPlugins } from "#cli/plugins";
import { createProject, packageDirectory } from "./project.ts";

test("isolated network package ships both async adapters and keeps Bun transport code out of browser bundles", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-network-install-")),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("isolated network"),
  });
  try {
    const artifacts = await packageDirectory();
    const project = await createProject(resolve(home, "app"));
    const path = resolve(project, "package.json");
    const manifest = await Bun.file(path).json();
    delete manifest.dependencies["@bunaway/plugin-storage"];
    manifest.dependencies["@bunaway/plugin-network"] =
      `file:${resolve(artifacts, packageFilename("@bunaway/plugin-network", "0.0.0"))}`;
    await writeJson(path, manifest);
    const install = Bun.spawn(
      [
        process.execPath,
        "install",
        "--linker",
        "isolated",
      ],
      {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(install.stdout).text();
    const errors = new Response(install.stderr).text();
    expect(await install.exited, `${await output}\n${await errors}`).toBe(0);
    const installed = await installedPlugins(project, "0.0.0");
    expect(installed.map((plugin) => plugin.name)).toEqual([
      "network",
    ]);
    const plugin = installed[0];
    expect(plugin).toBeDefined();
    for (const platform of [
      "windows",
      "macos",
    ] as const) {
      const target = plugin?.targets[platform];
      expect(target?.thread).toBe("ui");
      expect(target?.operations).toBeDefined();
      if (!target?.operations) {
        throw new Error("Missing native network export");
      }
      const nativePlugin = (await import(pathToFileURL(target.operations).href))
        .default;
      const adapter = nativePlugin._definition.nativePlatforms[platform].create(
        {
          dataRoot: home,
          capabilities: [],
        },
      );
      try {
        expect(adapter.executeUI).toBeFunction();
        const response = await adapter.executeUI(
          "network.request",
          {
            url: server.url.href,
          },
          "view:test",
          {
            requestId: crypto.randomUUID(),
            permissions: {
              permissions: [
                "network.request",
              ],
            },
          },
        );
        expect(response.status).toBe(200);
        expect(Buffer.from(response.bodyBase64, "base64").toString()).toBe(
          "isolated network",
        );
        // Complete operation handlers support trusted direct adapter calls as well as contextual dispatch.
        const direct = await adapter.execute(
          "network.request",
          {
            url: server.url.href,
          },
          "backend",
        );
        expect(direct.status).toBe(200);
        expect(Buffer.from(direct.bodyBase64, "base64").toString()).toBe(
          "isolated network",
        );
      } finally {
        await adapter.dispose();
      }
    }
    const browserEntry = resolve(project, "network-browser.ts");
    await Bun.write(
      browserEntry,
      'import network from "@bunaway/plugin-network"; void network.request({url:"https://example.com"});',
    );
    const browser = await Bun.build({
      entrypoints: [
        browserEntry,
      ],
      target: "browser",
      metafile: true,
    });
    expect(browser.success).toBe(true);
    for (const path of Object.keys(browser.metafile?.inputs ?? {})) {
      expect(path).not.toMatch(
        /(?:bun:ffi|native[\\/](?:macos|windows)\.js|bun-adapter\.ts|websocket\.ts|http\.ts)/,
      );
    }
    const source = await browser.outputs[0]?.text();
    expect(source).not.toContain("new WebSocket");
    expect(source).not.toContain("AbortSignal.any");
    expect(source).not.toContain("Network request timed out.");
  } finally {
    server.stop(true);
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60_000);
