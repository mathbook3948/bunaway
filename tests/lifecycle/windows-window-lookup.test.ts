import { expect, test } from "bun:test";
import assert from "node:assert/strict";

test.skipIf(process.platform !== "win32")(
  "real HWND identity, foreground lookup and activation history remain read-only across hide and destruction",
  async () => {
    const [{ Windows }, { user }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
    ]);
    const windows = new Windows(() => {});
    const handles = new Set<bigint>();
    const create = (view: string) => {
      const hwnd = windows.create(`Lookup ${view}`, 500, 400, () => {}, false);
      handles.add(hwnd);
      windows.observe(hwnd, view, () => {});
      return hwnd;
    };
    try {
      const main = create("main");
      const editor = create("editor");
      const mainIdentity = windows.getByView("main");
      const editorIdentity = windows.getByView("editor");
      assert(mainIdentity && editorIdentity);
      expect(windows.getById(mainIdentity.windowId)).toEqual(mainIdentity);
      expect(windows.getById("main")).toBeNull();
      expect(windows.getFocused()).toBeNull();
      expect(windows.getLastActive()).toBeNull();

      windows.show(main, true);
      const mainFocused = windows.focus(main);
      windows.pump();
      if (mainFocused) {
        expect(windows.getFocused()).toEqual(mainIdentity);
        expect(windows.getLastActive()).toEqual(mainIdentity);
      } else {
        console.log("UNTESTED main activation transition: OS declined focus.");
        expect(windows.getFocused()).toEqual(
          windows.isFocused(main) ? mainIdentity : null,
        );
      }
      const foreground = user.symbols.GetForegroundWindow();
      const focused = windows.getFocused();
      const lastActive = windows.getLastActive();
      for (let index = 0; index < 5; index++) {
        expect(windows.getById(editorIdentity.windowId)).toEqual(
          editorIdentity,
        );
        expect(windows.getByView("main")).toEqual(mainIdentity);
        expect(windows.getFocused()).toEqual(focused);
        expect(windows.getLastActive()).toEqual(lastActive);
        expect(windows.isVisible(editor)).toBe(false);
        expect(user.symbols.GetForegroundWindow()).toBe(foreground);
      }

      windows.show(editor, true);
      const editorFocused = windows.focus(editor);
      windows.pump();
      if (editorFocused) {
        expect(windows.getFocused()).toEqual(editorIdentity);
        expect(windows.getLastActive()).toEqual(editorIdentity);
      } else {
        console.log(
          "UNTESTED editor activation transition: OS declined focus.",
        );
      }
      const beforeHide = windows.getLastActive();
      // Deactivate every owned window without creating a substitute or querying history to update it.
      windows.show(main, false);
      windows.show(editor, false);
      windows.pump();
      expect(windows.getFocused()).toBeNull();
      expect(windows.getLastActive()).toEqual(beforeHide);
      windows.destroy(editor);
      handles.delete(editor);
      windows.pump();
      expect(windows.getById(editorIdentity.windowId)).toBeNull();
      const afterDestroy =
        beforeHide?.windowId === editorIdentity.windowId ? null : beforeHide;
      expect(windows.getLastActive()).toEqual(afterDestroy);
      expect(windows.getById(mainIdentity.windowId)).toEqual(mainIdentity);

      const replacement = create("editor");
      const replacementIdentity = windows.getByView("editor");
      assert(replacementIdentity);
      expect(replacementIdentity.windowId).not.toBe(editorIdentity.windowId);
      expect(windows.getById(editorIdentity.windowId)).toBeNull();
      expect(windows.getLastActive()).toEqual(afterDestroy);
      expect(windows.isVisible(replacement)).toBe(false);
      windows.show(replacement, true);
      const replacementFocused = windows.focus(replacement);
      windows.pump();
      if (replacementFocused) {
        expect(windows.getFocused()).toEqual(replacementIdentity);
        expect(windows.getLastActive()).toEqual(replacementIdentity);
      } else {
        console.log(
          "UNTESTED replacement activation transition: OS declined focus.",
        );
      }
      const beforeOtherDestroy = windows.getLastActive();
      // Destroying a different window does not erase the latest activation.
      windows.destroy(main);
      handles.delete(main);
      expect(windows.getLastActive()).toEqual(
        beforeOtherDestroy?.windowId === mainIdentity.windowId
          ? null
          : beforeOtherDestroy,
      );
    } finally {
      for (const hwnd of handles) {
        windows.destroy(hwnd);
      }
      windows.dispose();
    }
  },
);
