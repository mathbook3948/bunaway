import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
  serializeProcessFrame,
} from "@bunaway/protocol";
import { readJsonLines } from "@bunaway/runtime-bun";
import { bundleIosAssets } from "#cli/assets";
import { validateProject } from "#cli/config";
import {
  assertIosProject,
  isIosSimulatorId,
  publishIosProject,
} from "#cli/ios";
import { main } from "#cli/main";

import { iosFixture } from "./ios-fixture.ts";

test("iOS settings reject unsupported native permissions, multiple views and invalid CLI arguments", async () => {
  const simulator = "81965A44-6B4F-4071-8FA6-B22D38AE00B7";
  expect(isIosSimulatorId(simulator)).toBe(true);
  expect(isIosSimulatorId(`${simulator}\n`)).toBe(false);
  expect(isIosSimulatorId("invalid")).toBe(false);
  const temporary = await mkdtemp(resolve(tmpdir(), "bunaway-ios-settings-"));
  const root = resolve(temporary, "app");
  try {
    await iosFixture(root);
    const project = await validateProject(root);
    assertIosProject(project);
    assertIosProject({
      ...project,
      app: {
        ...project.app,
        appId: "dev.bunaway.123",
      },
    });
    for (const home of [
      "http://app.bunaway.local/",
      "https://app.bunaway.local:444/",
    ]) {
      expect(() =>
        assertIosProject({
          ...project,
          app: {
            ...project.app,
            home,
          },
        }),
      ).toThrow("HTTPS");
    }
    expect(() =>
      assertIosProject({
        ...project,
        policy: {
          ...project.policy,
          backend: {
            permissions: [
              "storage.readText",
            ],
          },
        },
      }),
    ).toThrow("permissions must be empty");
    for (const args of [
      [
        "ios",
        "sync",
        "--device",
        "bad",
      ],
      [
        "ios",
        "run",
      ],
      [
        "ios",
        "build",
        "--device",
        "bad",
      ],
      [
        "ios",
        "run",
        "--device",
        "bad",
      ],
    ]) {
      await expect(main(args)).rejects.toThrow();
    }
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("iOS publication preserves Swift and Xcode edits and refuses unrelated projects or linked managed paths", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "bunaway-ios-sync-"));
  const root = temporary;
  try {
    const first = resolve(root, "stage/first");
    await mkdir(first, {
      recursive: true,
    });
    await writeFile(resolve(first, "value"), "first");
    const native = await publishIosProject(root, first);
    await writeFile(resolve(native, "AppDelegate.swift"), "user Swift");
    await writeFile(
      resolve(native, "Bunaway.xcodeproj/project.pbxproj"),
      "user Xcode",
    );
    const second = resolve(root, "stage/second");
    await mkdir(second);
    await writeFile(resolve(second, "value"), "second");
    await publishIosProject(root, second);
    expect(await readFile(resolve(native, "AppDelegate.swift"), "utf8")).toBe(
      "user Swift",
    );
    expect(
      await readFile(
        resolve(native, "Bunaway.xcodeproj/project.pbxproj"),
        "utf8",
      ),
    ).toBe("user Xcode");
    expect(await readFile(resolve(native, ".bunaway/value"), "utf8")).toBe(
      "second",
    );
    await rm(resolve(native, ".bunaway"), {
      recursive: true,
    });
    await symlink(resolve(root, "stage"), resolve(native, ".bunaway"), "dir");
    await expect(publishIosProject(root, first)).rejects.toThrow(
      "without links",
    );
    await rm(native, {
      recursive: true,
    });
    await mkdir(native);
    await expect(publishIosProject(root, first)).rejects.toThrow(
      "refusing to overwrite",
    );
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
    });
  }
});

