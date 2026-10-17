import { expect, test } from "bun:test";
import {
  type OverlayIconSetting,
  TaskbarSettingController,
} from "#native/windows/bun/taskbar-progress";
import { overlayIconProvider } from "#plugins/windows/src/platforms/windows-overlay-icon";
import { trayIco } from "../fixtures/tray-icon.ts";

/** Combine single-frame fixtures into one ICO directory. */
function multiFrameIco(sizes: number[]): Buffer {
  const frames = sizes.map((size) => trayIco(size).subarray(22));
  const headerSize = 6 + sizes.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = headerSize;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    const frame = frames[index];
    if (!frame) {
      throw new Error("Missing frame");
    }
    header[entry] = size;
    header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  return Buffer.concat([
    header,
    ...frames,
  ]);
}

test("overlay provider validates the whole ICO before any native call", () => {
  const valid = trayIco();
  const outOfRange = Buffer.from(valid);
  outOfRange.writeUInt32LE(valid.length, 18);
  const wrongType = Buffer.from(valid);
  wrongType.writeUInt16LE(2, 2);
  const noFrames = Buffer.from(valid);
  noFrames.writeUInt16LE(0, 4);
  // The directory is valid but the only frame's DIB declares an unsupported bit depth.
  const brokenFrame = Buffer.from(valid);
  brokenFrame.writeUInt16LE(7, 22 + 14);
  // A second frame breaks an otherwise valid ICO even though the first frame would be selected.
  const brokenSecond = multiFrameIco([
    16,
    32,
  ]);
  const secondFrameStart = brokenSecond.readUInt32LE(6 + 16 + 12);
  brokenSecond.writeUInt16LE(7, secondFrameStart + 14);
  for (const ico of [
    "",
    "not base64!",
    `${valid.toString("base64")}\n`,
    valid.subarray(0, 20).toString("base64"),
    outOfRange.toString("base64"),
    wrongType.toString("base64"),
    noFrames.toString("base64"),
    brokenFrame.toString("base64"),
    brokenSecond.toString("base64"),
    Buffer.alloc(65_537).toString("base64"),
  ]) {
    expect(() => overlayIconProvider(ico)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  // Building the HICON is deferred to the host, so a valid ICO yields a provider without native calls.
  expect(typeof overlayIconProvider(valid.toString("base64"))).toBe("function");
});

test("overlay icon settings wait for the taskbar button, restore after recreation and clear with the window", () => {
  const applied: OverlayIconSetting[] = [];
  const controller = new TaskbarSettingController<OverlayIconSetting>(
    (_window, setting) => applied.push(setting),
    // A provider function cannot be structuredClone'd, so the host passes the setting through.
    (setting) => setting,
  );
  const setting = {
    icon: () => 1n,
    description: "3 unread",
  };
  expect(() => controller.set(1n, setting)).toThrow(
    "taskbar button is not ready",
  );
  controller.buttonCreated(1n);
  controller.set(1n, setting);
  controller.buttonCreated(1n);
  controller.set(1n, null);
  controller.buttonCreated(1n);
  expect(applied).toEqual([
    setting,
    setting,
    null,
    null,
  ]);
  controller.forget(1n);
  controller.buttonCreated(1n);
  expect(applied).toHaveLength(4);
});
