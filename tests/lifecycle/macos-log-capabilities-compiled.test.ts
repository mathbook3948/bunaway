import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("compiled macOS adapter probe reports executable support and writes through generated exports on the current OS", async () => {
  const root = resolve(import.meta.dir, "../..");
  const directory = mkdtempSync(
    resolve(tmpdir(), "bunaway-macos-compiled-log-"),
  );
  try {
    const source = resolve(directory, "probe.ts");
    const executable = resolve(
      directory,
      process.platform === "win32" ? "probe.exe" : "probe",
    );
    await Bun.write(
      source,
      `
import assert from "node:assert/strict";
import capabilities from ${JSON.stringify(Bun.resolveSync("@bunaway/plugin-capabilities/native/macos", root))};
import log from ${JSON.stringify(Bun.resolveSync("@bunaway/plugin-log/native/macos", root))};
import { operations } from ${JSON.stringify(resolve(root, "native/host-api/bun/plugins.ts"))};
const plugins = [log._definition, capabilities._definition];
const catalog = plugins.map(plugin => {
  const platform = plugin.nativePlatforms.macos;
  assert(platform?.thread === "worker");
  return {name:plugin.name,version:plugin.version,native:plugin.native,
    thread:platform.thread,operations:async()=>({createOperations:platform.create})};
});
const dispatcher = await operations(plugins, process.argv[2], "worker", undefined, catalog);
try {
  const support = await dispatcher.execute("capabilities.get", null, "backend");
  assert.deepEqual(JSON.parse(JSON.stringify(support)), [{name:"log.write",support:"supported"},{name:"log.configure",support:"supported"},{name:"log.flush",support:"supported"},{name:"capabilities.get",support:"supported"}]);
  for (const capability of support) {
    const input = capability.name === "log.write" ? {level:"info",message:"compiled 한글 😀"} : capability.name === "log.configure" ? {} : null;
    await dispatcher.execute(capability.name, input, "backend");
  }
  await Promise.all(Array.from({length:32},(_,index)=>dispatcher.execute("log.write",{level:"info",message:"ordered",details:{index}},"view:main")));
  await dispatcher.execute("log.configure", {minimumLevel:"error",maxFileBytes:4096,maxArchives:2}, "backend");
  await dispatcher.execute("log.write",{level:"debug",message:"filtered"},"view:main");
  await assert.rejects(dispatcher.execute("log.configure",{},"view:main"),{code:"PERMISSION_DENIED"});
  await dispatcher.execute("log.flush",null,"backend");
} finally { await dispatcher.dispose(); }
const partial = await operations(plugins, process.argv[2], "worker", undefined, catalog.map(plugin=>({...plugin,supportedOperations:plugin.name === "log" ? [] : ["capabilities.get"]})));
try {
  assert.deepEqual(JSON.parse(JSON.stringify(await partial.execute("capabilities.get",null,"backend"))),[{name:"log.write",support:"unsupported"},{name:"log.configure",support:"unsupported"},{name:"log.flush",support:"unsupported"},{name:"capabilities.get",support:"supported"}]);
  await assert.rejects(partial.execute("log.write",{level:"info",message:"unsupported"},"backend"),{code:"UNSUPPORTED"});
} finally { await partial.dispose(); }
console.log("compiled macOS adapters passed");
`,
    );
    const compiled = Bun.spawn(
      [
        process.execPath,
        "build",
        source,
        "--compile",
        `--outfile=${executable}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    const compileOutput = new Response(compiled.stdout).text();
    const compileErrors = new Response(compiled.stderr).text();
    expect(await compiled.exited, await compileErrors).toBe(0);
    await compileOutput;
    // The probe must run from the compiled artifact, with its source removed.
    rmSync(source);
    const child = Bun.spawn(
      [
        executable,
        directory,
      ],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited, await errors).toBe(0);
    expect(await output).toContain("compiled macOS adapters passed");
    const records = (await Bun.file(resolve(directory, "logs/app.log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      source: "backend",
      message: "compiled 한글 😀",
    });
    expect(records).toHaveLength(33);
    expect(records.slice(1).map((record) => record.details.index)).toEqual(
      Array.from(
        {
          length: 32,
        },
        (_, index) => index,
      ),
    );
    expect(
      records.slice(1).every((record) => record.source === "view:main"),
    ).toBe(true);
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
}, 60_000);
