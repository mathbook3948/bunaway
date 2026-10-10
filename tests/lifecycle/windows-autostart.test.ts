import { expect, test } from "bun:test";
import { dlopen, ptr } from "bun:ffi";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createOperations } from "#plugins/autostart/src/windows";
import {
  commandLine,
  type AppLaunch,
  registrationName,
} from "#plugins/autostart/src/launch";
import {
  APPROVAL_KEY,
  createRegistry,
  RUN_KEY,
} from "#plugins/autostart/src/registry";

// Only UUID-named values are touched. Production code never writes approval.
function editApproval(name: string, state: number | null): void {
  const script =
    state === null
      ? `$p='HKCU:\\${APPROVAL_KEY}'; if (Test-Path -LiteralPath $p) { $k=Get-Item -LiteralPath $p; if ($k.GetValueNames() -contains '${name}') { Remove-ItemProperty -LiteralPath $p -Name '${name}' -ErrorAction Stop } }`
      : `$p='HKCU:\\${APPROVAL_KEY}'; New-Item -Path $p -Force | Out-Null; $b=New-Object byte[] 12; $b[0]=${state}; New-ItemProperty -LiteralPath $p -Name '${name}' -PropertyType Binary -Value $b -Force | Out-Null`;
  const result = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

test.skipIf(process.platform !== "win32")(
  "actual HKCU registration is idempotent, refreshes paths and preserves disabled approval",
  async () => {
    const app: AppLaunch = {
      id: `test.${crypto.randomUUID()}`,
      launch: {
        mode: "packaged",
        executablePath: "C:\\Program Files\\한글 앱.exe",
        args: [],
      },
    };
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app,
    });
    const registry = createRegistry();
    const name = registrationName(app);
    const args = [
      "",
      "공백 값",
      '인용"값',
      "끝\\",
      'a\\"b',
      "& %PATH%",
      "😀",
    ];
    try {
      expect(registry.read(RUN_KEY, name)).toBeNull();
      expect(
        adapter.execute("autostart.getStatus", null, "backend"),
      ).toMatchObject({
        registered: false,
        startupState: "unknown",
        executablePath: null,
        args: null,
      });
      const expected = {
        registered: true,
        executablePath: app.launch.executablePath,
        args,
        matchesCurrentLaunch: true,
      };
      expect(
        adapter.execute(
          "autostart.enable",
          {
            args,
          },
          "backend",
        ),
      ).toMatchObject(expected);
      expect(
        adapter.execute(
          "autostart.enable",
          {
            args,
          },
          "backend",
        ),
      ).toMatchObject(expected);
      registry.write(name, '"C:\\Old app.exe" "old argument"');
      expect(
        adapter.execute("autostart.getStatus", null, "backend"),
      ).toMatchObject({
        registered: true,
        executablePath: "C:\\Old app.exe",
        args: [
          "old argument",
        ],
        matchesCurrentLaunch: false,
      });
      editApproval(name, 3);
      const before = registry.read(APPROVAL_KEY, name);
      expect(
        adapter.execute(
          "autostart.enable",
          {
            args,
          },
          "backend",
        ),
      ).toMatchObject({
        ...expected,
        startupState: "disabled",
      });
      expect(registry.read(APPROVAL_KEY, name)).toEqual(before);
      expect(adapter.execute("autostart.disable", null, "backend")).toBeNull();
      expect(adapter.execute("autostart.disable", null, "backend")).toBeNull();
      expect(registry.read(APPROVAL_KEY, name)).toEqual(before);
      expect(
        adapter.execute("autostart.getStatus", null, "backend"),
      ).toMatchObject({
        registered: false,
        startupState: "disabled",
      });
      editApproval(name, 2);
      expect(
        adapter.execute("autostart.getStatus", null, "backend"),
      ).toMatchObject({
        startupState: "enabled",
        registered: false,
      });
      registry.write(name, "C:\\Program Files\\external.exe argument");
      expect(
        adapter.execute("autostart.getStatus", null, "backend"),
      ).toMatchObject({
        registered: true,
        commandLine: "C:\\Program Files\\external.exe argument",
        executablePath: null,
        args: null,
        matchesCurrentLaunch: false,
      });
      registry.write(name, "relative.exe bad");
      expect(
        adapter.execute("autostart.getStatus", null, "backend"),
      ).toMatchObject({
        registered: true,
        commandLine: "relative.exe bad",
        executablePath: null,
        args: null,
        matchesCurrentLaunch: false,
      });
      expect(() =>
        adapter.execute(
          "autostart.enable",
          {
            args: [
              "\0",
            ],
          },
          "backend",
        ),
      ).toThrow();
      expect(() =>
        adapter.execute(
          "autostart.enable",
          {
            args: [
              "x".repeat(260),
            ],
          },
          "backend",
        ),
      ).toThrow();
      expect(
        adapter.execute("autostart.getStatus", null, "backend"),
      ).toMatchObject({
        commandLine: "relative.exe bad",
      });
    } finally {
      registry.remove(name);
      editApproval(name, null);
      registry.dispose();
      await adapter.dispose();
      await adapter.dispose();
    }
    expect(() =>
      adapter.execute("autostart.getStatus", null, "backend"),
    ).toThrow();
  },
  30000,
);

