import { expect, setDefaultTimeout, test } from "bun:test";
import { cp, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bundleAssets } from "#cli/build";
import { validateProject } from "#cli/config";
import { deadline } from "../fixtures/deadlines.ts";
import { packageDirectory } from "./project.ts";

setDefaultTimeout(deadline("build"));

test("tray notes example validates and bundles as a one-window tray app", async () => {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-tray-notes-")),
  );
  try {
    const project = resolve(root, "examples/tray-notes");
    await cp(await packageDirectory(), resolve(root, "build/framework"), {
      recursive: true,
    });
    await cp(resolve(import.meta.dir, "../../examples/tray-notes"), project, {
      recursive: true,
      filter: (source) =>
        !/[\\/](node_modules|\.bunaway|dist|web-dist|bun\.lock)([\\/]|$)/.test(
          source,
        ),
    });
    // Keep package downloads inside this temporary project tree for cleanup.
    const command = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          ...args,
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            BUN_INSTALL_CACHE_DIR: resolve(root, "install-cache"),
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(0);
    };
    for (const args of [
      [
        "install",
      ],
      [
        resolve(import.meta.dir, "build.fixture.ts"),
        project,
      ],
      [
        "run",
        "bunaway",
        "validate",
      ],
    ]) {
      await command(args);
    }
    const definition = await validateProject(project);
    // The only window starts hidden; the tray Open item shows the window it creates.
    expect(definition.app.view).toBe("main");
    expect(definition.app.visible).toBe(false);
    expect(definition.policy.views.map((view) => view.id)).toEqual([
      "main",
    ]);
    expect(definition.policy.views[0]?.events).toEqual([
      "windows.closeRequested",
    ]);
    expect(definition.policy.views[0]?.commands).toContain(
      "plugin.windows.respondClose",
    );
    // Close requests and the window-state save and restore run with the view's permissions.
    expect(definition.policy.views[0]?.host.permissions).toEqual(
      expect.arrayContaining([
        "windows.respondClose",
        "windows.getNormalBounds",
        "windows.setOuterBounds",
        "store.load",
        "store.set",
        "store.save",
        "storage.exists",
      ]),
    );
    const assets = resolve(root, "windows-assets");
    await bundleAssets(definition, assets, true);
    expect((await readdir(resolve(assets, "web"))).sort()).toEqual([
      "assets",
      "index.html",
    ]);
    const html = await readFile(resolve(assets, "web/index.html"), "utf8");
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toContain("ws://");
    const app = (await import(resolve(assets, "app.js"))).default;
    expect(Object.keys(app.commands).sort()).toEqual([
      "notes.closing",
      "notes.read",
      "notes.restoreWindow",
      "notes.save",
    ]);
    // Closing the last window must keep the backend and the tray.
    expect(app.desktop.closeBehavior).toBe("keep-alive");
    expect(app.desktop.tray.tooltip).toBeString();
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
