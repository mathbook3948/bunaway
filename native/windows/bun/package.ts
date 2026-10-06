import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { bundleWindowsHost } from "../../../packages/cli/src/assets.ts";
import { files, hash } from "../../../packages/cli/src/files.ts";
import { writeWindowsLauncher } from "../../../packages/cli/src/launch.ts";
import pin from "../../../runtime/build-manifests/windows-x64.json";

// Build the existing real-host regression fixture with the Bun host, without invoking a C++ compiler.
const root = resolve(import.meta.dir, "../../..");
const output = resolve(root, "build/windows-bun-package");
const assets = resolve(output, "assets");
await mkdir(resolve(assets, "web"), { recursive: true });
await mkdir(resolve(output, "runtime"), { recursive: true });
await mkdir(resolve(output, "licenses"), { recursive: true });
for (const name of ["app.json", "policy.json", "bunfig.toml", "tsconfig.json"])
  await cp(resolve(root, "tests/fixtures/desktop/host", name), resolve(assets, name));
for (const file of await files(resolve(root, "tests/fixtures/desktop/host/web"))) {
  const name = relative(resolve(root, "tests/fixtures/desktop/host/web"), file);
  if (!name.endsWith(".js")) {
    await cp(file, resolve(assets, "web", name));
    continue;
  }
  const result = await Bun.build({ entrypoints: [file], target: "browser" });
  assert(result.success && result.outputs[0]);
  await writeFile(
    resolve(assets, "web", name),
    new Uint8Array(await result.outputs[0].arrayBuffer()),
  );
}
await cp(resolve(root, "examples/memo/web/memo.html"), resolve(assets, "web/memo.html"));
const memo = await Bun.build({
  entrypoints: [resolve(root, "examples/memo/web/memo.js")],
  target: "browser",
});
assert(memo.success && memo.outputs[0]);
await writeFile(
  resolve(assets, "web/memo.js"),
  new Uint8Array(await memo.outputs[0].arrayBuffer()),
);
await bundleWindowsHost(
  import.meta.dir,
  assets,
  resolve(root, "tests/fixtures/desktop/host/app.ts"),
);
await cp(
  resolve(root, "runtime/bun-bundle/vendor/bun-windows-x64-baseline/bun.exe"),
  resolve(output, "runtime/bun.exe"),
);
await cp(
  resolve(import.meta.dir, "vendor/sdk/build/native/x64/WebView2Loader.dll"),
  resolve(assets, "WebView2Loader.dll"),
);
await cp(
  resolve(import.meta.dir, "vendor/sdk/LICENSE.txt"),
  resolve(output, "licenses/License-WebView2.txt"),
);
await cp(
  resolve(root, "runtime/bun-bundle/vendor/LICENSE.bun"),
  resolve(output, "licenses/LICENSE.bun"),
);
await writeWindowsLauncher(resolve(import.meta.dir, "launch.ps1"), resolve(output, "launch.ps1"));
const hashes: Record<string, string> = {};
for (const directory of ["assets", "licenses"])
  for (const path of await files(resolve(output, directory)))
    hashes[relative(output, path).replaceAll("\\", "/")] = await hash(path);
await writeFile(
  resolve(output, "manifest.json"),
  JSON.stringify({ ...pin, assets: hashes, host: { kind: "bun-ffi" } }, null, 2),
);
console.log(output);
