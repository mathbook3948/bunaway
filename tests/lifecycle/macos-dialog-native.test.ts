import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alertSettings,
  panelSettings,
} from "#plugins/dialog/src/platforms/macos";
import { createFilePanelFactory } from "#plugins/dialog/src/platforms/macos-bindings";

const native =
  process.platform === "darwin" && process.env.BUNAWAY_DIALOG_NATIVE === "1";
const factory = native ? createFilePanelFactory() : undefined;
const directory = native
  ? realpathSync(mkdtempSync(join(tmpdir(), "bunaway-dialog-")))
  : "";
afterAll(() => {
  factory?.dispose();
  if (directory) {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

function panelOf(...args: Parameters<typeof panelSettings>) {
  if (!factory) {
    throw new Error("The native panel factory is unavailable.");
  }
  return factory.create(panelSettings(...args));
}

test.skipIf(!native)(
  "a real open panel reports the configured file selection back from AppKit",
  () => {
    const panel = panelOf("openFile", {
      multiple: true,
      showHiddenFiles: true,
      title: "Pick 한글",
      defaultDirectory: directory,
      filters: [
        {
          name: "Text",
          extensions: [
            "txt",
            "md",
          ],
        },
      ],
    });
    try {
      const state = panel.readBack();
      expect(state).toMatchObject({
        canChooseFiles: true,
        canChooseDirectories: false,
        multiple: true,
        canCreateDirectories: false,
        showHidden: true,
        title: "Pick 한글",
      });
      expect(realpathSync(state.directory)).toBe(directory);
      expect(state.extensions.sort()).toEqual([
        "md",
        "txt",
      ]);
    } finally {
      panel.dispose();
    }
  },
);

test.skipIf(!native)(
  "a real folder panel chooses directories and a save panel carries the default name",
  () => {
    const folder = panelOf("selectFolder", {});
    try {
      expect(folder.readBack()).toMatchObject({
        canChooseFiles: false,
        canChooseDirectories: true,
        multiple: false,
        canCreateDirectories: true,
        showHidden: false,
        extensions: [],
      });
    } finally {
      folder.dispose();
    }
    const save = panelOf("saveFile", {
      defaultDirectory: directory,
      defaultFileName: "report 한글",
      defaultExtension: "txt",
    });
    try {
      const state = save.readBack();
      expect(state.fileName).toBe("report 한글.txt");
      expect(state.canCreateDirectories).toBe(true);
      expect(realpathSync(state.directory)).toBe(directory);
    } finally {
      save.dispose();
    }
  },
);

test.skipIf(!native)(
  "a real modal panel closes through its cancel action and reports a user cancel",
  () => {
    for (const kind of [
      "openFile",
      "selectFolder",
      "saveFile",
    ] as const) {
      const panel = panelOf(kind, {
        defaultDirectory: directory,
      });
      try {
        panel.scheduleCancel(0.5);
        expect(panel.run()).toBeNull();
      } finally {
        panel.dispose();
      }
    }
  },
);

test.skipIf(!native)(
  "a real alert reports its text, buttons, key equivalents, style and checkbox back from AppKit",
  () => {
    if (!factory) {
      throw new Error("The native panel factory is unavailable.");
    }
    const alert = factory.createAlert(
      alertSettings({
        message: "Save 한글?",
        detail: "Unsaved work is lost.",
        type: "error",
        buttons: [
          "Save",
          "Discard",
          "Cancel",
        ],
        defaultButton: 1,
        cancelButton: 2,
        checkbox: {
          label: "Do not ask again",
          checked: true,
        },
      }),
    );
    try {
      expect(alert.readBack()).toEqual({
        message: "Save 한글?",
        detail: "Unsaved work is lost.",
        style: "critical",
        buttons: [
          "Save",
          "Discard",
          "Cancel",
        ],
        keyEquivalents: [
          "",
          "\r",
          "\u001b",
        ],
        checkbox: {
          label: "Do not ask again",
          checked: true,
        },
      });
    } finally {
      alert.dispose();
    }
  },
);

test.skipIf(!native)(
  "a real alert without buttons leaves the OK button to AppKit",
  () => {
    if (!factory) {
      throw new Error("The native panel factory is unavailable.");
    }
    const alert = factory.createAlert(
      alertSettings({
        message: "Done",
      }),
    );
    try {
      const state = alert.readBack();
      expect(state.buttons).toEqual([]);
      expect(state.checkbox).toBeNull();
    } finally {
      alert.dispose();
    }
  },
);

test.skipIf(!native)(
  "a real modal alert returns the clicked button and the checkbox state",
  () => {
    if (!factory) {
      throw new Error("The native panel factory is unavailable.");
    }
    const alert = factory.createAlert(
      alertSettings({
        message: "Pick",
        buttons: [
          "First",
          "Second",
          "Third",
        ],
        checkbox: {
          label: "Remember",
          checked: true,
        },
      }),
    );
    try {
      alert.scheduleClick(2, 0.5);
      expect(alert.run()).toEqual({
        button: 2,
        checkboxChecked: true,
      });
    } finally {
      alert.dispose();
    }
  },
);
