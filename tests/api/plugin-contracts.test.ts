import { expect, test } from "bun:test";
import { validateAutostartInput } from "#plugins/autostart/src/contract";
import { validateClipboardInput } from "#plugins/clipboard/src/contract";
import { validateOpenerInput } from "#plugins/opener/src/contract";

test("native contract validators reject unknown operations and invalid input without OS resources", () => {
  for (const [validate, operation] of [
    [
      validateAutostartInput,
      "autostart.disable",
    ],
    [
      validateClipboardInput,
      "clipboard.clear",
    ],
    [
      validateOpenerInput,
      "opener.openFile",
    ],
  ] as const) {
    expect(() => validate("unknown.operation", null)).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
    expect(() =>
      validate(operation, {
        extra: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  expect(validateAutostartInput("autostart.getStatus", null)).toBeNull();
  expect(validateClipboardInput("clipboard.readText", null)).toBeNull();
  expect(
    validateOpenerInput("opener.openUrl", {
      url: "https://example.com",
    }),
  ).toEqual({
    url: "https://example.com",
  });
  expect(
    validateOpenerInput("opener.revealFile", {
      path: "C:/notes.txt",
    }),
  ).toEqual({
    path: "C:/notes.txt",
  });
  const args = [
    "--login",
  ];
  const snapshot = validateAutostartInput("autostart.enable", {
    args,
  });
  args.push("--changed");
  expect(snapshot).toEqual({
    args: [
      "--login",
    ],
  });
  expect(
    validateClipboardInput("clipboard.writeText", {
      text: "한글 😀",
    }),
  ).toEqual({
    text: "한글 😀",
  });
});
