import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import type { WindowChange, WindowSnapshot } from "@bunaway/plugin-api/native";

test.skipIf(process.platform !== "win32")(
  "real Win32 API and system commands emit committed window transitions and stop after destroy",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
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
    const events: {
      snapshot: WindowSnapshot;
      changes: WindowChange[];
    }[] = [];
    let hwnd = 0n;
    try {
      hwnd = windows.create(
        "Window events regression",
        640,
        480,
        () => {},
        false,
      );
      windows.observe(hwnd, "main", (snapshot, changes) =>
        events.push({
          snapshot,
          changes,
        }),
      );
      const original = windows.getSnapshot(hwnd);
      const checkObservation = (change: WindowChange, start: number) => {
        expect(
          events.slice(start).some((event) => event.changes.includes(change)),
        ).toBe(true);
        expect(events.at(-1)?.snapshot).toEqual(windows.getSnapshot(hwnd));
        expect(windows.getSnapshot(hwnd).bounds).toEqual(
          windows.getBounds(hwnd, "outer"),
        );
      };
      const check = (change: WindowChange, action: () => void) => {
        const start = events.length;
        action();
        windows.pump();
        checkObservation(change, start);
      };
      check("shown", () => windows.show(hwnd, true));
      check("hidden", () => windows.show(hwnd, false));
      const beforeDuplicate = events.length;
      windows.show(hwnd, false);
      windows.pump();
      expect(events).toHaveLength(beforeDuplicate);
      check("move", () => windows.setPosition(hwnd, 60, 80));
      check("resize", () => windows.setSize(hwnd, 700, 520));
      check("maximize", () => windows.maximize(hwnd));
      check("unmaximize", () => windows.unmaximize(hwnd));
      check("minimize", () => windows.minimize(hwnd));
      check("restore", () => windows.restore(hwnd));
      // System-menu commands use the same path as the user's native caption buttons.
      check("maximize", () => {
        driver.symbols.SendMessageW(hwnd, 0x0112, 0xf030n, 0n);
      });
      check("minimize", () => {
        driver.symbols.SendMessageW(hwnd, 0x0112, 0xf020n, 0n);
      });
      check("restore", () => {
        driver.symbols.SendMessageW(hwnd, 0x0112, 0xf120n, 0n);
      });
      windows.unmaximize(hwnd);
      check("enterFullscreen", () => windows.setFullscreen(hwnd, true));
      check("leaveFullscreen", () => windows.setFullscreen(hwnd, false));
      for (let index = 1; index < events.length; index++) {
        expect(events[index]?.snapshot.revision).toBeGreaterThan(
          events[index - 1]?.snapshot.revision ?? 0,
        );
      }
      const second = windows.create(
        "Window focus regression",
        400,
        300,
        () => {},
        false,
      );
      try {
        const focused = windows.focus(hwnd);
        windows.pump();
        if (focused && windows.isFocused(hwnd)) {
          for (const [target, change] of [
            [
              second,
              "blur",
            ],
            [
              hwnd,
              "focus",
            ],
          ] as const) {
            const start = events.length;
            const accepted = windows.focus(target);
            windows.pump();
            // Windows can decline any foreground request, even after an earlier one succeeded.
            if (!accepted || !windows.isFocused(target)) {
              expect(windows.getSnapshot(hwnd).state.focused).toBe(
                windows.isFocused(hwnd),
              );
              console.warn(
                `Native ${change} transition not verified: Windows declined foreground focus in this test session.`,
              );
              break;
            }
            checkObservation(change, start);
          }
        } else {
          expect(windows.getSnapshot(hwnd).state.focused).toBe(
            windows.isFocused(hwnd),
          );
          console.warn(
            "Native focus/blur activation not verified: Windows declined foreground focus in this test session.",
          );
        }
      } finally {
        windows.destroy(second);
      }
      windows.destroy(hwnd);
      hwnd = 0n;
      const finalCount = events.length;
      windows.pump();
      expect(events).toHaveLength(finalCount);
      hwnd = windows.create(
        "Recreated events regression",
        640,
        480,
        () => {},
        false,
      );
      windows.observe(hwnd, "main", (snapshot, changes) =>
        events.push({
          snapshot,
          changes,
        }),
      );
      expect(windows.getSnapshot(hwnd).windowId).not.toBe(original.windowId);
      expect(windows.getSnapshot(hwnd).revision).toBe(0);
      check("shown", () => windows.show(hwnd, true));
    } finally {
      if (hwnd) {
        windows.destroy(hwnd);
      }
      windows.dispose();
      driver.close();
    }
  },
);
