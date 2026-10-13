import { expect, test } from "bun:test";
import { SystemEvents } from "#native/windows/bun/system-events";

test.skipIf(process.platform !== "win32")(
  "real hidden Windows notification HWND receives synthetic native messages after pump and owns WTS registration",
  async () => {
    const [
      { Windows },
      { user, disposeWin32Bindings },
      { createSessionNotifications },
      { dlopen },
    ] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("#native/windows/bun/session-notifications"),
      import("bun:ffi"),
    ]);
    const windows = new Windows(() => {});
    const driver = dlopen("user32.dll", {
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    });
    let hwnd: bigint | undefined;
    let sessions: ReturnType<typeof createSessionNotifications> | undefined;
    const failures: unknown[] = [];
    const service = new SystemEvents({
      open: (receive) => {
        hwnd = windows.create(
          "Bunaway synthetic notification regression",
          200,
          200,
          receive,
          false,
        );
        const owner = hwnd;
        return () => {
          sessions?.dispose();
          sessions = undefined;
          windows.destroy(owner);
          hwnd = undefined;
        };
      },
      sessions: (enable) => {
        if (enable) {
          if (!hwnd) {
            throw new Error("notification window missing");
          }
          sessions = createSessionNotifications(hwnd);
        } else {
          sessions?.dispose();
          sessions = undefined;
        }
      },
      publish: () => {},
      report: (error) => failures.push(error),
    });
    const seen: string[] = [];
    try {
      const release = service.subscribe((signal) => seen.push(signal), {
        sessionNotifications: true,
      });
      if (!hwnd) {
        throw new Error("notification window missing");
      }
      const driverWindow = hwnd;
      expect(user.symbols.IsWindowVisible(driverWindow)).toBe(0);
      // Scalar lparam=0 is synthetic. This does not change OS settings, suspend hardware or lock a user session.
      for (const [message, parameter] of [
        [
          0x001a,
          0n,
        ],
        [
          0x031a,
          0n,
        ],
        [
          0x0015,
          0n,
        ],
        [
          0x0320,
          0n,
        ],
        [
          0x0218,
          4n,
        ],
        [
          0x0218,
          0x12n,
        ],
        [
          0x02b1,
          7n,
        ],
        [
          0x02b1,
          8n,
        ],
      ] as const) {
        // WM_SETTINGCHANGE carries a borrowed pointer in normal use, so Win32 forbids posting it.
        // Send synchronously with null lparam; plugin callbacks still wait for the post-pump flush.
        driver.symbols.SendMessageW(driverWindow, message, parameter, 0n);
      }
      windows.pump();
      expect(seen).toEqual([]);
      service.flush();
      expect(seen).toEqual([
        "settingChanged",
        "themeChanged",
        "colorsChanged",
        "accentChanged",
        "suspend",
        "resume",
        "sessionLocked",
        "sessionUnlocked",
      ]);
      // The user-presence follow-up may arrive after a pump flush. It is not another wake.
      driver.symbols.SendMessageW(driverWindow, 0x0218, 7n, 0n);
      windows.pump();
      service.flush();
      expect(seen.filter((signal) => signal === "resume")).toHaveLength(1);
      release();
      expect(hwnd).toBeUndefined();
      expect(failures).toEqual([]);
    } finally {
      service.dispose();
      windows.dispose();
      driver.close();
      disposeWin32Bindings();
    }
  },
);
