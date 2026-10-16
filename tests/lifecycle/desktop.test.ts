import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { defineApp } from "@bunaway/backend";
import { defineCLI } from "@bunaway/backend/cli";
import type { DesktopOptions, OpenRequest } from "@bunaway/core";
import {
  AUTOSTART_ARGUMENT,
  AUTOSTART_HIDDEN_ARGUMENT,
} from "@bunaway/protocol";
import type { WindowSpec } from "@bunaway/runtime-bun/window-config";
import { z } from "zod";
import { validatePacket } from "#native/windows/bun/channel";
import {
  DesktopLifecycle,
  desktopLaunch,
  openRequest,
  validateDesktopStartup,
  WILL_QUIT_DEADLINE_MS,
} from "#native/windows/bun/desktop";
import {
  forwardToInstance,
  listenForInstances,
  parseLaunchArguments,
} from "#native/windows/bun/instance";

test("windowless startup requires a tray or explicit keep-alive, even with open and quit hooks", () => {
  const deferred: WindowSpec[] = [
    {
      view: "main",
      title: "Main",
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
      },
      startup: false,
    },
  ];
  for (const windows of [
    [],
    deferred,
  ]) {
    for (const options of [
      undefined,
      {},
      {
        beforeQuit: () => false,
      },
      {
        onOpen: () => {},
      },
    ]) {
      expect(() => validateDesktopStartup(windows, options)).toThrow(
        "desktop.tray or desktop.closeBehavior: keep-alive",
      );
    }
    for (const options of [
      {
        closeBehavior: "keep-alive",
      },
      {
        tray: {
          tooltip: "Resident",
        },
      },
      {
        closeBehavior: "hide",
        tray: {
          tooltip: "Resident",
        },
      },
    ] satisfies DesktopOptions[]) {
      expect(() => validateDesktopStartup(windows, options)).not.toThrow();
    }
  }
  expect(() =>
    validateDesktopStartup(
      deferred.map((spec) => ({
        ...spec,
        startup: true,
      })),
      undefined,
    ),
  ).not.toThrow();
});

test("startup rejects malformed tray Unicode while accepting complete emoji at the WCHAR boundary", () => {
  for (const tooltip of [
    "😀".slice(0, 1),
    "😀".slice(1),
    "prefix\ud800suffix",
    "prefix\udfffsuffix",
    "a\0b",
  ]) {
    expect(
      () =>
        new DesktopLifecycle(
          {
            tray: {
              tooltip,
            },
          },
          async () => {},
          () => {},
          () => {},
        ),
    ).toThrow("Invalid desktop.tray.tooltip");
  }
  const tooltip = `${"😀".repeat(63)}x`;
  expect(tooltip.length).toBe(127);
  const lifecycle = new DesktopLifecycle(
    {
      tray: {
        tooltip,
      },
    },
    async () => {},
    () => {},
    () => {},
  );
  expect(lifecycle.options?.tray?.tooltip).toBe(tooltip);
  expect(() => validateDesktopStartup([], lifecycle.options)).not.toThrow();
});

test("keep-alive preserves explicit quit checks and diagnoses invalid desktop settings", async () => {
  for (const options of [
    null,
    [],
    false,
  ]) {
    // App definitions loaded at runtime may not have passed a TypeScript check.
    expect(
      () =>
        new DesktopLifecycle(
          options as unknown as DesktopOptions,
          async () => {},
          () => {},
          () => {},
        ),
    ).toThrow("desktop must be an options object");
  }
  let stops = 0;
  const lifecycle = new DesktopLifecycle(
    {
      closeBehavior: "keep-alive",
      beforeQuit: () => false,
    },
    async () => {},
    () => {
      stops++;
    },
    () => {},
  );
  expect(await lifecycle.context.quit()).toBe(false);
  expect(stops).toBe(0);
  for (const options of [
    {
      closeBehavior: "resident",
    },
    {
      tray: {
        tooltip: 42,
      },
    },
    {
      tray: {
        tooltip: "",
      },
    },
    {
      tray: null,
    },
    {
      tray: [],
    },
    {
      onOpen: true,
    },
    {
      beforeQuit: false,
    },
    {
      openArguments: "unknown",
    },
    {
      openArguments: false,
    },
  ]) {
    // Exercise untyped app definitions at the runtime boundary.
    expect(
      () =>
        new DesktopLifecycle(
          options as unknown as DesktopOptions,
          async () => {},
          () => {},
          () => {},
        ),
    ).toThrow("desktop.");
  }
});

