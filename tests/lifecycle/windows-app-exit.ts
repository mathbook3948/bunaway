import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDefinition } from "@bunaway/core";
import type { HostContext } from "@bunaway/protocol";
import { relaunchHost } from "#native/windows/bun/boot";
import { runWindowsApp } from "#native/windows/bun/entry";
import {
  instanceAddress,
  listenForInstances,
} from "#native/windows/bun/instance";
import {
  containAppProcess,
  containAppProcessAfterRelaunch,
} from "#native/windows/bun/job";
import { RELAUNCH_ENVIRONMENT } from "#native/windows/bun/relaunch";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

/**
 * Real-process checks of `DesktopContext.quit({ exitCode })`, `exit()` and `relaunch()` through the
 * Windows host. Each scenario runs in its own child process because one process is not known to
 * support two sequential host runs, and because the process exit code and the new process started
 * by `relaunch()` are the behavior under test. The child repeats the sequence of `boot.ts`: claim
 * the data directory, run the app, then apply the exit code and the relaunch.
 */
const SCENARIO = "BUNAWAY_EXIT_TEST_SCENARIO";
const DIRECTORY = "BUNAWAY_EXIT_TEST_DIRECTORY";
const REPOSITORY = "BUNAWAY_EXIT_TEST_REPOSITORY";
const RELAUNCH_TIMEOUT_MS = 40_000;

type Scenario = "quit-code" | "veto" | "exit" | "relaunch" | "relaunch-default";

const childScenario = process.env[SCENARIO] as Scenario | undefined;

if (!childScenario) {
  await runParent();
} else {
  await runChild(childScenario);
}

