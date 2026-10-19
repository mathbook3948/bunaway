import { expect, test } from "bun:test";
import dialog from "@bunaway/plugin-dialog";
import { BunawayError } from "@bunaway/protocol";
import {
  dialogOperations,
  macosDialogOperations,
} from "#plugins/dialog/src/operations";
import {
  MacosDialogs,
  panelSettings,
} from "#plugins/dialog/src/platforms/macos";
import type {
  FilePanel,
  FilePanelFactory,
  PanelSettings,
} from "#plugins/dialog/src/platforms/macos-bindings";

/** A panel factory that records the settings and answers `run` with a scripted result. */
function fakePanels(answer: string[] | null | (() => string[] | null)) {
  const created: PanelSettings[] = [];
  const events: string[] = [];
  const factory: FilePanelFactory = {
    create(settings) {
      created.push(settings);
      events.push("create");
      const panel: FilePanel = {
        readBack: () => {
          throw new Error("unused");
        },
        scheduleCancel: () => undefined,
        run: () => {
          events.push("run");
          return typeof answer === "function" ? answer() : answer;
        },
        dispose: () => {
          events.push("dispose");
        },
      };
      return panel;
    },
    dispose: () => {
      events.push("factory-dispose");
    },
  };
  return {
    factory,
    created,
    events,
  };
}

test("macOS registers the file pickers and shares their schemas with Windows", () => {
  const macos = dialog._definition.nativePlatforms.macos;
  expect(macos?.operations).toEqual([
    "openFile",
    "selectFolder",
    "saveFile",
  ]);
  expect(macos?.operations).not.toContain("showMessage");
  for (const name of [
    "openFile",
    "selectFolder",
    "saveFile",
  ] as const) {
    expect(macosDialogOperations[name].input).toBe(
      dialogOperations[name].input,
    );
    expect(macosDialogOperations[name].output).toBe(
      dialogOperations[name].output,
    );
  }
  expect(dialog._definition.nativePlatforms.windows?.operations).toContain(
    "showMessage",
  );
});

test("an open panel chooses files and honors multiple selection and hidden files", () => {
  expect(panelSettings("openFile", {})).toMatchObject({
    canChooseFiles: true,
    canChooseDirectories: false,
    multiple: false,
    canCreateDirectories: false,
    showHidden: false,
    save: false,
    extensions: null,
    fileName: null,
    directory: null,
    title: null,
  });
  expect(
    panelSettings("openFile", {
      multiple: true,
      showHiddenFiles: true,
      title: "Pick",
      defaultDirectory: "/tmp",
    }),
  ).toMatchObject({
    multiple: true,
    showHidden: true,
    title: "Pick",
    directory: "/tmp",
  });
});

test("a folder panel chooses directories only and may create one", () => {
  expect(
    panelSettings("selectFolder", {
      multiple: true,
    }),
  ).toMatchObject({
    canChooseFiles: false,
    canChooseDirectories: true,
    multiple: true,
    canCreateDirectories: true,
    save: false,
  });
});

test("a save panel returns one location and ignores the multiple selection flag", () => {
  expect(
    panelSettings("saveFile", {
      multiple: true,
      defaultFileName: "notes",
      defaultExtension: "txt",
    }),
  ).toMatchObject({
    multiple: false,
    save: true,
    canCreateDirectories: true,
    fileName: "notes.txt",
  });
});

test("the default extension completes only a default name that has none", () => {
  const name = (defaultFileName: string) =>
    panelSettings("saveFile", {
      defaultFileName,
      defaultExtension: "txt",
    }).fileName;
  expect(name("report")).toBe("report.txt");
  expect(name("report.md")).toBe("report.md");
  expect(name("archive.tar.gz")).toBe("archive.tar.gz");
  expect(name(".env")).toBe(".env.txt");
  expect(panelSettings("saveFile", {}).fileName).toBeNull();
  // A name is only a save panel concept: the open panel has no name field.
  expect(
    panelSettings("openFile", {
      defaultFileName: "a.txt",
    }).fileName,
  ).toBe(null);
});

