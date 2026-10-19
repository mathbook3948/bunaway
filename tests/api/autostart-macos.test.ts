import { afterEach, beforeEach, test as bunTest, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import autostart from "@bunaway/plugin-autostart";
import { NativeRegistry } from "@bunaway/protocol";
import type { AppLaunch } from "#plugins/autostart/src/contract";
import {
  type AutostartState,
  createState,
  disable,
  enable,
  getStatus,
  initialize,
} from "#plugins/autostart/src/platforms/macos";
import {
  buildLaunchAgent,
  parseLaunchAgent,
  programArguments,
} from "#plugins/autostart/src/platforms/macos-launch-agent";

const app: AppLaunch = {
  id: "com.example.app",
  launch: {
    mode: "packaged",
    executablePath: "/Applications/My App.app/Contents/MacOS/app",
    args: [],
  },
};
let home = "";
let state: AutostartState;

// The adapter resolves POSIX paths and runs on macOS only; Windows temporary directories are not
// absolute POSIX paths, so Linux and macOS cover it.
const onWindows = process.platform === "win32";
const test = Object.assign(onWindows ? bunTest.skip : bunTest, {
  skipIf: bunTest.skipIf,
});
beforeEach(() => {
  if (onWindows) {
    return;
  }
  home = mkdtempSync(join(tmpdir(), "bunaway-autostart-"));
  state = createState(app, home);
});
afterEach(() => {
  if (onWindows) {
    return;
  }
  rmSync(home, {
    recursive: true,
    force: true,
  });
});

function plistFiles(): string[] {
  return readdirSync(join(home, "Library", "LaunchAgents")).sort();
}

test("macOS registers the same three operations and an app launch is required", () => {
  const registry = new NativeRegistry([
    autostart._definition,
  ]);
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "autostart.enable",
    "autostart.disable",
    "autostart.getStatus",
  ]);
  const environment = {
    dataRoot: home,
    capabilities: [],
  };
  expect(() => initialize(environment)).toThrow("host-selected app launch");
  expect(
    initialize({
      ...environment,
      app,
    }).file,
  ).toBe(join(homedir(), "Library", "LaunchAgents", `${state.name}.plist`));
  expect(() => createState(app, "relative/home")).toThrow("absolute home");
});

test("the launch command is built from host paths with the reserved marker", () => {
  expect(
    programArguments(app, [
      "--login",
      "한글 값",
      "",
    ]),
  ).toEqual([
    "/Applications/My App.app/Contents/MacOS/app",
    "--bunaway-autostart",
    "--login",
    "한글 값",
    "",
  ]);
  const development: AppLaunch = {
    ...app,
    launch: {
      mode: "development",
      executablePath: "/usr/local/bin/bun",
      args: [
        "--no-env-file",
        "/work/assets/boot.js",
      ],
    },
  };
  expect(programArguments(development, [])).toEqual([
    "/usr/local/bin/bun",
    "--no-env-file",
    "/work/assets/boot.js",
    "--bunaway-autostart",
  ]);
  for (const rejected of [
    () => programArguments(app, [], true),
    () =>
      programArguments(development, [
        "--devtools",
      ]),
    () =>
      programArguments(development, [
        "--dev-url",
        "http://localhost",
      ]),
    () =>
      programArguments(app, [
        "a\nb",
      ]),
    () =>
      programArguments(app, [
        "a\0b",
      ]),
    () =>
      programArguments(app, [
        "\ud800",
      ]),
    () =>
      programArguments(
        {
          ...app,
          launch: {
            ...app.launch,
            executablePath: "relative/app",
          },
        },
        [],
      ),
  ]) {
    expect(rejected).toThrow();
  }
  expect(
    programArguments(
      {
        ...app,
        supportsHiddenStart: true,
      },
      [],
      true,
    ),
  ).toContain("--bunaway-autostart-hidden");
});

test("plist text escapes XML and reads back unchanged", () => {
  const args = [
    "/path/a&b <c>",
    "--q=\"x\" 'y'",
    "",
    "한글",
  ];
  const text = buildLaunchAgent("bunaway.packaged.com.example.app", args);
  expect(text).toContain("<string>/path/a&amp;b &lt;c&gt;</string>");
  expect(text).toContain("<string></string>");
  expect(text).toContain("<key>RunAtLoad</key>\n\t<true/>");
  expect(parseLaunchAgent(text)).toEqual({
    label: "bunaway.packaged.com.example.app",
    programArguments: args,
    runAtLoad: true,
  });
});

