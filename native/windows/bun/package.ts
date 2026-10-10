import assert from "node:assert/strict";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { bundleWindowsHost } from "#cli/assets";
import { files, hash, json, writeJson } from "#cli/files";
import { compileWindowsApp } from "#cli/windows-compile";
import pin from "../../../runtime/build-manifests/windows-x64.json";

const root = resolve(import.meta.dir, "../../..");

/** Build the real-host fixture and replace the requested output directory without a C++ compiler. */
export async function buildHostFixture(
  output = resolve(root, "build/windows-bun-package"),
  config?: Record<string, unknown>,
) {
  assert(
    output.startsWith(resolve(root, "build") + sep),
    "Fixture output must stay inside build/",
  );

  const assets = resolve(output, "assets");
  await rm(output, {
    recursive: true,
    force: true,
  });
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await mkdir(resolve(output, "licenses"), {
    recursive: true,
  });
  for (const name of [
    "bunfig.toml",
    "tsconfig.json",
  ]) {
    await cp(
      resolve(root, "tests/fixtures/desktop/host", name),
      resolve(assets, name),
    );
  }
  const app =
    config ??
    (await json(resolve(root, "tests/fixtures/desktop/host/app.json")));
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app,
    policy: await json(
      resolve(root, "tests/fixtures/desktop/host/policy.json"),
    ),
    plugins: [],
    developmentSdk: {},
  });
  for (const file of await files(
    resolve(root, "tests/fixtures/desktop/host/web"),
  )) {
    const name = relative(
      resolve(root, "tests/fixtures/desktop/host/web"),
      file,
    );
    if (!name.endsWith(".js")) {
      await cp(file, resolve(assets, "web", name));
      continue;
    }
    const result = await Bun.build({
      entrypoints: [
        file,
      ],
      target: "browser",
    });
    assert(result.success && result.outputs[0]);
    await writeFile(
      resolve(assets, "web", name),
      new Uint8Array(await result.outputs[0].arrayBuffer()),
    );
  }
  const bundledAssets = await bundleWindowsHost(
    import.meta.dir,
    assets,
    resolve(root, "tests/fixtures/desktop/host/app.ts"),
  );
  await cp(
    resolve(
      root,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    resolve(output, "WebView2Loader.dll"),
  );
  await cp(
    resolve(root, "build/cache/webview2/sdk/LICENSE.txt"),
    resolve(output, "licenses/License-WebView2.txt"),
  );
  await cp(
    resolve(root, "build/cache/bun/LICENSE.bun"),
    resolve(output, "licenses/LICENSE.bun"),
  );
  assert(
    app &&
      typeof app === "object" &&
      "appId" in app &&
      "title" in app &&
      typeof app.title === "string",
  );
  const executableName = `${app.appId}.exe`;
  await compileWindowsApp(
    output,
    resolve(root, "build/cache/bun/bun-windows-x64-baseline/bun.exe"),
    executableName,
    {
      title: app.title,
      ...(typeof Reflect.get(app, "icon") === "string"
        ? {
            icon: String(Reflect.get(app, "icon")),
          }
        : {}),
    },
    bundledAssets,
  );
  const hashes: Record<string, string> = {};
  hashes["WebView2Loader.dll"] = await hash(
    resolve(output, "WebView2Loader.dll"),
  );
  for (const directory of [
    "licenses",
  ]) {
    for (const path of await files(resolve(output, directory))) {
      hashes[relative(output, path).replaceAll("\\", "/")] = await hash(path);
    }
  }
  await writeFile(
    resolve(output, "manifest.json"),
    JSON.stringify(
      {
        ...pin,
        assets: hashes,
        host: {
          target: "windows-x64",
          kind: "bun-compiled",
          executable: executableName,
          sha256: await hash(resolve(output, executableName)),
        },
      },
      null,
      2,
    ),
  );
  return output;
}
if (import.meta.main) {
  console.log(await buildHostFixture());
}