const launch = {
  argv: [
    "메모 파일.txt",
    "memo://open/42",
    "--flag",
  ],
  cwd: "C:\\사용자\\문서",
};
// Advance one timer turn so queued lifecycle callbacks settle deterministically.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("open requests preserve arguments and resolve files using the launching directory", () => {
  const request = openRequest(
    {
      ...launch,
      argv: [
        ...launch.argv,
        "file:///C:/notes/a%20b.txt",
        "file://server/share/note.txt",
        "--",
        "-draft.txt",
      ],
    },
    "second-instance",
  );
  expect(request.argv).toEqual([
    ...launch.argv,
    "file:///C:/notes/a%20b.txt",
    "file://server/share/note.txt",
    "--",
    "-draft.txt",
  ]);
  expect(request.urls).toEqual([
    "memo://open/42",
  ]);
  expect(request.files).toEqual([
    "C:\\사용자\\문서\\메모 파일.txt",
    "C:\\notes\\a b.txt",
    "\\\\server\\share\\note.txt",
    "C:\\사용자\\문서\\-draft.txt",
  ]);
  expect(Object.isFrozen(request.argv)).toBe(true);
});

test("only the leading registration marker supplies launch metadata and hidden startup requires a tray", () => {
  expect(
    desktopLaunch([
      AUTOSTART_HIDDEN_ARGUMENT,
      "file.txt",
    ]),
  ).toEqual({
    launchReason: "autostart",
    hidden: true,
    argv: [
      "file.txt",
    ],
  });
  const input = {
    argv: [
      AUTOSTART_ARGUMENT,
      AUTOSTART_HIDDEN_ARGUMENT,
      "notes.txt",
    ],
    cwd: "C:\\notes",
  };
  for (const source of [
    "initial",
    "second-instance",
  ] as const) {
    const request = openRequest(input, source);
    expect(request.launchReason).toBe("autostart");
    expect(request.argv).toEqual([
      AUTOSTART_HIDDEN_ARGUMENT,
      "notes.txt",
    ]);
    expect(request.files).toEqual([
      "C:\\notes\\notes.txt",
    ]);
  }
  for (const argv of [
    [
      "--",
      AUTOSTART_ARGUMENT,
    ],
    [
      "--flag",
      AUTOSTART_HIDDEN_ARGUMENT,
    ],
    [],
  ]) {
    expect(desktopLaunch(argv)).toEqual({
      launchReason: "manual",
      hidden: false,
      argv,
    });
  }
  expect(() =>
    validateDesktopStartup(
      [],
      {
        closeBehavior: "keep-alive",
      },
      true,
    ),
  ).toThrow("Hidden autostart requires desktop.tray");
  expect(() =>
    validateDesktopStartup(
      [],
      {
        tray: {
          tooltip: "Resident",
        },
      },
      true,
    ),
  ).not.toThrow();
});

test("hidden autostart forwarding preserves visibility while a later manual launch restores the app", async () => {
  const actions: string[] = [];
  const requests: OpenRequest[] = [];
  const lifecycle = new DesktopLifecycle(
    {
      tray: {
        tooltip: "Resident",
      },
      onOpen(request) {
        requests.push(request);
      },
    },
    async (action) => {
      actions.push(action);
    },
    () => {},
    (error) => {
      throw error;
    },
  );
  lifecycle.open(
    {
      ...launch,
      argv: [
        AUTOSTART_HIDDEN_ARGUMENT,
      ],
    },
    "initial",
  );
  lifecycle.open(
    {
      ...launch,
      argv: [
        AUTOSTART_HIDDEN_ARGUMENT,
        "--background",
      ],
    },
    "second-instance",
  );
  lifecycle.open(launch, "second-instance");
  await tick();
  expect(actions).toEqual([
    "show",
  ]);
  expect(
    requests.map((request) => [
      request.source,
      request.launchReason,
      request.argv,
    ]),
  ).toEqual([
    [
      "initial",
      "autostart",
      [],
    ],
    [
      "second-instance",
      "autostart",
      [
        "--background",
      ],
    ],
    [
      "second-instance",
      "manual",
      launch.argv,
    ],
  ]);
});