async function runParent(): Promise<void> {
  const repository = resolve(import.meta.dir, "../..");
  const root = resolve(repository, "build/windows-app-exit");
  await rm(root, {
    recursive: true,
    force: true,
  });
  await mkdir(root, {
    recursive: true,
  });
  const entry = fileURLToPath(
    await bundleNativeWorker("windows-app-exit", root, import.meta.path),
  );
  const run = async (scenario: Scenario, ...args: string[]) => {
    const directory = resolve(root, scenario);
    await mkdir(directory, {
      recursive: true,
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entry,
        ...args,
      ],
      {
        env: {
          ...process.env,
          [SCENARIO]: scenario,
          [DIRECTORY]: directory,
          [REPOSITORY]: repository,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      directory,
      output: `${output}\n${errors}`,
      code,
    };
  };
  const events = async (directory: string) =>
    (await readFile(resolve(directory, "events.txt"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);

  const quit = await run("quit-code");
  assert.equal(quit.code, 7, quit.output);
  assert.deepEqual(await events(quit.directory), [
    "beforeQuit",
    "onWillQuit",
    "onQuit",
  ]);

  const vetoed = await run("veto");
  assert.equal(vetoed.code, 0, vetoed.output);
  assert.deepEqual(await events(vetoed.directory), [
    "beforeQuit:veto",
    "beforeQuit",
    "onWillQuit",
    "onQuit",
  ]);

  const exited = await run("exit");
  assert.equal(exited.code, 9, exited.output);
  assert.deepEqual(await events(exited.directory), []);

  for (const [scenario, expectedArgv] of [
    [
      "relaunch",
      [
        "--again",
        "x y",
        'q"uote',
      ],
    ],
    [
      "relaunch-default",
      [
        "initial",
        "two words",
      ],
    ],
  ] as const) {
    const relaunched = await run(
      scenario,
      ...(scenario === "relaunch-default" ? expectedArgv : []),
    );
    assert.equal(relaunched.code, 4, relaunched.output);
    // The new process is not a child of this test: it outlives the old host and reports in a file.
    const report = resolve(relaunched.directory, "relaunched.json");
    const deadline = Date.now() + RELAUNCH_TIMEOUT_MS;
    while (!(await Bun.file(report).exists())) {
      assert(Date.now() < deadline, `${scenario}: relaunched host never ran`);
      await Bun.sleep(100);
    }
    const reported = JSON.parse(await readFile(report, "utf8"));
    assert.deepEqual(reported.argv, expectedArgv, scenario);
    assert.equal(reported.source, "initial", scenario);
    // The new host keeps the working directory the old one had at boot.
    assert.equal(reported.cwd.toLowerCase(), process.cwd().toLowerCase());
    // The old host ran its whole hook sequence before the new one started.
    assert.deepEqual(
      (await events(relaunched.directory)).filter(
        (event) => !event.startsWith("relaunched-"),
      ),
      [
        "beforeQuit",
        "onWillQuit",
        "onQuit",
      ],
    );
  }
  await rm(root, {
    recursive: true,
    force: true,
  });
  console.log(
    "PASS: quit exit codes, exit hook skipping and relaunch with argv and the app lock through the real Windows host",
  );
}

async function runChild(scenario: Scenario): Promise<void> {
  const directory = process.env[DIRECTORY];
  const repository = process.env[REPOSITORY];
  assert(directory && repository);
  const relaunched = process.env[RELAUNCH_ENVIRONMENT] === "1";
  delete process.env[RELAUNCH_ENVIRONMENT];
  const record = (event: string) =>
    appendFile(resolve(directory, "events.txt"), `${event}\n`);
  let vetoPending = scenario === "veto";
  const app: AppDefinition = {
    commands: {},
    events: {},
    desktop: {
      closeBehavior: "keep-alive",
      beforeQuit: async () => {
        if (vetoPending) {
          vetoPending = false;
          await record("beforeQuit:veto");
          return false;
        }
        await record("beforeQuit");
      },
      onWillQuit: () => record("onWillQuit"),
      onQuit: () => record("onQuit"),
      async onReady(desktop) {
        if (relaunched) {
          // The report is written by onOpen, which runs after this callback.
          await record("relaunched-onReady");
          return;
        }
        if (scenario === "quit-code") {
          assert.equal(
            await desktop.quit({
              exitCode: 7,
            }),
            true,
          );
        } else if (scenario === "veto") {
          // The veto discards exit code 5; the second quit commits the default code.
          assert.equal(
            await desktop.quit({
              exitCode: 5,
            }),
            false,
          );
          assert.equal(await desktop.quit(), true);
        } else if (scenario === "exit") {
          await desktop.exit(9);
        } else if (scenario === "relaunch") {
          assert.equal(
            await desktop.relaunch({
              argv: [
                "--again",
                "x y",
                'q"uote',
              ],
              exitCode: 4,
            }),
            true,
          );
        } else {
          assert.equal(
            await desktop.relaunch({
              exitCode: 4,
            }),
            true,
          );
        }
      },
      async onOpen(request, desktop) {
        if (relaunched) {
          // Reaching this point means the new host took the app lock and received the arguments.
          const temporary = resolve(directory, "relaunched.json.tmp");
          await Bun.write(
            temporary,
            JSON.stringify({
              argv: request.argv,
              source: request.source,
              cwd: process.cwd(),
            }),
          );
          await rename(temporary, resolve(directory, "relaunched.json"));
          await desktop.exit();
        }
      },
    },
  };
  // A relaunched host waits for its predecessor to release the lock, as boot.ts does.
  if (relaunched) {
    await containAppProcessAfterRelaunch(directory);
  } else {
    containAppProcess(directory);
  }
  const launch = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
  };
  const inbox = await listenForInstances(instanceAddress(directory));
  let result: Awaited<ReturnType<typeof runWindowsApp>>;
  try {
    result = await runWindowsApp(
      app,
      {
        appMetadata: testAppMetadata,
        runtime: {
          id: "app-exit-test",
          generation: crypto.randomUUID(),
        },
        backendContext: "app-exit-backend" as HostContext,
        assets: directory,
        dataRoot: directory,
        loader: resolve(
          repository,
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
      launch,
      inbox,
    );
  } finally {
    await inbox.close().catch(() => {});
  }
  if (result.relaunch) {
    await relaunchHost(result.relaunch.argv, {
      dataRoot: directory,
      cliManaged: false,
      host: {
        compiled: false,
        execPath: process.execPath,
        execArgv: [
          "--no-env-file",
        ],
        script: process.argv[1],
        switches: [],
        cwd: launch.cwd,
        env: process.env,
      },
    });
  }
  process.exit(result.exitCode);
}
