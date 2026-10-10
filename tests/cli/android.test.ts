import { expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { acquireBuildOutputLock } from "@bunaway/packaging";
import { outputPaths } from "@bunaway/packaging/paths";
import { PROTOCOL_VERSION } from "@bunaway/protocol";
import { readJsonLines } from "@bunaway/runtime-bun";
import {
  assertAndroidProject,
  isAndroidSerial,
  launchAndroidActivity,
  publishAndroidProject,
  readAndroidApplicationId,
  runAndroidProject,
} from "#cli/android";
import { validateProject } from "#cli/config";
import { frameworkRoot } from "#cli/files";
import { main } from "#cli/main";
import { run, runWorker } from "#cli/processes";
import { createProject } from "./project.ts";

const project = {
  app: {
    appId: "dev.bunaway.test",
    title: "Test",
    view: "main",
    home: "https://app.bunaway.local/index.html",
    window: {
      width: 800,
      height: 600,
    },
  },
  policy: {
    version: 1 as const,
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [],
        events: [],
        host: {
          permissions: [],
        },
      },
    ],
    backend: {
      permissions: [],
    },
  },
};

test("installed Android assets Worker preserves backend file imports through extraction and IPC execution", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-worker-"));
  try {
    const app = await createProject(resolve(root, "app"));
    await run(
      [
        process.execPath,
        "install",
        "--ignore-scripts",
      ],
      app,
    );
    const text = "Android backend 한글 😀";
    const binary = Buffer.from([
      0,
      128,
      255,
    ]);
    const raw = "not valid JavaScript!";
    for (const [name, content] of [
      [
        "data.txt",
        text,
      ],
      [
        "data.bin",
        binary,
      ],
      [
        "raw.js",
        raw,
      ],
    ] as const) {
      await Bun.write(resolve(app, "src-bunaway", name), content);
    }
    await Bun.write(
      resolve(app, "src-bunaway/app.ts"),
      `import { command, defineApp } from "@bunaway/backend";
import text from "./data.txt" with { type: "file" };
import binary from "./data.bin" with { type: "file" };
import raw from "./raw.js" with { type: "file" };
export default defineApp({ modules: [], commands: {
  "test.files": command({ input: {}, output: { type: "array", items: { type: "string" } },
    handle: () => Promise.all([text, binary, raw].map(async file =>
      Buffer.from(await Bun.file(new URL(file, import.meta.url)).arrayBuffer()).toString("hex")))
  })
} });`,
    );
    const policy = {
      ...project.policy,
      views: project.policy.views.map((view) => ({
        ...view,
        commands: [
          "test.files",
        ],
      })),
    };
    await Bun.write(
      resolve(app, "src-bunaway/policy.json"),
      JSON.stringify(policy),
    );
    const validated = await validateProject(app);
    assertAndroidProject(validated);
    const assets = resolve(root, "assets");
    await runWorker(
      "assets.ts",
      "bundleAndroidAssets",
      [
        validated,
        assets,
      ],
      app,
      validated.frameworkRoot,
    );
    expect(await Bun.file(resolve(assets, "web/index.html")).exists()).toBe(
      true,
    );
    expect(await Bun.file(resolve(assets, "web/main.js")).exists()).toBe(true);
    const runtime = resolve(root, "runtime");
    await cp(resolve(assets, "backend"), runtime, {
      recursive: true,
    });
    const backend = resolve(runtime, "backend.js");
    // Extract the APK's backend tree and remove sources to exercise relative file imports.
    await rm(assets, {
      recursive: true,
    });
    await rm(resolve(app, "src-bunaway"), {
      recursive: true,
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        backend,
      ],
      {
        cwd: runtime,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill(), 5000);
    const errors = new Response(child.stderr).text();
    const output = readJsonLines(child.stdout)[Symbol.asyncIterator]();
    const send = (body: Record<string, unknown>) =>
      child.stdin.write(
        `${JSON.stringify({
          ...body,
          ipc: PROTOCOL_VERSION,
          runtime: {
            id: "android-worker-test",
            generation: "1",
          },
        })}\n`,
      );
    const next = async () => JSON.parse((await output.next()).value ?? "");
    try {
      send({
        kind: "boot",
        payload: {
          entrypoint: backend,
          buildId: "test",
          backendContext: "backend-test",
          policy,
        },
      });
      expect(await next()).toMatchObject({
        kind: "hello",
      });
      send({
        kind: "hello",
        payload: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          features: [],
          buildId: "test",
        },
      });
      expect(await next()).toMatchObject({
        kind: "ready",
      });
      send({
        kind: "session-open",
        context: "view-test",
        viewId: "main",
      });
      send({
        kind: "web",
        context: "view-test",
        payload: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          features: [],
          buildId: "test",
        },
      });
      expect(await next()).toMatchObject({
        kind: "web",
        payload: {
          kind: "hello",
        },
      });
      send({
        kind: "web",
        context: "view-test",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: "files",
          command: "test.files",
          payload: null,
        },
      });
      expect(await next()).toMatchObject({
        kind: "web",
        context: "view-test",
        payload: {
          kind: "result",
          id: "files",
          payload: [
            Buffer.from(text).toString("hex"),
            binary.toString("hex"),
            Buffer.from(raw).toString("hex"),
          ],
        },
      });
      send({
        kind: "shutdown",
      });
      child.stdin.end();
      expect(await next()).toMatchObject({
        kind: "stopping",
      });
      expect(await child.exited, await errors).toBe(0);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

test("Android accepts the common app model and rejects unsupported native inputs before building", () => {
  expect(() => assertAndroidProject(project)).not.toThrow();
  expect(() =>
    assertAndroidProject({
      ...project,
      app: {
        ...project.app,
        home: "http://127.0.0.1:5173/",
      },
    }),
  ).toThrow("packaged HTTPS");
  expect(() =>
    assertAndroidProject({
      ...project,
      app: {
        ...project.app,
        appId: "test-id",
      },
    }),
  ).toThrow("package segments");
  expect(() =>
    assertAndroidProject({
      ...project,
      policy: {
        ...project.policy,
        backend: {
          permissions: [
            "storage:read-text",
          ],
        },
      },
    }),
  ).toThrow("permissions must be empty");
  expect(() =>
    assertAndroidProject({
      ...project,
      app: {
        ...project.app,
        windows: [],
      },
    }),
  ).toThrow("one app.view");
});

test("Android APK identity comes from validated Gradle output, including native debug suffixes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-identity-"));
  const directory = resolve(root, "outputs/apk/debug");
  try {
    await mkdir(directory, {
      recursive: true,
    });
    for (const applicationId of [
      "dev.bunaway.test",
      "dev.bunaway.test.debug",
    ]) {
      await writeFile(
        resolve(directory, "output-metadata.json"),
        JSON.stringify({
          applicationId,
        }),
      );
      expect(await readAndroidApplicationId(root)).toBe(applicationId);
    }
    for (const value of [
      null,
      {},
      {
        applicationId: 1,
      },
      {
        applicationId: "../app",
      },
      {
        applicationId: "dev.bunaway.test\n",
      },
    ]) {
      await writeFile(
        resolve(directory, "output-metadata.json"),
        JSON.stringify(value),
      );
      await expect(readAndroidApplicationId(root)).rejects.toThrow(
        "Invalid Android APK application ID",
      );
    }
    await writeFile(resolve(directory, "output-metadata.json"), "{");
    await expect(readAndroidApplicationId(root)).rejects.toThrow(
      "Cannot read JSON",
    );
    await rm(resolve(directory, "output-metadata.json"));
    await expect(readAndroidApplicationId(root)).rejects.toThrow(
      "Cannot read JSON",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test.skipIf(process.platform !== "win32").each([
  "success",
  "install-failure",
  "launch-failure",
  "cancel",
])(
  "Android run keeps its output locked through ADB and releases it after %s",
  async (mode) => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-run-"));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "android-build.fixture.ts"),
          root,
          mode,
        ],
        {
          cwd: frameworkRoot,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${output}\n${errors}`).toBe(0);
      expect(output).toContain(
        "PASS: final APK identity and owned ADB lifecycle",
      );
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  15000,
);

test("Android CLI rejects missing serial and unsupported options before reading a project", async () => {
  for (const args of [
    [
      "run",
    ],
    [
      "build",
      "--serial",
      "emulator-5554",
    ],
    [
      "run",
      "--serial",
      "../device",
    ],
    [
      "run",
      "--serial",
      "a",
      "--serial",
      "b",
    ],
    [
      "dev",
    ],
    [
      "build",
      "one",
      "two",
    ],
    [
      "sync",
      "--serial",
      "emulator-5554",
    ],
    [
      "sync",
      "one",
      "two",
    ],
  ]) {
    await expect(
      main([
        "android",
        ...args,
      ]),
    ).rejects.toThrow("Usage: bunaway android");
  }
});

test("Android device validation is shared and rejects malformed serials before project access", async () => {
  for (const serial of [
    "emulator-5554",
    "192.168.1.3:5555",
    "device_1",
  ]) {
    expect(isAndroidSerial(serial)).toBe(true);
  }
  for (const serial of [
    "",
    "../device",
    "device\0",
    "device\n",
    "device serial",
  ]) {
    expect(isAndroidSerial(serial)).toBe(false);
    await expect(runAndroidProject("missing-project", serial)).rejects.toThrow(
      "Invalid Android device serial",
    );
    await expect(
      main([
        "android",
        "run",
        "--serial",
        serial,
      ]),
    ).rejects.toThrow("Usage: bunaway android");
  }
});

test("Android sync creates a Java project and replaces generated files without touching native customizations", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-sync-"));
  async function prepared(name: string): Promise<string> {
    const directory = resolve(root, "work", name, "managed");
    await mkdir(directory, {
      recursive: true,
    });
    await writeFile(resolve(directory, `${name}.txt`), name);
    return directory;
  }
  try {
    const directory = await publishAndroidProject(
      root,
      await prepared("first"),
      frameworkRoot,
    );
    expect(directory).toBe(resolve(root, "android"));
    expect(
      await Bun.file(resolve(directory, "bunaway-project.json")).json(),
    ).toEqual({
      format: 1,
    });
    expect(await readFile(resolve(directory, "app/build.gradle"), "utf8")).toBe(
      "apply from: rootProject.file('.bunaway/app.gradle')\n",
    );
    const settings = await readFile(
      resolve(directory, "settings.gradle"),
      "utf8",
    );
    expect(settings).toContain("apply from: file('.bunaway/settings.gradle')");
    expect(settings).not.toContain(".bunaway/host");
    const activity = resolve(
      directory,
      "app/src/main/java/dev/bunaway/app/MainActivity.java",
    );
    expect(await readFile(activity, "utf8")).toContain(
      "extends BunawayActivity",
    );
    const customizations = [
      [
        activity,
        "app-owned Java",
      ],
      [
        resolve(directory, "app/src/main/AndroidManifest.xml"),
        "app-owned manifest",
      ],
      [
        resolve(directory, "app/build.gradle"),
        "app-owned dependencies",
      ],
      [
        resolve(directory, "settings.gradle"),
        "app-owned modules",
      ],
      [
        resolve(directory, "gradle/wrapper/gradle-wrapper.properties"),
        "app-owned wrapper",
      ],
      [
        resolve(directory, "local.properties"),
        "app-owned SDK path",
      ],
    ] as const;
    for (const [path, content] of customizations) {
      await writeFile(path, content);
    }
    await publishAndroidProject(root, await prepared("second"), frameworkRoot);
    for (const [path, content] of customizations) {
      expect(await readFile(path, "utf8")).toBe(content);
    }
    expect(
      await readFile(resolve(directory, ".bunaway/second.txt"), "utf8"),
    ).toBe("second");
    expect(
      await Bun.file(resolve(directory, ".bunaway/first.txt")).exists(),
    ).toBe(false);
    await expect(
      publishAndroidProject(root, resolve(root, "missing"), frameworkRoot),
    ).rejects.toThrow();
    expect(
      await readFile(resolve(directory, ".bunaway/second.txt"), "utf8"),
    ).toBe("second");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("Android sync rejects unrelated projects and linked generated directories", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-existing-"));
  const outside = await mkdtemp(resolve(tmpdir(), "bunaway-android-outside-"));
  try {
    const android = resolve(root, "android");
    const prepared = resolve(root, "prepared");
    await mkdir(android);
    await mkdir(prepared);
    await writeFile(resolve(android, "keep.java"), "unrelated Java project");
    await expect(publishAndroidProject(root, prepared)).rejects.toThrow(
      "refusing to overwrite",
    );
    expect(await readFile(resolve(android, "keep.java"), "utf8")).toBe(
      "unrelated Java project",
    );
    await writeFile(resolve(android, "bunaway-project.json"), '{"format":2}');
    await expect(publishAndroidProject(root, prepared)).rejects.toThrow(
      "Unsupported Android project format",
    );
    await writeFile(resolve(android, "bunaway-project.json"), '{"format":1}');
    await writeFile(resolve(outside, "keep.txt"), "outside data");
    await symlink(
      outside,
      resolve(android, ".bunaway"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(publishAndroidProject(root, prepared)).rejects.toThrow(
      "without links",
    );
    expect(await readFile(resolve(outside, "keep.txt"), "utf8")).toBe(
      "outside data",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
    await rm(outside, {
      recursive: true,
      force: true,
    });
  }
});

test("Android builds share the target lock and reserve a separate output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-lock-"));
  try {
    const release = await acquireBuildOutputLock(root, "android");
    try {
      await expect(acquireBuildOutputLock(root, "android")).rejects.toThrow(
        "locked",
      );
    } finally {
      await release();
    }
    expect(outputPaths(root, "android").output).toBe(
      resolve(root, "dist/android"),
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("Android run resolves an app-owned launcher and rejects ADB launch errors even with exit zero", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-launcher-"));
  try {
    const fixture = resolve(root, "adb.ts");
    await writeFile(
      fixture,
      `
const mode = process.argv[2];
const args = process.argv.slice(3);
if (args.includes("resolve-activity")) {
  console.log(mode === "missing" ? "No activity found" : "priority=0\\ndev.bunaway.test/com.example.CustomActivity");
} else {
  if (args.at(-1) !== "dev.bunaway.test/com.example.CustomActivity") process.exit(2);
  console.log(mode === "failure" ? "Error: Activity not started" : "Status: ok");
}
`,
    );
    await launchAndroidActivity(
      [
        process.execPath,
        fixture,
        "success",
      ],
      root,
      "dev.bunaway.test",
    );
    await expect(
      launchAndroidActivity(
        [
          process.execPath,
          fixture,
          "missing",
        ],
        root,
        "dev.bunaway.test",
      ),
    ).rejects.toThrow("no resolvable launcher");
    await expect(
      launchAndroidActivity(
        [
          process.execPath,
          fixture,
          "failure",
        ],
        root,
        "dev.bunaway.test",
      ),
    ).rejects.toThrow("Activity not started");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