test("defineApp preserves desktop hooks and context types", () => {
  const app = defineApp({
    modules: [],
    desktop: {
      closeBehavior: "hide",
      tray: {
        tooltip: "Memo",
      },
      onOpen(request, context) {
        const files: readonly string[] = request.files;
        void files;
        void context.show();
      },
      beforeQuit(reason) {
        return reason !== "last-window";
      },
    },
  });
  expect(app.desktop?.closeBehavior).toBe("hide");
  expect(app.desktop?.beforeQuit?.("last-window")).toBe(false);
});

test("raw initial and forwarded opens reach the CLI with URL-like string values unchanged", async () => {
  const cli = defineCLI({
    name: "probe",
    commands: {
      echo: {
        options: {
          label: {
            type: "string",
          },
        },
        schema: z.strictObject({
          values: z.strictObject({
            label: z.string(),
          }),
          positionals: z.array(z.string()),
        }),
      },
    },
  });
  const requests: OpenRequest[] = [];
  const results: Awaited<ReturnType<typeof cli.parse>>[] = [];
  const errors: unknown[] = [];
  const lifecycle = new DesktopLifecycle(
    {
      openArguments: "raw",
      async onOpen(request) {
        requests.push(request);
        results.push(await cli.parse(request.argv));
      },
    },
    async () => {},
    () => {},
    (error) => errors.push(error),
  );
  try {
    for (const source of [
      "initial",
      "second-instance",
    ] as const) {
      for (const value of [
        "https://",
        "file:relative.txt",
      ]) {
        lifecycle.open(
          {
            argv: [
              "echo",
              "--label",
              value,
            ],
            cwd: launch.cwd,
          },
          source,
        );
      }
    }
    await tick();
    expect(errors).toEqual([]);
    expect(requests.map((request) => request.source)).toEqual([
      "initial",
      "initial",
      "second-instance",
      "second-instance",
    ]);
    for (const [index, request] of requests.entries()) {
      const value = index % 2 === 0 ? "https://" : "file:relative.txt";
      expect(request.files).toEqual([]);
      expect(request.urls).toEqual([]);
      expect(Object.isFrozen(request.argv)).toBe(true);
      expect(request.argv).toEqual([
        "echo",
        "--label",
        value,
      ]);
      expect(results[index]).toEqual({
        kind: "match",
        command: "echo",
        data: {
          values: {
            label: value,
          },
          positionals: [],
        },
      });
    }
  } finally {
    lifecycle.dispose();
  }
});

test("concurrent quit requests share a veto and a later quit can proceed", async () => {
  // Keep one decision pending so both quit entry points must share it.
  let finish: (value: boolean) => void = () => {};
  let count = 0;
  let stops = 0;
  const lifecycle = new DesktopLifecycle(
    {
      beforeQuit() {
        count++;
        return new Promise<boolean>((resolve) => {
          finish = resolve;
        });
      },
    },
    async () => {},
    () => {
      stops++;
    },
    () => {},
  );
  const first = lifecycle.quit("last-window");
  const duplicate = lifecycle.context.quit();
  expect(duplicate).toBe(first);
  await tick();
  expect(count).toBe(1);
  finish(false);
  expect(await first).toBe(false);
  expect(stops).toBe(0);
  const retry = lifecycle.quit("tray");
  await tick();
  finish(true);
  expect(await retry).toBe(true);
  expect(stops).toBe(1);
  expect(await lifecycle.context.quit()).toBe(true);
  expect(stops).toBe(1);
});

test("a failed quit callback cancels shutdown and keeps controls usable", async () => {
  const failure = new Error("unsaved work");
  const errors: unknown[] = [];
  const actions: string[] = [];
  let stops = 0;
  const lifecycle = new DesktopLifecycle(
    {
      tray: {
        tooltip: "Memo",
      },
      beforeQuit() {
        throw failure;
      },
    },
    async (action) => {
      actions.push(action);
    },
    () => {
      stops++;
    },
    (error) => errors.push(error),
  );
  expect(await lifecycle.quit("tray")).toBe(false);
  await lifecycle.context.hide();
  await lifecycle.context.show();
  expect(actions).toEqual([
    "hide",
    "show",
  ]);
  expect(errors).toEqual([
    failure,
  ]);
  expect(stops).toBe(0);
});

