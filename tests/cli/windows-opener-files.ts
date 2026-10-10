import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appModules } from "#cli/app-modules";
import { installedPlugins } from "#cli/plugins";

/** Run a captured subprocess and wait for its exit before removing fixture files. */
async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${await output}\n${await errors}`);
  }
}

/**
 * Run an installed plugin in a compiled I/O adapter probe. The executable file opens by
 * its default action; Explorer's selected item is observed separately. No user
 * file associations or existing application windows are changed.
 */
export async function verifyWindowsOpenerFiles(
  project: string,
  assets: string,
): Promise<void> {
  const root = resolve(project, "opener 한글 files");
  await mkdir(root);
  const sample = resolve(root, "공백, 한글 😀.txt");
  const marker = resolve(root, "accepted.json");
  const helperSource = resolve(project, "file-handler.ts");
  const helper = resolve(root, "기본 실행, 한글 😀.exe");
  const probeSource = resolve(project, "file-probe.ts");
  const probe = resolve(project, "file-probe.exe");
  const selectionScript = resolve(project, "selection.ps1");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const powershell = [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ];
  try {
    await writeFile(sample, "Explorer selection test");
    await writeFile(
      helperSource,
      `await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));`,
    );
    const compiledHelper = resolve(project, "file-handler.exe");
    await run(
      [
        process.execPath,
        "build",
        "--compile",
        `--compile-executable-path=${process.execPath}`,
        "--windows-hide-console",
        "--outfile",
        compiledHelper,
        helperSource,
      ],
      project,
    );
    await rename(compiledHelper, helper);
    await writeFile(
      probeSource,
      `import assert from "node:assert/strict";
import { loadPluginCatalog } from ${JSON.stringify(resolve("native/host-api/bun/plugin-catalog.ts"))};
import { operations } from ${JSON.stringify(resolve("native/host-api/bun/plugins.ts"))};
import app from "./src-bunaway/app.ts";
import { pluginImports } from ${JSON.stringify(resolve(assets, "plugin-imports.js"))};
const catalog = await loadPluginCatalog(${JSON.stringify(assets)}, pluginImports);
const adapter = await operations(app.plugins, ${JSON.stringify(project)}, "io", undefined, catalog);
try {
  for (const [action, path] of [["openFile", ${JSON.stringify(helper)}], ["revealFile", ${JSON.stringify(sample)}]]) {
    assert.equal(adapter.execute("opener." + action, { path }, "backend"), null);
    if (action === "openFile") {
      const deadline = Date.now() + 10000;
      while (!(await Bun.file(${JSON.stringify(marker)}).exists())) {
        assert(Date.now() < deadline, "Explorer did not start the executable file.");
        await Bun.sleep(20);
      }
    }
  }
} finally {
  await adapter.dispose();
}
`,
    );
    const compiled = await Bun.build({
      entrypoints: [
        probeSource,
      ],
      target: "bun",
      compile: {
        outfile: probe,
        executablePath: process.execPath,
        windows: {
          hideConsole: true,
        },
      },
      plugins: [
        appModules({
          plugins: await installedPlugins(project, "0.0.0"),
        }),
      ],
    });
    if (!compiled.success) {
      throw new Error(compiled.logs.map(String).join("\n"));
    }
    await rm(probeSource);
    await rm(helperSource);
    // PowerShell 5.1 needs a BOM to read Unicode script literals as UTF-8.
    await writeFile(
      selectionScript,
      "\ufeff" +
        `$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$selected = $false
try {
  if ($args[0] -eq 'cleanup') { return }
  do {
    foreach ($window in $shell.Windows()) {
      try {
        if ($window.Document.Folder.Self.Path -ceq ${quote(root)}) {
          foreach ($item in $window.Document.SelectedItems()) {
            if ($item.Path -ceq ${quote(sample)}) { $selected = $true }
          }
        }
      } catch { } # Other shell windows may not expose a folder document.
    }
    if (-not $selected) { Start-Sleep -Milliseconds 50 }
  } while (-not $selected -and [DateTime]::UtcNow -lt $deadline)
  if (-not $selected) { throw 'Explorer did not select the requested file.' }
} finally {
  foreach ($window in $shell.Windows()) {
    try { if ($window.Document.Folder.Self.Path -ceq ${quote(root)}) { $window.Quit() } } catch { } # A window may already be closed.
  }
}
`,
    );
    await run(
      [
        probe,
      ],
      project,
    );
    await run(
      [
        ...powershell,
        selectionScript,
      ],
      project,
    );
  } finally {
    if (await Bun.file(selectionScript).exists()) {
      await run(
        [
          ...powershell,
          selectionScript,
          "cleanup",
        ],
        project,
      );
    }
  }
}
