import { expect, test } from "bun:test";
import { WindowRelations } from "#native/windows/bun/window-relations";

function fixture() {
  const enabled = new Map([
    [
      "main",
      true,
    ],
    [
      "first",
      true,
    ],
    [
      "second",
      true,
    ],
  ]);
  const owners = new Map<string, string | null>();
  let failOwner = false;
  let failEnable = false;
  const relations = new WindowRelations({
    isEnabled: (id) => enabled.get(id) ?? false,
    setEnabled(id, value) {
      if (failEnable) {
        throw new Error("Enable failed");
      }
      enabled.set(id, value);
    },
    setOwner(child, parent) {
      if (failOwner) {
        throw new Error("Owner failed");
      }
      owners.set(child, parent);
    },
  });
  for (const windowId of enabled.keys()) {
    relations.register({
      windowId,
      viewId: windowId,
    });
  }
  return {
    relations,
    enabled,
    owners,
    failOwner: () => {
      failOwner = true;
    },
    failEnable: () => {
      failEnable = true;
    },
    recoverEnable: () => {
      failEnable = false;
    },
  };
}

test("multiple modal lifetimes restore the original enabled state only after the last release", () => {
  for (const previous of [
    true,
    false,
  ]) {
    const { relations, enabled } = fixture();
    enabled.set("main", previous);
    relations.setParent("first", "main", true);
    relations.setParent("second", "main", true);
    expect(enabled.get("main")).toBe(false);
    expect(() => relations.setEnabled("main", true)).toThrow("blocking");
    relations.markClosing("first");
    expect(
      relations.getChildren("main").map((child) => child.windowId),
    ).toEqual([
      "second",
    ]);
    relations.release("first");
    expect(enabled.get("main")).toBe(false);
    relations.release("second");
    relations.release("second");
    expect(enabled.get("main")).toBe(previous);
  }
});

test("ownership rejects self, ancestor cycles, stale lifetimes and modal without parent", () => {
  const { relations, owners } = fixture();
  relations.setParent("first", "main", false);
  relations.setParent("second", "first", true);
  expect(relations.getParent("second")).toEqual({
    windowId: "first",
    viewId: "first",
  });
  expect(relations.closeOrder("main")).toEqual([
    "second",
    "first",
    "main",
  ]);
  expect(() => relations.setParent("main", "second", false)).toThrow("cycle");
  expect(() => relations.setParent("main", "main", false)).toThrow("cycle");
  expect(() => relations.setParent("first", "missing", false)).toThrow(
    "not open",
  );
  expect(() => relations.setParent("first", null, true)).toThrow("requires");
  expect(owners.get("first")).toBe("main");
});

test("native owner or disable failure leaves ownership and input unchanged", () => {
  const ownerFailure = fixture();
  ownerFailure.failOwner();
  expect(() => ownerFailure.relations.setParent("first", "main", true)).toThrow(
    "Owner failed",
  );
  expect(ownerFailure.relations.getParent("first")).toBeNull();
  const enableFailure = fixture();
  enableFailure.failEnable();
  expect(() =>
    enableFailure.relations.setParent("first", "main", true),
  ).toThrow("Enable failed");
  expect(enableFailure.owners.get("first")).toBeNull();
  expect(enableFailure.relations.getParent("first")).toBeNull();
  expect(enableFailure.enabled.get("main")).toBe(true);
});

test("parent release waits for descendants and closing parents are never reenabled", () => {
  const { relations, enabled } = fixture();
  relations.setParent("first", "main", true);
  relations.setParent("second", "first", true);
  for (const id of relations.closeOrder("main")) {
    relations.markClosing(id);
  }
  expect(() => relations.setParent("second", "main", false)).toThrow(
    "not open",
  );
  expect(relations.canRelease("main")).toBe(false);
  expect(() => relations.release("main")).toThrow("before");
  relations.release("second");
  expect(enabled.get("first")).toBe(false);
  relations.release("first");
  expect(enabled.get("main")).toBe(false);
  relations.release("main");
  relations.register({
    windowId: "new-main",
    viewId: "main",
  });
  expect(() => relations.setParent("new-main", "main", false)).toThrow(
    "not open",
  );
});

test("modal detachment and reattachment transfer blockers without losing the baseline", () => {
  const { relations, enabled } = fixture();
  relations.setParent("second", "main", true);
  expect(() => relations.setParent("second", "first", true)).toThrow("Detach");
  relations.setParent("second", null, false);
  expect(enabled.get("main")).toBe(true);
  relations.setParent("second", "first", true);
  expect(enabled.get("first")).toBe(false);
  relations.setParent("second", "first", false);
  expect(enabled.get("first")).toBe(true);
});

test("failed input restoration retains its owner until retry or parent shutdown releases it", () => {
  const { relations, failEnable, recoverEnable, enabled } = fixture();
  relations.setParent("first", "main", true);
  relations.markClosing("first");
  failEnable();
  expect(() => relations.release("first")).toThrow("Enable failed");
  expect(relations.canRelease("main")).toBe(false);
  recoverEnable();
  relations.release("first");
  expect(enabled.get("main")).toBe(true);
  expect(relations.canRelease("main")).toBe(true);
});

test.skipIf(process.platform !== "win32")(
  "real Win32 owner and enabled state agree with modal lifetime cleanup",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const native = new Windows(() => {});
    const handles = new Map<string, bigint>();
    const handle = (id: string) => {
      const hwnd = handles.get(id);
      if (!hwnd) {
        throw new Error("Missing HWND");
      }
      return hwnd;
    };
    const relations = new WindowRelations({
      setOwner: (id, parent) =>
        native.setOwner(handle(id), parent === null ? 0n : handle(parent)),
      isEnabled: (id) => native.isEnabled(handle(id)),
      setEnabled: (id, enabled) => native.setEnabled(handle(id), enabled),
    });
    try {
      for (const id of [
        "main",
        "first",
        "second",
      ]) {
        const hwnd = native.create(id, 400, 300, () => {}, false);
        handles.set(id, hwnd);
        native.observe(hwnd, id, () => {});
        relations.register({
          windowId: id,
          viewId: id,
        });
      }
      for (const previous of [
        true,
        false,
      ]) {
        native.setEnabled(handle("main"), previous);
        relations.setParent("first", "main", true);
        relations.setParent("second", "main", true);
        expect(native.getOwner(handle("first"))).toBe(handle("main"));
        expect(native.isEnabled(handle("main"))).toBe(false);
        relations.setParent("first", null, false);
        expect(native.isEnabled(handle("main"))).toBe(false);
        relations.setParent("second", null, false);
        expect(native.isEnabled(handle("main"))).toBe(previous);
      }
    } finally {
      for (const id of [
        "second",
        "first",
        "main",
      ]) {
        native.destroy(handle(id));
      }
      native.dispose();
    }
  },
);