test("filters merge into one accepted extension set and a wildcard accepts every file", () => {
  expect(
    panelSettings("openFile", {
      filters: [
        {
          name: "Text",
          extensions: [
            "TXT",
            "md",
          ],
        },
        {
          name: "Notes",
          extensions: [
            "txt",
            "log",
          ],
        },
      ],
    }).extensions,
  ).toEqual([
    "txt",
    "md",
    "log",
  ]);
  expect(
    panelSettings("saveFile", {
      filters: [
        {
          name: "Text",
          extensions: [
            "txt",
          ],
        },
        {
          name: "All",
          extensions: [
            "*",
          ],
        },
      ],
    }).extensions,
  ).toBeNull();
  expect(panelSettings("selectFolder", {}).extensions).toBeNull();
});

test("confirmOverwrite never changes the panel because a save panel always confirms", () => {
  expect(
    panelSettings("saveFile", {
      confirmOverwrite: false,
    }),
  ).toEqual(panelSettings("saveFile", {}));
});

test("a chosen path list and a user cancel map to the shared result shape", () => {
  const chosen = fakePanels([
    "/tmp/a",
    "/tmp/b",
  ]);
  const dialogs = new MacosDialogs(chosen.factory);
  expect(dialogs.show("openFile", {}, "backend")).toEqual({
    cancelled: false,
    paths: [
      "/tmp/a",
      "/tmp/b",
    ],
  });
  expect(chosen.events).toEqual([
    "create",
    "run",
    "dispose",
  ]);
  expect(dialogs.busy()).toBe(false);

  const dismissed = new MacosDialogs(fakePanels(null).factory);
  expect(dismissed.show("saveFile", {}, "backend")).toEqual({
    cancelled: true,
  });
});

test("a call aborted before the panel opens never creates a panel", () => {
  const panels = fakePanels([
    "/tmp/a",
  ]);
  const dialogs = new MacosDialogs(panels.factory);
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    dialogs.show("openFile", {}, "backend", controller.signal),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(panels.events).toEqual([]);
});

test("an abort that arrives during the panel replaces the answer with CANCELLED", () => {
  const controller = new AbortController();
  const panels = fakePanels(() => {
    controller.abort();
    return [
      "/tmp/a",
    ];
  });
  const dialogs = new MacosDialogs(panels.factory);
  expect(() =>
    dialogs.show("openFile", {}, "backend", controller.signal),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(panels.events).toEqual([
    "create",
    "run",
    "dispose",
  ]);
  expect(dialogs.busy()).toBe(false);
});

test("a nested call is BUSY and a failing panel still releases the busy state", () => {
  let nested: unknown;
  const holder: {
    dialogs?: MacosDialogs;
  } = {};
  const panels = fakePanels(() => {
    expect(holder.dialogs?.busy()).toBe(true);
    try {
      holder.dialogs?.show("openFile", {}, "backend");
    } catch (error) {
      nested = error;
    }
    throw new BunawayError({
      code: "INTERNAL",
      message: "boom",
    });
  });
  const dialogs = new MacosDialogs(panels.factory);
  holder.dialogs = dialogs;
  expect(() => dialogs.show("openFile", {}, "backend")).toThrow("boom");
  expect(nested).toMatchObject({
    code: "BUSY",
  });
  expect(panels.events).toEqual([
    "create",
    "run",
    "dispose",
  ]);
  expect(dialogs.busy()).toBe(false);
});

test("a disposed adapter refuses new panels and releases the factory", () => {
  const panels = fakePanels([
    "/tmp/a",
  ]);
  const dialogs = new MacosDialogs(panels.factory);
  dialogs.dispose();
  expect(() => dialogs.show("openFile", {}, "backend")).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(panels.events).toEqual([
    "factory-dispose",
  ]);
});

test("a selection beyond the shared result limits fails with an explanation", () => {
  const tooMany = fakePanels(
    Array.from(
      {
        length: 129,
      },
      (_, index) => `/tmp/${index}`,
    ),
  );
  expect(() =>
    new MacosDialogs(tooMany.factory).show(
      "openFile",
      {
        multiple: true,
      },
      "backend",
    ),
  ).toThrow("Selected path count exceeds the dialog limit.");
  const tooLong = fakePanels([
    "a".repeat(100000),
    "b".repeat(40000),
  ]);
  expect(() =>
    new MacosDialogs(tooLong.factory).show(
      "openFile",
      {
        multiple: true,
      },
      "backend",
    ),
  ).toThrow("Selected paths exceed the dialog result limit.");
  expect(tooMany.events).toEqual([
    "create",
    "run",
    "dispose",
  ]);
});