test("iOS bundled entry survives three backend Worker generations and preserves app contracts and file imports", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "bunaway-ios-worker-"));
  const root = resolve(temporary, "app");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await iosFixture(root);
    const assets = resolve(root, "assets");
    await bundleIosAssets(await validateProject(root), assets);
    child = Bun.spawn(
      [
        process.execPath,
        resolve(assets, "backend/entry.js"),
        "0",
        "1",
      ],
      {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (
      !child.stdin ||
      typeof child.stdin === "number" ||
      !child.stdout ||
      typeof child.stdout === "number"
    ) {
      throw new Error("Missing fixture pipes.");
    }
    const input = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const lines = readJsonLines(
      (async function* () {
        for await (const chunk of stdout) {
          yield chunk;
        }
      })(),
    );
    const next = async () => {
      const line = await lines.next();
      if (line.done) {
        throw new Error(
          typeof stderr === "number"
            ? "Fixture stderr unavailable."
            : await new Response(stderr).text(),
        );
      }
      return JSON.parse(line.value);
    };
    const policy = JSON.parse(
      await readFile(resolve(root, "src-bunaway/policy.json"), "utf8"),
    );
    for (let generation = 1; generation <= 3; generation++) {
      const runtime = {
        id: "ios-worker-test",
        generation: String(generation),
      };
      const send = (body: object) =>
        input.write(
          `${JSON.stringify({
            ...body,
            ipc: PROCESS_IPC_VERSION,
            runtime,
          })}\n`,
        );
      send({
        kind: "boot",
        payload: {
          entrypoint: resolve(assets, "backend/backend.js"),
          policy,
          buildId: "fixture",
          backendContext: "backend",
        },
      });
      expect((await next()).kind).toBe("hello");
      send({
        kind: "hello",
        payload: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          features: [],
          buildId: "fixture",
        },
      });
      expect((await next()).kind).toBe("ready");
      send({
        kind: "session-open",
        context: "main-context",
        viewId: "main",
      });
      send({
        kind: "web",
        context: "main-context",
        payload: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          features: [],
          buildId: "fixture",
        },
      });
      expect((await next()).payload.kind).toBe("hello");
      for (const [command, payload] of [
        [
          "test.count",
          null,
        ],
        [
          "test.files",
          null,
        ],
        [
          "test.echo",
          "한글 😀",
        ],
      ] as const) {
        send({
          kind: "web",
          context: "main-context",
          payload: {
            kind: "invoke",
            protocol: PROTOCOL_VERSION,
            id: command,
            command,
            payload,
          },
        });
        const response = (await next()).payload;
        expect(response.kind).toBe("result");
        expect(response.payload).toEqual(
          {
            "test.count": 1,
            "test.files": "iOS backend 한글 😀\n",
            "test.echo": "한글 😀",
          }[command],
        );
      }
      // The embedded Worker uses the packaged WebKit origin while the policy remains HTTPS.
      send({
        kind: "session-open",
        context: "direct-context",
        viewId: "main",
      });
      send({
        kind: "channel-open",
        context: "direct-context",
        nonce: "document",
        origin: "https://app.bunaway.local",
      });
      const grant = await next();
      expect(grant.kind).toBe("channel-ready");
      expect(
        (
          await fetch(grant.url.replace("ws:", "http:"), {
            headers: {
              Origin: "https://app.bunaway.local",
            },
          })
        ).status,
      ).toBe(403);
      const socket = new WebSocket(grant.url, {
        headers: {
          Origin: "bunaway://app.bunaway.local",
        },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () =>
            reject(new Error("iOS direct connection rejected"));
        });
        const reply = new Promise<string>((resolve) => {
          socket.onmessage = (event) => resolve(String(event.data));
        });
        socket.send(
          JSON.stringify({
            kind: "hello",
            protocol: PROTOCOL_VERSION,
            features: [],
            buildId: "fixture",
          }),
        );
        expect(JSON.parse(await reply).kind).toBe("hello");
        const closed = new Promise<void>((resolve) => {
          socket.onclose = () => resolve();
        });
        send({
          kind: "revoke",
          context: "direct-context",
        });
        await closed;
      } finally {
        socket.close();
      }
      input.write(
        `${serializeProcessFrame({
          kind: "shutdown",
          ipc: PROCESS_IPC_VERSION,
          runtime,
        })}\n`,
      );
      expect((await next()).kind).toBe("stopping");
      expect(child.exitCode).toBeNull();
    }
  } finally {
    child?.kill();
    await child?.exited;
    await rm(temporary, {
      recursive: true,
      force: true,
    });
  }
}, 15000);
