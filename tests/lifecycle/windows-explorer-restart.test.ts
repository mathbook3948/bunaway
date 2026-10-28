import { dlopen } from "bun:ffi";
import { expect, setDefaultTimeout, test } from "bun:test";
import { wide } from "@bunaway/plugin/win32";
import { deadline, waitFor } from "../fixtures/deadlines.ts";

// Own bun process in run-native.ts: the test ends the runner's Explorer shell.
// Twice the fixture limit: the waits below add up to more than one limit when the shell is slow.
setDefaultTimeout(deadline("nativeFixture") * 2);

const TASKBAR_CLASS = "Shell_TrayWnd";

/** True for the error `waitFor` throws when its deadline passes. */
function isWaitTimeout(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("Timed out after ");
}

/**
 * Leaves the runner with a shell for later steps. Windows may still be restarting it after a
 * failed run, so it gets the wait limit before a second `explorer.exe` is started.
 */
async function ensureShell(taskbar: () => bigint): Promise<void> {
  try {
    await waitFor(() => (taskbar() === 0n ? undefined : true), {
      deadline: "inProcess",
      what: "an Explorer taskbar before the test ends",
    });
  } catch (error) {
    if (!isWaitTimeout(error)) {
      throw error;
    }
    Bun.spawn([
      "explorer.exe",
    ]).unref();
  }
}

/**
 * Ends the Explorer shell the way a crash or "Restart" does. Winlogon starts a new shell
 * (AutoRestartShell), and the new taskbar broadcasts `TaskbarCreated` to top-level windows.
 */
async function killExplorer(): Promise<void> {
  const taskkill = Bun.spawn(
    [
      "taskkill",
      "/F",
      "/IM",
      "explorer.exe",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(taskkill.stdout).text(),
    new Response(taskkill.stderr).text(),
  ]);
  expect(await taskkill.exited, `${stdout}${stderr}`).toBe(0);
}

// Opt-in: only run-native.ts sets this, because the test ends the shell of the machine it runs on.
test.skipIf(
  process.platform !== "win32" ||
    process.env.BUNAWAY_EXPLORER_RESTART_TEST !== "1",
)(
  "a real Explorer restart re-registers the tray icon while the host keeps running",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { Tray } = await import("#plugins/tray/src/platforms/windows-tray");
    const user = dlopen("user32.dll", {
      GetShellWindow: {
        args: [],
        returns: "u64",
      },
      FindWindowW: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "u64",
      },
      IsWindow: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
    });
    const taskbarClass = wide(TASKBAR_CLASS);
    const taskbar = () => user.symbols.FindWindowW(taskbarClass, null);
    const windows = new Windows(() => {});
    let created: InstanceType<typeof Tray> | undefined;
    const stages: string[] = [];
    const reach = (stage: string) => {
      stages.push(stage);
      console.log(`explorer-restart stage: ${stage}`);
    };
    // Keeps the UI message loop serviced while waiting, as the host's UI thread does.
    const pumped =
      <T>(probe: () => T | false | undefined) =>
      () => {
        windows.pump();
        return probe();
      };
    try {
      const tray = new Tray(windows, "explorer restart", () => {});
      created = tray;
      // Precondition: the runner has an Explorer shell with a taskbar that shows this icon.
      const firstTaskbar = await waitFor(
        pumped(() => {
          const handle = taskbar();
          return handle === 0n ? undefined : handle;
        }),
        {
          deadline: "childStep",
          what: "the runner's Explorer taskbar (Shell_NotifyIcon needs a shell)",
        },
      );
      const firstShell = user.symbols.GetShellWindow();
      reach(
        `before: taskbar=${firstTaskbar} shellWindow=${firstShell} bounds=${JSON.stringify(tray.getBounds())}`,
      );
      expect(firstShell).not.toBe(0n);
      await waitFor(
        pumped(() => tray.getBounds() ?? undefined),
        {
          deadline: "childStep",
          what: "the shell to report a rectangle for the registered icon",
        },
      );
      reach("icon registered with the first shell");

      await killExplorer();
      reach("explorer.exe terminated");

      reach(`while no shell runs: bounds=${JSON.stringify(tray.getBounds())}`);

      // A new taskbar window appears when the shell restarts; the tray window must stay alive
      // meanwhile. Windows restarts the shell by itself on a desktop session. A runner may not, and
      // starting explorer.exe is what Task Manager's "Restart" does, so it is the fallback.
      const newTaskbar = () => {
        const handle = taskbar();
        return handle !== 0n && handle !== firstTaskbar ? handle : undefined;
      };
      let nextTaskbar: bigint;
      try {
        nextTaskbar = await waitFor(pumped(newTaskbar), {
          deadline: "inProcess",
          what: "Windows to restart the Explorer shell by itself",
        });
        reach("shell restarted by Windows");
      } catch (error) {
        // Only the wait limit selects the fallback; a failure raised by the message loop is a real
        // failure and must not start a second shell.
        if (!isWaitTimeout(error)) {
          throw error;
        }
        reach(error.message);
        Bun.spawn([
          "explorer.exe",
        ]).unref();
        nextTaskbar = await waitFor(pumped(newTaskbar), {
          deadline: "nativeFixture",
          what: "explorer.exe to create a new taskbar window",
        });
      }
      reach(`new taskbar=${nextTaskbar}`);
      expect(user.symbols.IsWindow(tray.hwnd)).toBe(1);

      // TaskbarCreated reaches the tray window, which adds the icon to the new notification area.
      const bounds = await waitFor(
        pumped(() => tray.getBounds() ?? undefined),
        {
          deadline: "childStep",
          what: "the new shell to report a rectangle for the re-registered icon",
        },
      );
      reach(`icon re-registered: ${JSON.stringify(bounds)}`);
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);

      // NIM_MODIFY only succeeds when the new shell owns the icon.
      tray.setTooltip("after restart");
      expect(tray.get().tooltip).toBe("after restart");
      expect(user.symbols.IsWindow(tray.hwnd)).toBe(1);
      reach("tooltip update accepted by the new shell");
    } finally {
      // Leave the runner with a shell for later steps even if Windows did not restart it.
      try {
        await ensureShell(taskbar);
      } finally {
        try {
          created?.dispose();
        } finally {
          windows.dispose();
          user.close();
        }
        console.log(`explorer-restart stages: ${stages.join(" | ")}`);
      }
    }
  },
);
