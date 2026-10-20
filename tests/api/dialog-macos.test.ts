import { expect, test } from "bun:test";
import dialog from "@bunaway/plugin-dialog";
import { BunawayError } from "@bunaway/protocol";
import {
  alertSettings,
  MacosDialogs,
  panelSettings,
} from "#plugins/dialog/src/platforms/macos";
import type {
  AlertAnswer,
  AlertSettings,
  FilePanel,
  FilePanelFactory,
  PanelSettings,
} from "#plugins/dialog/src/platforms/macos-bindings";

/** A panel factory that records the settings and answers `run` with a scripted result. */
function fakePanels(
  answer: string[] | null | (() => string[] | null),
  alertAnswer: AlertAnswer | (() => AlertAnswer) = {
    button: 0,
    checkboxChecked: false,
  },
) {
  const created: PanelSettings[] = [];
  const alerts: AlertSettings[] = [];
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
    createAlert(settings) {
      alerts.push(settings);
      events.push("create");
      return {
        readBack: () => {
          throw new Error("unused");
        },
        run: () => {
          events.push("run");
          return typeof alertAnswer === "function"
            ? alertAnswer()
            : alertAnswer;
        },
        dispose: () => {
          events.push("dispose");
        },
      };
    },
    dispose: () => {
      events.push("factory-dispose");
    },
  };
  return {
    factory,
    created,
    alerts,
    events,
  };
}

test("macOS registers every dialog operation and shares the Windows schemas", () => {
  const macos = dialog._definition.nativePlatforms.macos;
  const windows = dialog._definition.nativePlatforms.windows;
  expect(macos?.operations).toEqual([
    "openFile",
    "selectFolder",
    "saveFile",
    "showMessage",
  ]);
  expect(macos?.operations).toEqual(windows?.operations);
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

test("a message maps to buttons, Return and Escape keys, style and checkbox", () => {
  expect(
    alertSettings({
      message: "Delete?",
    }),
  ).toEqual({
    message: "Delete?",
    detail: null,
    style: "informational",
    buttons: [],
    defaultButton: 0,
    cancelButton: undefined,
    checkbox: null,
  });
  expect(
    alertSettings({
      message: "Save changes?",
      detail: "Unsaved work is lost.",
      type: "warning",
      buttons: [
        "Save",
        "Discard",
        "Cancel",
      ],
      defaultButton: 0,
      cancelButton: 2,
      checkbox: {
        label: "Do not ask again",
      },
    }),
  ).toEqual({
    message: "Save changes?",
    detail: "Unsaved work is lost.",
    style: "warning",
    buttons: [
      "Save",
      "Discard",
      "Cancel",
    ],
    defaultButton: 0,
    cancelButton: 2,
    checkbox: {
      label: "Do not ask again",
      checked: false,
    },
  });
});

test("message types choose the alert style", () => {
  const styleOf = (type: "none" | "info" | "warning" | "error" | "question") =>
    alertSettings({
      message: "m",
      type,
    }).style;
  expect(styleOf("none")).toBe("informational");
  expect(styleOf("info")).toBe("informational");
  expect(styleOf("question")).toBe("informational");
  expect(styleOf("warning")).toBe("warning");
  expect(styleOf("error")).toBe("critical");
});

test("the cancel button follows the shared rule and yields Return when it is the default", () => {
  const cancelOf = (
    buttons: string[],
    cancelButton?: number,
    defaultButton?: number,
  ) =>
    alertSettings({
      message: "m",
      buttons,
      cancelButton,
      defaultButton,
    }).cancelButton;
  // Several buttons without a cancel button leave Escape unbound.
  expect(
    cancelOf([
      "a",
      "b",
    ]),
  ).toBeUndefined();
  expect(
    cancelOf(
      [
        "a",
        "b",
      ],
      1,
    ),
  ).toBe(1);
  // A cancel button that is also the default keeps Return only.
  expect(
    cancelOf(
      [
        "a",
        "b",
      ],
      1,
      1,
    ),
  ).toBeUndefined();
  expect(
    cancelOf([
      "a",
    ]),
  ).toBeUndefined();
  expect(
    alertSettings({
      message: "m",
      buttons: [
        "a",
        "b",
      ],
      defaultButton: 1,
    }).defaultButton,
  ).toBe(1);
});

test("a checked checkbox starts checked", () => {
  expect(
    alertSettings({
      message: "m",
      checkbox: {
        label: "x",
        checked: true,
      },
    }).checkbox,
  ).toEqual({
    label: "x",
    checked: true,
  });
});

test("showMessage returns the answer and releases the alert", () => {
  const panels = fakePanels(null, {
    button: 2,
    checkboxChecked: true,
  });
  const dialogs = new MacosDialogs(panels.factory);
  expect(
    dialogs.showMessage(
      {
        message: "m",
        buttons: [
          "a",
          "b",
          "c",
        ],
      },
      "backend",
    ),
  ).toEqual({
    button: 2,
    checkboxChecked: true,
  });
  expect(panels.alerts).toHaveLength(1);
  expect(panels.created).toHaveLength(0);
  expect(panels.events).toEqual([
    "create",
    "run",
    "dispose",
  ]);
  expect(dialogs.busy()).toBe(false);
});

test("showMessage honors a recorded abort before and after the alert", () => {
  const before = new AbortController();
  before.abort();
  const unopened = fakePanels(null);
  expect(() =>
    new MacosDialogs(unopened.factory).showMessage(
      {
        message: "m",
      },
      "backend",
      before.signal,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(unopened.events).toEqual([]);

  const during = new AbortController();
  const opened = fakePanels(null, () => {
    during.abort();
    return {
      button: 0,
      checkboxChecked: false,
    };
  });
  const dialogs = new MacosDialogs(opened.factory);
  expect(() =>
    dialogs.showMessage(
      {
        message: "m",
      },
      "backend",
      during.signal,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(opened.events).toEqual([
    "create",
    "run",
    "dispose",
  ]);
  expect(dialogs.busy()).toBe(false);
});

test("a message during a panel is BUSY and a failing alert releases the busy state", () => {
  const holder: {
    dialogs?: MacosDialogs;
  } = {};
  let nested: unknown;
  const panels = fakePanels(
    () => {
      try {
        holder.dialogs?.showMessage(
          {
            message: "m",
          },
          "backend",
        );
      } catch (error) {
        nested = error;
      }
      return null;
    },
    () => {
      throw new BunawayError({
        code: "INTERNAL",
        message: "boom",
      });
    },
  );
  const dialogs = new MacosDialogs(panels.factory);
  holder.dialogs = dialogs;
  dialogs.show("openFile", {}, "backend");
  expect(nested).toMatchObject({
    code: "BUSY",
  });
  expect(() =>
    dialogs.showMessage(
      {
        message: "m",
      },
      "backend",
    ),
  ).toThrow("boom");
  expect(panels.events.slice(-3)).toEqual([
    "create",
    "run",
    "dispose",
  ]);
  expect(dialogs.busy()).toBe(false);
});