/** Execute the raw stored command as Windows would, rather than re-serializing an argv array. */
function launchRaw(command: string): void {
  const kernel = dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "i32",
        "u32",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    WaitForSingleObject: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u32",
    },
    GetExitCodeProcess: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  const startup = Buffer.alloc(104);
  startup.writeUInt32LE(104);
  const processInfo = Buffer.alloc(24);
  const text = Buffer.from(`${command}\0`, "utf16le");
  try {
    expect(
      kernel.symbols.CreateProcessW(
        null,
        ptr(text),
        null,
        null,
        0,
        0,
        null,
        null,
        ptr(startup),
        ptr(processInfo),
      ),
    ).toBe(1);
    const process = processInfo.readBigUInt64LE(0);
    try {
      expect(kernel.symbols.WaitForSingleObject(process, 10000)).toBe(0);
      const exit = new Uint32Array(1);
      expect(kernel.symbols.GetExitCodeProcess(process, ptr(exit))).toBe(1);
      expect(exit[0]).toBe(0);
    } finally {
      kernel.symbols.CloseHandle(processInfo.readBigUInt64LE(8));
      kernel.symbols.CloseHandle(process);
    }
  } finally {
    kernel.close();
  }
}

test.skipIf(process.platform !== "win32")(
  "stored compiled and development commands really execute Unicode, quotes and empty arguments",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/자동 실행 ${crypto.randomUUID().slice(0, 8)}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const source = resolve(root, "시작 파일.ts");
    const output = resolve(root, "result.json");
    const executable = resolve(root, "자동 실행.exe");
    await Bun.write(
      source,
      `await Bun.write(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const built = Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      source,
      "--outfile",
      executable,
    ]);
    expect(built.exitCode).toBe(0);
    const args = [
      "",
      "한글 값",
      'a"b',
      "끝\\",
      'a\\"b',
      "& %PATH%",
    ];
    const registry = createRegistry();
    const app: AppLaunch = {
      id: `test.${crypto.randomUUID()}`,
      launch: {
        mode: "packaged",
        executablePath: executable,
        args: [],
      },
    };
    const adapter = createOperations({
      dataRoot: root,
      capabilities: [],
      app,
    });
    try {
      const status = adapter.execute(
        "autostart.enable",
        {
          args,
        },
        "backend",
      );
      const command = commandLine(app, args);
      expect(status).toMatchObject({
        commandLine: command,
        args,
      });
      launchRaw(command);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(args);
      await rm(output);
      const dev: AppLaunch = {
        ...app,
        launch: {
          mode: "development",
          executablePath: process.execPath,
          args: [
            "--no-env-file",
            source,
          ],
        },
      };
      launchRaw(commandLine(dev, args));
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(args);
    } finally {
      registry.remove(registrationName(app));
      registry.dispose();
      await adapter.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  60000,
);
