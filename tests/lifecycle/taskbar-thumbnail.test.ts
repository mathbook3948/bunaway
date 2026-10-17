import { expect, test } from "bun:test";
import {
  TaskbarSettingController,
  type ThumbnailClip,
} from "#native/windows/bun/taskbar-progress";
import { physicalRect } from "#native/windows/bun/window-size";

test("thumbnail clip converts logical edges so adjacent regions share a physical edge", () => {
  expect(
    physicalRect(
      {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
      96,
    ),
  ).toEqual({
    left: 10,
    top: 20,
    right: 110,
    bottom: 70,
  });
  const left = physicalRect(
    {
      x: 0,
      y: 0,
      width: 33,
      height: 10,
    },
    144,
  );
  const right = physicalRect(
    {
      x: 33,
      y: 0,
      width: 33,
      height: 10,
    },
    144,
  );
  expect(left.right).toBe(right.left);
  expect(right.right).toBe(99);
});

test("thumbnail settings wait for the button, restore after recreation and keep null clears", () => {
  const calls: [
    bigint,
    ThumbnailClip,
  ][] = [];
  let failing = false;
  const controller = new TaskbarSettingController<ThumbnailClip>(
    (window, region) => {
      if (failing) {
        throw new Error("native failure");
      }
      calls.push([
        window,
        region,
      ]);
    },
  );
  const region = {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  };
  expect(() => controller.set(1n, region)).toThrow("not ready");
  controller.buttonCreated(1n);
  controller.set(1n, region);
  controller.set(1n, null);
  controller.buttonCreated(1n);
  expect(calls.at(-1)).toEqual([
    1n,
    null,
  ]);
  // A rejected request must not replace the setting restored after button recreation.
  failing = true;
  expect(() => controller.set(1n, region)).toThrow("native failure");
  failing = false;
  controller.buttonCreated(1n);
  expect(calls.at(-1)).toEqual([
    1n,
    null,
  ]);
  controller.forget(1n);
  expect(() => controller.set(1n, region)).toThrow("not ready");
  controller.buttonCreated(1n);
  expect(calls).toHaveLength(4);
});