test("the plist reader rejects anything that is not a well-formed XML property list", () => {
  const valid = buildLaunchAgent("a.b", [
    "/x",
  ]);
  for (const text of [
    "",
    "bplist00\u0000\u0001",
    '<plist version="1.0"><array/></plist>',
    valid.replace("</plist>", ""),
    valid.replace("</dict>", "</array>"),
    valid.replace("/x", "&bogus;"),
    valid.replace("/x", "&#x110000;"),
    valid.replace("/x", "&#0;"),
    valid.replace("/x", "&#xD800;"),
    valid.replace("/x", "&#1;"),
    valid.replace("/x", "&#x110000"),
    valid.replace("<string>a.b</string>", "<string>a.b&#x110000;</string>"),
    valid.replace("<true/>", "<integer></integer>"),
    valid.replace("<true/>", "<integer>4"),
    `${valid}<dict/>`,
    valid.replace("<key>Label</key>", "<string>Label</string>"),
    valid.replace("<string>a.b</string>", "<integer>4</integer>"),
    // Otherwise valid, so only the nesting depth limit rejects it.
    valid.replace(
      "<key>RunAtLoad</key>",
      `<key>Deep</key>${"<array>".repeat(20)}${"</array>".repeat(20)}<key>RunAtLoad</key>`,
    ),
  ]) {
    expect(parseLaunchAgent(text)).toBeNull();
  }
  expect(
    parseLaunchAgent(valid.replace("<true/>", "<false/>"))?.runAtLoad,
  ).toBe(false);
  expect(
    parseLaunchAgent(
      valid.replace(
        "<array>\n\t\t<string>/x</string>\n\t</array>",
        "<string>not-an-array</string>",
      ),
    )?.programArguments,
  ).toBeNull();
});

test("enable writes an owner-only-writable plist atomically and reports the stored launch", () => {
  expect(getStatus(state)).toEqual({
    registrationName: "bunaway.packaged.com.example.app",
    registered: false,
    commandLine: null,
    executablePath: null,
    args: null,
    startupState: "unknown",
    matchesCurrentLaunch: false,
  });
  // Reading must not create the LaunchAgents folder.
  expect(() => readdirSync(join(home, "Library"))).toThrow();
  const status = enable(state, {
    args: [
      "--login",
      "한글 값",
    ],
    hidden: false,
  });
  expect(status).toEqual({
    registrationName: "bunaway.packaged.com.example.app",
    registered: true,
    commandLine:
      "'/Applications/My App.app/Contents/MacOS/app' --bunaway-autostart --login '한글 값'",
    executablePath: "/Applications/My App.app/Contents/MacOS/app",
    args: [
      "--bunaway-autostart",
      "--login",
      "한글 값",
    ],
    startupState: "unknown",
    matchesCurrentLaunch: true,
  });
  expect(plistFiles()).toEqual([
    "bunaway.packaged.com.example.app.plist",
  ]);
  expect(statSync(state.file).mode & 0o777).toBe(0o644);
  expect(getStatus(state)).toEqual(status);
});

test("repeating the same request leaves the file alone and a new one replaces it", () => {
  const input = {
    args: [
      "--login",
    ],
    hidden: false,
  };
  enable(state, input);
  const first = statSync(state.file, {
    bigint: true,
  });
  enable(state, input);
  expect(
    statSync(state.file, {
      bigint: true,
    }).ino,
  ).toBe(first.ino);
  enable(state, {
    args: [
      "--other",
    ],
    hidden: false,
  });
  expect(getStatus(state).args).toEqual([
    "--bunaway-autostart",
    "--other",
  ]);
  expect(plistFiles()).toEqual([
    "bunaway.packaged.com.example.app.plist",
  ]);
});

test("a stored launch from another executable is reported but does not match", () => {
  enable(state, {
    args: [],
    hidden: false,
  });
  const moved = createState(
    {
      ...app,
      launch: {
        ...app.launch,
        executablePath: "/Applications/Moved.app/Contents/MacOS/app",
      },
    },
    home,
  );
  const status = getStatus(moved);
  expect(status.registered).toBe(true);
  expect(status.executablePath).toBe(
    "/Applications/My App.app/Contents/MacOS/app",
  );
  expect(status.matchesCurrentLaunch).toBe(false);
});

test("a stored plist with a relative executable or RunAtLoad false is not trusted", () => {
  mkdirSync(state.directory, {
    recursive: true,
  });
  writeFileSync(
    state.file,
    buildLaunchAgent(state.name, [
      "relative/app",
      "--x",
    ]),
  );
  const relative = getStatus(state);
  expect(relative.registered).toBe(true);
  expect(relative.executablePath).toBeNull();
  expect(relative.args).toBeNull();
  expect(relative.matchesCurrentLaunch).toBe(false);
  writeFileSync(
    state.file,
    buildLaunchAgent(state.name, [
      "/bin/app",
    ]).replace("<true/>", "<false/>"),
  );
  expect(getStatus(state).registered).toBe(false);
});

