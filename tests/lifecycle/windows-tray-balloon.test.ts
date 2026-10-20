import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import type { NativeTrayEvent } from "@bunaway/plugin-api/native";

const TRAY_CALLBACK_MESSAGE = 0x8001;
const NIN_BALLOONSHOW = 0x402;
const NIN_BALLOONHIDE = 0x403;
const NIN_BALLOONTIMEOUT = 0x404;
const NIN_BALLOONUSERCLICK = 0x405;

test.skipIf(process.platform !== "win32")(
  "actual tray balloon requests reach the shell and shell balloon notifications become tray.balloon without tray.input",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { Tray } = await import("#plugins/tray/src/platforms/windows-tray");
    const windows = new Windows(() => {});
    const user = dlopen("user32.dll", {
      PostMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i32",
      },
    });
    const actions: string[] = [];
    const inputs: NativeTrayEvent[] = [];
    const balloons: string[] = [];
    const tray = new Tray(
      windows,
      "balloon",
      (action) => actions.push(action),
      (event) => inputs.push(event),
      undefined,
      undefined,
      (event) => balloons.push(event.state),
    );
    const post = (notification: number) => {
      expect(
        user.symbols.PostMessageW(
          tray.hwnd,
          TRAY_CALLBACK_MESSAGE,
          1n,
          BigInt(notification),
        ),
      ).not.toBe(0);
      windows.pump();
    };
    let disposed = false;
    try {
      // The shell accepts the largest title and content, with and without optional fields.
      tray.displayBalloon({
        title: "t".repeat(63),
        content: "c".repeat(255),
        iconType: "warning",
        silent: true,
      });
      tray.displayBalloon({
        title: "",
        content: "😀".repeat(127),
        iconType: "none",
        silent: false,
      });
      for (const balloon of [
        {
          title: "t".repeat(64),
          content: "c",
        },
        {
          title: "t",
          content: "c".repeat(256),
        },
        {
          title: "a\0b",
          content: "c",
        },
        {
          title: "t",
          content: "\ud800",
        },
      ]) {
        expect(() =>
          tray.displayBalloon({
            ...balloon,
            iconType: "info",
            silent: false,
          }),
        ).toThrow("Invalid tray balloon.");
      }
      tray.removeBalloon();
      // Whatever the shell does with the requests above, only the posted messages are counted.
      balloons.length = 0;

      post(NIN_BALLOONSHOW);
      post(NIN_BALLOONUSERCLICK);
      post(NIN_BALLOONTIMEOUT);
      // The same balloon ending twice (timeout then hide) is one closed.
      post(NIN_BALLOONHIDE);
      expect(balloons).toEqual([
        "show",
        "click",
        "closed",
      ]);
      // A hide without a preceding show, for example after Explorer dropped the balloon, is silent.
      post(NIN_BALLOONHIDE);
      expect(balloons).toHaveLength(3);
      post(NIN_BALLOONSHOW);
      post(NIN_BALLOONHIDE);
      expect(balloons.slice(3)).toEqual([
        "show",
        "closed",
      ]);
      // Balloon notifications are not mouse input and trigger no default click behavior.
      expect(inputs).toEqual([]);
      expect(actions).toEqual([]);

      tray.dispose();
      disposed = true;
      expect(() => tray.removeBalloon()).toThrow("The tray was released.");
    } finally {
      try {
        if (!disposed) {
          tray.dispose();
        }
      } finally {
        windows.dispose();
        user.close();
      }
    }
  },
);
