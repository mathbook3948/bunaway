import { expect, test } from "bun:test";
import { windowAppCommands, windowEvents } from "@bunaway/plugin-windows";
import { validateValue } from "@bunaway/protocol";
import {
  appCommandName,
  contextMenuPoint,
  isSystemMenuArea,
} from "#native/windows/bun/window-input-events";

const identity = {
  windowId: "window-1",
  viewId: "main",
};

/** WM_APPCOMMAND packs the command in the low 12 bits of the high word and the device above it. */
function appCommandParam(command: number, device = 0): bigint {
  return BigInt(((device | command) & 0xffff) * 0x10000);
}

test("app command codes map to the published names", () => {
  expect(appCommandName(appCommandParam(1))).toBe("browser-backward");
  expect(appCommandName(appCommandParam(2))).toBe("browser-forward");
  expect(appCommandName(appCommandParam(14))).toBe("media-play-pause");
  expect(appCommandName(appCommandParam(53))).toBe("delete");
});

test("device bits do not change the command", () => {
  // FAPPCOMMAND_MOUSE (0x8000) accompanies the mouse extra buttons.
  expect(appCommandName(appCommandParam(1, 0x8000))).toBe("browser-backward");
  // FAPPCOMMAND_KEY (0) and FAPPCOMMAND_OEM (0x1000).
  expect(appCommandName(appCommandParam(10, 0x1000))).toBe("volume-up");
});

test("unknown command codes are not published", () => {
  expect(appCommandName(appCommandParam(0))).toBeUndefined();
  expect(appCommandName(appCommandParam(43))).toBeUndefined();
  expect(appCommandName(appCommandParam(54))).toBeUndefined();
  expect(appCommandName(appCommandParam(0xfff))).toBeUndefined();
});

test("every published name is reachable and unique", () => {
  const names = new Set<string>();
  for (let code = 0; code < 0x1000; code++) {
    const name = appCommandName(appCommandParam(code));
    if (name) {
      names.add(name);
    }
  }
  expect(
    [
      ...names,
    ].sort(),
  ).toEqual(
    [
      ...windowAppCommands,
    ].sort(),
  );
});

test("context menu points are signed screen pixels", () => {
  expect(contextMenuPoint(BigInt((20 << 16) | 10))).toEqual({
    x: 10,
    y: 20,
  });
  // A second monitor to the left and above the primary reports negative words.
  expect(
    contextMenuPoint(BigInt((((-30 & 0xffff) << 16) | (-40 & 0xffff)) >>> 0)),
  ).toEqual({
    x: -40,
    y: -30,
  });
});

test("keyboard invoked context menus have no point", () => {
  expect(contextMenuPoint(0xffffffffn)).toBeUndefined();
  expect(contextMenuPoint(-1n)).toBeUndefined();
});

test("only the title bar and system menu icon open the system menu", () => {
  expect(isSystemMenuArea(2)).toBe(true);
  expect(isSystemMenuArea(3)).toBe(true);
  // HTCLIENT, HTMINBUTTON, HTLEFT
  expect(isSystemMenuArea(1)).toBe(false);
  expect(isSystemMenuArea(8)).toBe(false);
  expect(isSystemMenuArea(10)).toBe(false);
});

test("event payload schemas accept their shapes and reject others", () => {
  expect(
    validateValue(windowEvents["windows.appCommand"], {
      ...identity,
      command: "browser-backward",
    }),
  ).toEqual({
    ...identity,
    command: "browser-backward",
  });
  expect(() =>
    validateValue(windowEvents["windows.appCommand"], {
      ...identity,
      command: "unknown-command",
    }),
  ).toThrow();
  expect(
    validateValue(windowEvents["windows.systemContextMenu"], {
      ...identity,
      x: -40,
      y: 30,
    }),
  ).toEqual({
    ...identity,
    x: -40,
    y: 30,
  });
  expect(() =>
    validateValue(windowEvents["windows.systemContextMenu"], {
      ...identity,
      x: 1.5,
      y: 2,
    }),
  ).toThrow();
});