test("a plist this app did not create is never overwritten or deleted", () => {
  mkdirSync(state.directory, {
    recursive: true,
  });
  const other = join(home, "target.plist");
  writeFileSync(other, "target");
  const foreign = [
    buildLaunchAgent("com.someone.else", [
      "/bin/true",
    ]),
    "not a plist",
    "bplist00",
  ];
  for (const text of foreign) {
    writeFileSync(state.file, text);
    expect(getStatus(state).registered).toBe(false);
    expect(() =>
      enable(state, {
        args: [],
        hidden: false,
      }),
    ).toThrow("was not created by this app");
    expect(() => disable(state)).toThrow("was not created by this app");
    expect(readFileSync(state.file, "utf8")).toBe(text);
  }
  rmSync(state.file);
  symlinkSync(other, state.file);
  expect(() =>
    enable(state, {
      args: [],
      hidden: false,
    }),
  ).toThrow("was not created by this app");
  expect(() => disable(state)).toThrow("was not created by this app");
  expect(readFileSync(other, "utf8")).toBe("target");
  expect(plistFiles()).toEqual([
    "bunaway.packaged.com.example.app.plist",
  ]);
});

test("disable removes only this plist and succeeds when it is missing", () => {
  expect(disable(state)).toBeNull();
  enable(state, {
    args: [],
    hidden: false,
  });
  const sibling = join(state.directory, "com.other.plist");
  writeFileSync(sibling, "other");
  const development = createState(
    {
      ...app,
      launch: {
        ...app.launch,
        mode: "development",
      },
    },
    home,
  );
  enable(development, {
    args: [],
    hidden: false,
  });
  expect(disable(state)).toBeNull();
  expect(disable(state)).toBeNull();
  expect(plistFiles()).toEqual([
    "bunaway.development.com.example.app.plist",
    "com.other.plist",
  ]);
  expect(getStatus(state).registered).toBe(false);
  expect(getStatus(development).registered).toBe(true);
});

test("arguments whose plist would exceed the read limit are rejected before writing", () => {
  expect(() =>
    enable(state, {
      args: Array(64).fill("&".repeat(260)),
      hidden: false,
    }),
  ).toThrow("too long");
  expect(() => readdirSync(join(home, "Library"))).toThrow();
  // A large escaped input that still fits is stored and can be removed again.
  const fits = Array(64).fill("&".repeat(30));
  expect(
    enable(state, {
      args: fits,
      hidden: false,
    }).registered,
  ).toBe(true);
  expect(disable(state)).toBeNull();
});

test("a plist in place of the file that is too large or a directory is foreign", () => {
  mkdirSync(state.directory, {
    recursive: true,
  });
  writeFileSync(state.file, "x".repeat(70 * 1024));
  expect(getStatus(state).registered).toBe(false);
  expect(() => disable(state)).toThrow("was not created by this app");
  rmSync(state.file);
  mkdirSync(state.file);
  expect(() =>
    enable(state, {
      args: [],
      hidden: false,
    }),
  ).toThrow("was not created by this app");
});

test("the label is XML-escaped and an escaped label is read back", () => {
  const text = buildLaunchAgent("a&b", [
    "/x",
  ]);
  expect(text).toContain("<string>a&amp;b</string>");
  expect(parseLaunchAgent(text)?.label).toBe("a&b");
});

test("a file in place of the LaunchAgents folder is reported without creating anything", () => {
  mkdirSync(join(home, "Library"));
  writeFileSync(
    join(home, "Library", "LaunchAgents"),
    "a file where the folder should be",
  );
  for (const run of [
    () =>
      enable(state, {
        args: [],
        hidden: false,
      }),
    () => getStatus(state),
    () => disable(state),
  ]) {
    expect(run).toThrow("launch agent failed");
  }
  expect(readdirSync(join(home, "Library"))).toEqual([
    "LaunchAgents",
  ]);
});

// plutil ships with macOS; the matrix runs this file on macos-14 and skips it elsewhere.
test.skipIf(process.platform !== "darwin")(
  "macOS plutil accepts the generated plist and reads the same arguments back",
  () => {
    const args = [
      "/Applications/My App.app/Contents/MacOS/app",
      "--bunaway-autostart",
      "a&b <c> \"d\" 'e'",
      "",
      "한글 값",
    ];
    const file = join(home, "agent.plist");
    writeFileSync(file, buildLaunchAgent("bunaway.packaged.com.example", args));
    expect(
      Bun.spawnSync([
        "plutil",
        "-lint",
        file,
      ]).exitCode,
    ).toBe(0);
    const json = Bun.spawnSync([
      "plutil",
      "-convert",
      "json",
      "-o",
      "-",
      file,
    ]);
    expect(JSON.parse(json.stdout.toString())).toEqual({
      Label: "bunaway.packaged.com.example",
      ProgramArguments: args,
      RunAtLoad: true,
    });
  },
);

test.skipIf(process.platform !== "darwin" || !process.env.CI)(
  "macOS registers and removes a launch agent under the real user home",
  () => {
    const real = initialize({
      dataRoot: home,
      capabilities: [],
      app: {
        ...app,
        id: `autostart-test-${crypto.randomUUID()}`,
      },
    });
    try {
      expect(
        enable(real, {
          args: [],
          hidden: false,
        }).registered,
      ).toBe(true);
      expect(statSync(real.file).mode & 0o777).toBe(0o644);
      expect(getStatus(real).matchesCurrentLaunch).toBe(true);
    } finally {
      disable(real);
    }
    expect(getStatus(real).registered).toBe(false);
  },
);