test("open handlers run in order, recover from errors, and restore a second launch", async () => {
  const seen: string[] = [];
  const errors: unknown[] = [];
  let release: () => void = () => {};
  const lifecycle = new DesktopLifecycle(
    {
      async onOpen(request) {
        seen.push(request.source);
        if (request.source === "initial") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error("bad document");
        }
      },
    },
    async (action) => {
      seen.push(action);
    },
    () => {},
    (error) => errors.push(error),
  );
  lifecycle.open(launch, "initial");
  lifecycle.open(launch, "second-instance");
  await tick();
  expect(seen).toEqual([
    "initial",
  ]);
  release();
  await tick();
  expect(seen).toEqual([
    "initial",
    "show",
    "second-instance",
  ]);
  expect(errors).toHaveLength(1);
  lifecycle.dispose();
  expect(() => lifecycle.open(launch, "second-instance")).toThrow();
});

test("hiding requires a recoverable tray and lifecycle packets cannot cross the wrong direction", async () => {
  expect(
    () =>
      new DesktopLifecycle(
        {
          closeBehavior: "hide",
        },
        async () => {},
        () => {},
        () => {},
      ),
  ).toThrow("requires a tray");
  const lifecycle = new DesktopLifecycle(
    undefined,
    async () => {},
    () => {},
    () => {},
  );
  expect(lifecycle.context.hide()).rejects.toThrow("requires a tray");
  expect(() =>
    validatePacket(
      {
        kind: "quit-request",
        reason: "tray",
      },
      "main",
    ),
  ).not.toThrow();
  expect(() =>
    validatePacket(
      {
        kind: "quit-request",
        reason: "tray",
      },
      "ui",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        kind: "quit-request",
        reason: "forged",
      },
      "main",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        kind: "desktop-control",
        action: "show",
        extra: true,
      },
      "ui",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        kind: "desktop-control",
        action: "show",
      },
      "main",
    ),
  ).toThrow();
});

test("single-instance delivery buffers startup requests and acknowledges preserved Unicode and quoting", async () => {
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\bunaway-test-${crypto.randomUUID()}`
      : `/tmp/bunaway-${crypto.randomUUID()}.sock`;
  const inbox = await listenForInstances(address);
  const received: OpenRequest["argv"][] = [];
  const args = {
    argv: [
      "a b.txt",
      'a"b',
      "C:\\tail\\",
      "한글",
      "memo://open?id=2&mode=edit",
    ],
    cwd: "C:\\docs",
  };
  try {
    // The first request arrives before a handler is installed and must be buffered.
    await forwardToInstance(address, args);
    expect(received).toHaveLength(0);
    inbox.start((input) => received.push(input.argv));
    expect(received).toEqual([
      args.argv,
    ]);
    await forwardToInstance(address, launch);
    expect(received).toEqual([
      args.argv,
      launch.argv,
    ]);
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(address);
      const payload = Buffer.from(`${JSON.stringify(launch)}\n`);
      let reply = "";
      client.on("connect", () => {
        // Split one valid frame across writes to exercise stream framing.
        client.write(payload.subarray(0, 5));
        setTimeout(() => client.write(payload.subarray(5, 11)), 5);
        setTimeout(() => client.write(payload.subarray(11)), 10);
      });
      client.on("error", reject);
      client.on("data", (data) => {
        reply += data.toString();
      });
      client.on("end", () => {
        expect(reply).toBe("accepted\n");
        resolve();
      });
    });
    expect(received).toEqual([
      args.argv,
      launch.argv,
      launch.argv,
    ]);
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(address);
      let reply = "";
      client.on("connect", () =>
        client.write('{"argv":[],"cwd":"relative","quit":true}\n'),
      );
      client.on("error", reject);
      client.on("data", (data) => {
        reply += data.toString();
      });
      client.on("end", () => {
        expect(reply).toBe("rejected\n");
        resolve();
      });
    });
    expect(received).toHaveLength(3);
  } finally {
    await inbox.close();
  }
});

test("launch argument limits reject malformed and oversized payloads", () => {
  for (const value of [
    null,
    {
      argv: [
        1,
      ],
      cwd: "C:\\docs",
    },
    {
      argv: [
        "a\0b",
      ],
      cwd: "C:\\docs",
    },
    {
      argv: [],
      cwd: "relative",
    },
    {
      argv: [
        "x".repeat(65536),
      ],
      cwd: "C:\\docs",
    },
    {
      argv: Array(257).fill("x"),
      cwd: "C:\\docs",
    },
  ]) {
    expect(() => parseLaunchArguments(value)).toThrow();
  }
});

test("startup delivery has a bounded queue and closing the inbox is idempotent", async () => {
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\bunaway-test-${crypto.randomUUID()}`
      : `/tmp/bunaway-${crypto.randomUUID()}.sock`;
  const inbox = await listenForInstances(address);
  try {
    for (let index = 0; index < 32; index++) {
      await forwardToInstance(address, {
        argv: [
          String(index),
        ],
        cwd: "C:\\docs",
      });
    }
    await expect(forwardToInstance(address, launch)).rejects.toThrow(
      "rejected",
    );
    const received: string[] = [];
    inbox.start((input) => received.push(input.argv[0] ?? ""));
    expect(received).toEqual(
      Array.from(
        {
          length: 32,
        },
        (_, index) => String(index),
      ),
    );
    await forwardToInstance(address, launch);
    expect(received.at(-1)).toBe("메모 파일.txt");
  } finally {
    await inbox.close();
    await inbox.close();
  }
});

