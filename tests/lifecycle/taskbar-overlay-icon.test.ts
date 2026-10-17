import { expect, test } from "bun:test";
import { selectOverlayFrame } from "#native/windows/bun/overlay-icon";
import {
  type OverlayIconSetting,
  TaskbarSettingController,
} from "#native/windows/bun/taskbar-progress";
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

test("overlay frame selection prefers the tightest frame covering the icon size", () => {
  const ico = multiFrameIco([
    48,
    16,
    32,
  ]).toString("base64");
  const widthOf = (frame: Buffer) => frame.readInt32LE(4);
  expect(widthOf(selectOverlayFrame(ico, 16))).toBe(16);
  expect(widthOf(selectOverlayFrame(ico, 20))).toBe(32);
  expect(widthOf(selectOverlayFrame(ico, 64))).toBe(48);
});

test("overlay frame selection rejects non-canonical, truncated and out-of-range ICO data", () => {
  const valid = trayIco();
  const outOfRange = Buffer.from(valid);
  outOfRange.writeUInt32LE(valid.length, 18);
  const wrongType = Buffer.from(valid);
  wrongType.writeUInt16LE(2, 2);
  const noFrames = Buffer.from(valid);
  noFrames.writeUInt16LE(0, 4);
  for (const ico of [
    "",
    "not base64!",
    `${valid.toString("base64")}\n`,
    valid.subarray(0, 20).toString("base64"),
    outOfRange.toString("base64"),
    wrongType.toString("base64"),
    noFrames.toString("base64"),
    Buffer.alloc(65_537).toString("base64"),
  ]) {
    expect(() => selectOverlayFrame(ico, 16)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  expect(selectOverlayFrame(valid.toString("base64"), 16)).toEqual(
    valid.subarray(22),
  );
});

test("overlay icon settings wait for the taskbar button, restore after recreation and clear with the window", () => {
  const applied: OverlayIconSetting[] = [];
  const controller = new TaskbarSettingController<OverlayIconSetting>(
    (_window, setting) => applied.push(setting),
  );
  const setting = {
    ico: trayIco().toString("base64"),
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
