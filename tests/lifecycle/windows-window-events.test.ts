import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import type { WindowChange, WindowSnapshot } from "@bunaway/plugin-api/native";

const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;

test.skipIf(process.platform !== "win32")(
  "native move loops keep event acknowledgements and ordered server delivery live beyond channel capacity",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `${import.meta.dir}/windows-modal-events.fixture.ts`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("ordered modal events and server deliveries");
  },
  25000,
);

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
      SetWindowPos: {
        args: [
          "u64",
          "i64",
          "i32",
          "i32",
          "i32",
          "i32",
          "u32",
        ],
        returns: "i32",
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
      const beforeInteractive = events.length;
      driver.symbols.SendMessageW(hwnd, 0x0231, 0n, 0n);
      windows.setPosition(hwnd, 80, 100);
      windows.setSize(hwnd, 720, 540);
      const beforeEnd = windows.getSnapshot(hwnd);
      driver.symbols.SendMessageW(hwnd, 0x0232, 0n, 0n);
      checkObservation("moved", beforeInteractive);
      checkObservation("resized", beforeInteractive);
      expect(events.at(-1)?.changes).toEqual([
        "moved",
        "resized",
      ]);
      expect(windows.getSnapshot(hwnd).revision).toBeGreaterThan(
        beforeEnd.revision,
      );
      const completedCount = events.length;
      driver.symbols.SendMessageW(hwnd, 0x0232, 0n, 0n);
      driver.symbols.SendMessageW(hwnd, 0x0231, 0n, 0n);
      driver.symbols.SendMessageW(hwnd, 0x0232, 0n, 0n);
      expect(events).toHaveLength(completedCount);
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
      // A topmost toggle changes only Z order, so it must not also report move or resize.
      const checkAlwaysOnTop = (
        change: "enterAlwaysOnTop" | "leaveAlwaysOnTop",
        action: () => void,
      ) => {
        const start = events.length;
        check(change, action);
        expect(events.slice(start).flatMap((event) => event.changes)).toEqual([
          change,
        ]);
        expect(events.at(-1)?.snapshot.state.alwaysOnTop).toBe(
          change === "enterAlwaysOnTop",
        );
      };
      checkAlwaysOnTop("enterAlwaysOnTop", () =>
        windows.setAlwaysOnTop(hwnd, true),
      );
      checkAlwaysOnTop("leaveAlwaysOnTop", () =>
        windows.setAlwaysOnTop(hwnd, false),
      );
      const beforeSameAlwaysOnTop = events.length;
      windows.setAlwaysOnTop(hwnd, false);
      windows.pump();
      expect(events).toHaveLength(beforeSameAlwaysOnTop);
      // A same-thread direct SetWindowPos call exercises the same
      // WM_WINDOWPOSCHANGED path that other processes' calls go through.
      checkAlwaysOnTop("enterAlwaysOnTop", () =>
        expect(
          driver.symbols.SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
          ),
        ).not.toBe(0),
      );
      checkAlwaysOnTop("leaveAlwaysOnTop", () =>
        expect(
          driver.symbols.SetWindowPos(
            hwnd,
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
          ),
        ).not.toBe(0),
      );
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

test.skipIf(process.platform !== "win32")(
  "real Win32 owner always-on-top changes keep owned window events consistent with queries",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const windows = new Windows(() => {});
    const created: bigint[] = [];
    try {
      const create = (title: string) => {
        const hwnd = windows.create(title, 400, 300, () => {}, false);
        created.push(hwnd);
        return hwnd;
      };
      const owner = create("Always on top owner");
      const shownOwned = create("Always on top shown owned");
      const hiddenOwned = create("Always on top hidden owned");
      windows.setOwner(shownOwned, owner);
      windows.setOwner(hiddenOwned, owner);
      windows.show(owner, true);
      windows.show(shownOwned, true);
      windows.pump();
      const observed = [
        owner,
        shownOwned,
        hiddenOwned,
      ].map((hwnd) => {
        const events: {
          snapshot: WindowSnapshot;
          changes: WindowChange[];
        }[] = [];
        windows.observe(hwnd, "main", (snapshot, changes) =>
          events.push({
            snapshot,
            changes,
          }),
        );
        return {
          hwnd,
          events,
          baseline: windows.getSnapshot(hwnd),
        };
      });
      for (const value of [
        true,
        false,
      ]) {
        windows.setAlwaysOnTop(owner, value);
        windows.pump();
        // Read the last event before getSnapshot, which would refresh the
        // committed snapshot and hide a missed notification. Propagation to
        // owned windows is OS-defined (a hidden owned window in particular),
        // so only event and query consistency is asserted for them.
        for (const { hwnd, events, baseline } of observed) {
          const reported = (events.at(-1)?.snapshot ?? baseline).state
            .alwaysOnTop;
          expect(reported).toBe(windows.isAlwaysOnTop(hwnd));
        }
        expect(windows.isAlwaysOnTop(owner)).toBe(value);
        console.log(
          `alwaysOnTop=${value}: shown owned window topmost=${windows.isAlwaysOnTop(shownOwned)}`,
        );
      }
      expect(windows.failure).toBeUndefined();
    } finally {
      for (const hwnd of created.reverse()) {
        windows.destroy(hwnd);
      }
      windows.dispose();
    }
  },
);