test("disposing during a quit check prevents a late completion from restarting shutdown", async () => {
  let finish: (value: boolean) => void = () => {};
  let stops = 0;
  const lifecycle = new DesktopLifecycle(
    {
      beforeQuit: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    },
    async () => {},
    () => {
      stops++;
    },
    () => {},
  );
  const quitting = lifecycle.quit("last-window");
  await tick();
  lifecycle.dispose();
  finish(true);
  expect(await quitting).toBe(true);
  expect(stops).toBe(0);
});

test("the current process runtime explicitly rejects desktop options", async () => {
  const { runBunApp } = await import("@bunaway/runtime-bun");
  await expect(
    runBunApp({
      commands: {},
      events: {},
      desktop: {},
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("lifecycle controls require scalar strings instead of coercible objects", () => {
  expect(() =>
    validatePacket(
      {
        kind: "desktop-control",
        action: [
          "show",
        ],
      },
      "ui",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        kind: "quit-request",
        reason: [
          "tray",
        ],
      },
      "main",
    ),
  ).toThrow();
});

test("file URLs reject encoded separators, NUL, and paths without a Windows drive", () => {
  for (const arg of [
    "file:///C:/docs/a%2Fb.txt",
    "file:///C:/docs/a%5Cb.txt",
    "file:///C:/docs/a%00b.txt",
    "file:///relative",
    "file:///C:/docs/%zz.txt",
  ]) {
    expect(() =>
      openRequest(
        {
          argv: [
            arg,
          ],
          cwd: "C:\\docs",
        },
        "initial",
      ),
    ).toThrow();
  }
});

test("raw CLI opens retain autostart metadata and hidden forwarding behavior", async () => {
  const requests: OpenRequest[] = [];
  const actions: string[] = [];
  const lifecycle = new DesktopLifecycle(
    {
      openArguments: "raw",
      tray: {
        tooltip: "Resident",
      },
      onOpen(request) {
        requests.push(request);
      },
    },
    async (action) => {
      actions.push(action);
    },
    () => {},
    (error) => {
      throw error;
    },
  );
  const argv = [
    "echo",
    "--label",
    "https://",
    "file:relative.txt",
  ];
  try {
    lifecycle.open(
      {
        argv: [
          AUTOSTART_ARGUMENT,
          ...argv,
        ],
        cwd: launch.cwd,
      },
      "initial",
    );
    lifecycle.open(
      {
        argv: [
          AUTOSTART_HIDDEN_ARGUMENT,
          ...argv,
        ],
        cwd: launch.cwd,
      },
      "second-instance",
    );
    lifecycle.open(
      {
        argv,
        cwd: launch.cwd,
      },
      "second-instance",
    );
    await tick();
    expect(actions).toEqual([
      "show",
    ]);
    expect(requests.map((request) => request.launchReason)).toEqual([
      "autostart",
      "autostart",
      "manual",
    ]);
    expect(requests.map((request) => request.source)).toEqual([
      "initial",
      "second-instance",
      "second-instance",
    ]);
    for (const request of requests) {
      expect(request.argv).toEqual(argv);
      expect(request.urls).toEqual([]);
      expect(request.files).toEqual([]);
    }
    const markerValue = openRequest(
      {
        argv: [
          "echo",
          "--label",
          AUTOSTART_ARGUMENT,
        ],
        cwd: launch.cwd,
      },
      "initial",
      "raw",
    );
    expect(markerValue.launchReason).toBe("manual");
    expect(markerValue.argv).toEqual([
      "echo",
      "--label",
      AUTOSTART_ARGUMENT,
    ]);
  } finally {
    lifecycle.dispose();
  }
});

test("default and explicit files-and-urls modes retain URL metadata validation", () => {
  for (const value of [
    "https://",
    "file:relative.txt",
  ]) {
    const input = {
      argv: [
        value,
      ],
      cwd: launch.cwd,
    };
    expect(() => openRequest(input, "initial")).toThrow();
    expect(() =>
      openRequest(input, "second-instance", "files-and-urls"),
    ).toThrow();
  }
});

test("instance deadlines end a slow request and a slow acknowledgement after five seconds", async () => {
  const { createServer } = await import("node:net");
  const address = () =>
    process.platform === "win32"
      ? `\\\\.\\pipe\\bunaway-test-${crypto.randomUUID()}`
      : `/tmp/bunaway-${crypto.randomUUID()}.sock`;
  const inbound = address();
  const inbox = await listenForInstances(inbound);
  const outbound = address();
  // Keep both sockets alive while withholding a complete request or reply.
  const server = createServer((socket) => {
    const timer = setInterval(() => socket.write("x"), 1000);
    socket.on("error", () => {});
    socket.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(outbound, resolve);
  });
  const begin = Date.now();
  let inboundElapsed = 0;
  let outboundElapsed = 0;
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const client = createConnection(inbound);
        const timer = setInterval(() => client.write(" "), 1000);
        client.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
            reject(error);
          }
        });
        client.on("close", () => {
          clearInterval(timer);
          inboundElapsed = Date.now() - begin;
          resolve();
        });
      }),
      expect(
        forwardToInstance(outbound, {
          ...launch,
          argv: [
            "x".repeat(60000),
          ],
        }).finally(() => {
          outboundElapsed = Date.now() - begin;
        }),
      ).rejects.toThrow("timed out"),
    ]);
    expect(inboundElapsed).toBeGreaterThanOrEqual(4900);
    expect(outboundElapsed).toBeGreaterThanOrEqual(4900);
    expect(Date.now() - begin).toBeLessThan(6500);
  } finally {
    await inbox.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10000);

