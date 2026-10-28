import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OpenRequest } from "@bunaway/plugin-api";
import type { HostContext } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import {
  instanceAddress,
  listenForInstances,
} from "#native/windows/bun/instance";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { deadline } from "../fixtures/deadlines.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import {
  canonicalPath,
  newShellTestName,
  registerShellExtension,
  registerShellScheme,
  shellCommand,
  shellOpen,
} from "../fixtures/windows-shell-registration.ts";

/**
 * Runs the real Windows host, then makes the Windows shell open a registered URL scheme and a
 * registered file type. Each registered command starts a second Bun process that forwards what
 * the shell gave it to the running host, which must report it through onOpen and onOpenUrls.
 */
async function verifyShellActivation(repoDir: string): Promise<void> {
  const dataRoot = resolve(root, `data-${process.pid}`);
  await mkdir(dataRoot, {
    recursive: true,
  });
  const address = instanceAddress(dataRoot);
  const inbox = await listenForInstances(address);
  const forwarder = resolve(
    repoDir,
    "tests/fixtures/windows-shell-forwarder.ts",
  );
  const command = shellCommand(
    process.execPath,
    "--no-env-file",
    forwarder,
    address,
  );
  const scheme = newShellTestName();
  const extension = `.${newShellTestName()}`;
  const file = resolve(root, "folder with space", `note & 100%${extension}`);
  await mkdir(resolve(root, "folder with space"), {
    recursive: true,
  });
  await writeFile(file, "x");
  const url = `${scheme}://open/한글?a=1&b=a%20b`;
  const unregisterScheme = await registerShellScheme(scheme, command);
  const unregisterExtension = await registerShellExtension(extension, command);
  const requests: OpenRequest[] = [];
  const urlLists: string[][] = [];
  let failure: unknown;
  try {
    await runWindowsApp(
      {
        commands: {},
        events: {},
        desktop: {
          closeBehavior: "keep-alive",
          async onReady(desktop) {
            // The shell calls return once the command is started; the host reports the arguments
            // when the forwarded launch arrives.
            try {
              await shellOpen(url, root);
              await shellOpen(file, root);
            } catch (error) {
              failure = error;
              await desktop.quit();
            }
          },
          onOpen(request) {
            requests.push(request);
          },
          async onOpenUrls(urls, desktop) {
            urlLists.push([
              ...urls,
            ]);
            if (urlLists.length === 2) {
              assert.equal(await desktop.quit(), true);
            }
          },
        },
      },
      {
        runtime: {
          id: "shell-activation-test",
          generation: crypto.randomUUID(),
        },
        backendContext: "shell-activation-backend" as HostContext,
        appMetadata: testAppMetadata,
        assets: root,
        dataRoot,
        loader: resolve(
          repoDir,
          "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
        ),
        policy: {
          version: 1,
          backend: {
            permissions: [],
          },
          views: [],
        },
        windows: [],
      },
      {
        argv: [],
        cwd: root,
      },
      inbox,
    );
    if (failure !== undefined) {
      throw failure;
    }
    const second = requests.filter(
      (request) => request.source === "second-instance",
    );
    assert.equal(second.length, 2);
    assert.deepEqual(second[0]?.argv, [
      url,
    ]);
    assert.deepEqual(second[1]?.argv, [
      file,
    ]);
    for (const request of second) {
      assert.equal(canonicalPath(request.cwd), canonicalPath(root));
    }
    // onOpen reports the raw argument; onOpenUrls reports the URL in normalized form and the file
    // as a file URL.
    assert.deepEqual(second[0]?.urls, urlLists[0]);
    assert.equal(new URL(urlLists[0]?.[0] ?? "").protocol, `${scheme}:`);
    assert.deepEqual(second[1]?.files, [
      file,
    ]);
    assert.deepEqual(urlLists[1], [
      pathToFileURL(file, {
        windows: true,
      }).href,
    ]);
    console.log(
      "PASS: the shell starts a registered URL scheme and file association command, and the arguments reach onOpen and onOpenUrls of the running host",
    );
  } finally {
    await unregisterScheme();
    await unregisterExtension();
    await inbox.close();
  }
}

const repo = process.argv.includes("--repo")
  ? process.argv[process.argv.indexOf("--repo") + 1]
  : resolve(import.meta.dir, "../..");
assert(repo);
const root = resolve(repo, "build/windows-shell-activation");
if (!process.argv.includes("--child")) {
  await mkdir(root, {
    recursive: true,
  });
  const entry = await bundleNativeWorker(
    "windows-shell-activation-instance",
    root,
    import.meta.path,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(entry),
      "--child",
      "--repo",
      repo,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: deadline("nativeFixture"),
      killSignal: "SIGKILL",
    },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${output}\n${errors}`);
  console.log(output.trim());
  await rm(root, {
    recursive: true,
    force: true,
  });
} else {
  await verifyShellActivation(repo);
}