test("lifecycle callbacks must be functions", () => {
  for (const name of [
    "onReady",
    "onAllWindowsClosed",
    "onWillQuit",
    "onQuit",
  ]) {
    expect(
      () =>
        new DesktopLifecycle(
          {
            // App definitions loaded at runtime may not have passed a TypeScript check.
            [name]: "not a function",
          } as unknown as DesktopOptions,
          async () => {},
          () => {},
          () => {},
        ),
    ).toThrow(`desktop.${name} must be a function`);
  }
});

test("onReady runs before the initial open and a failure does not stop later callbacks", async () => {
  const seen: string[] = [];
  const errors: unknown[] = [];
  const failure = new Error("ready failed");
  const lifecycle = new DesktopLifecycle(
    {
      async onReady() {
        seen.push("ready:start");
        await tick();
        seen.push("ready:end");
        throw failure;
      },
      onOpen(request) {
        seen.push(`open:${request.source}`);
      },
      onAllWindowsClosed() {
        seen.push("empty");
      },
    },
    async () => {},
    () => {},
    (error) => errors.push(error),
  );
  lifecycle.ready();
  lifecycle.open(launch, "initial");
  lifecycle.windowsEmpty();
  await tick();
  await tick();
  expect(seen).toEqual([
    "ready:start",
    "ready:end",
    "open:initial",
    "empty",
  ]);
  expect(errors).toEqual([
    failure,
  ]);
});

test("ready and all-windows-closed callbacks are skipped once shutdown is committed", async () => {
  const seen: string[] = [];
  const lifecycle = new DesktopLifecycle(
    {
      onReady: () => {
        seen.push("ready");
      },
      onAllWindowsClosed: () => {
        seen.push("empty");
      },
    },
    async () => {},
    () => {},
    () => {},
  );
  lifecycle.commitShutdown("window-destroyed");
  lifecycle.ready();
  lifecycle.windowsEmpty();
  await tick();
  expect(seen).toEqual([]);
});

test("willQuit and quitCompleted report the approved quit reason once, in order", async () => {
  const seen: string[] = [];
  let stops = 0;
  const lifecycle: DesktopLifecycle = new DesktopLifecycle(
    {
      beforeQuit: () => {
        seen.push("beforeQuit");
      },
      async onWillQuit(reason) {
        seen.push(`willQuit:${reason}`);
        // Quitting again from a shutdown hook is harmless.
        expect(await lifecycle.context.quit()).toBe(true);
      },
      async onQuit(reason) {
        seen.push(`quit:${reason}`);
        expect(await lifecycle.context.quit()).toBe(true);
      },
    },
    async () => {},
    () => {
      stops++;
    },
    () => {},
  );
  // Nothing was committed yet, so a host failure path delivers no shutdown hook.
  await lifecycle.willQuit();
  await lifecycle.quitCompleted();
  expect(seen).toEqual([]);
  expect(await lifecycle.quit("tray")).toBe(true);
  // A later cause such as a signal does not replace the approved reason.
  lifecycle.commitShutdown("interrupted");
  await lifecycle.willQuit();
  await lifecycle.willQuit();
  await lifecycle.quitCompleted();
  await lifecycle.quitCompleted();
  expect(stops).toBe(1);
  expect(seen).toEqual([
    "beforeQuit",
    "willQuit:tray",
    "quit:tray",
  ]);
});

test("a committed non-cancellable shutdown skips beforeQuit and later quit checks", async () => {
  let checks = 0;
  const lifecycle = new DesktopLifecycle(
    {
      beforeQuit: () => {
        checks++;
        return false;
      },
    },
    async () => {},
    () => {},
    () => {},
  );
  lifecycle.commitShutdown("interrupted");
  expect(await lifecycle.quit("api")).toBe(true);
  expect(checks).toBe(0);
});

test("shutdown hooks that fail or exceed the deadline are reported and do not block shutdown", async () => {
  const errors: unknown[] = [];
  const failure = new Error("hook failed");
  const lifecycle = new DesktopLifecycle(
    {
      onWillQuit: () => new Promise<void>(() => {}),
      onQuit: () => {
        throw failure;
      },
    },
    async () => {},
    () => {},
    (error) => errors.push(error),
    20,
  );
  lifecycle.commitShutdown("session-end");
  await lifecycle.willQuit();
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("desktop.onWillQuit did not finish");
  await lifecycle.quitCompleted();
  expect(errors[1]).toBe(failure);
  expect(WILL_QUIT_DEADLINE_MS).toBe(3000);
});

test("a session end committed during a pending beforeQuit ignores its later veto", async () => {
  const seen: string[] = [];
  let finish: (value: boolean) => void = () => {};
  let stops = 0;
  const lifecycle = new DesktopLifecycle(
    {
      beforeQuit: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      onWillQuit(reason) {
        seen.push(`willQuit:${reason}`);
      },
    },
    async () => {},
    () => {
      stops++;
    },
    () => {},
  );
  const quitting = lifecycle.quit("last-window");
  await tick();
  lifecycle.commitShutdown("session-end");
  finish(false);
  // The host sends quit-cancelled only for false, so a moot veto must resolve true.
  expect(await quitting).toBe(true);
  expect(stops).toBe(0);
  await lifecycle.willQuit();
  expect(seen).toEqual([
    "willQuit:session-end",
  ]);
});
