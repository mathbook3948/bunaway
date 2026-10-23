import { expect, test } from "bun:test";
import { BunawayError } from "@bunaway/plugin";
import { macosUserHome } from "@bunaway/plugin/macos-home";

const APP_ID = "dev.example.app";

function layout(home: string, appId = APP_ID): string {
  return `${home}/Library/Application Support/bunaway/${appId}`;
}

function rejected(dataRoot: string): void {
  try {
    macosUserHome(dataRoot, APP_ID);
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    expect((error as BunawayError).code).toBe("INTERNAL");
    return;
  }
  throw new Error("expected macosUserHome to throw");
}

test("the home is the data root without the fixed app layout", () => {
  expect(macosUserHome(layout("/Users/alice"), APP_ID)).toBe("/Users/alice");
  const container = "/Users/alice/Library/Containers/dev.example.app/Data";
  expect(macosUserHome(layout(container), APP_ID)).toBe(container);
});

test("a data root outside the layout or for another app is rejected", () => {
  rejected("/Users/alice/elsewhere");
  rejected(layout("/Users/alice", "dev.other.app"));
});

test("a derived home must be a bounded absolute path without line breaks or NUL", () => {
  rejected("Library/Application Support/bunaway/dev.example.app");
  rejected(layout("relative/home"));
  rejected(layout(""));
  rejected(layout("/Users/al\nice"));
  rejected(layout("/Users/al\rice"));
  rejected(layout("/Users/al\0ice"));
  rejected(layout(`/${"a".repeat(4096)}`));
  const longest = `/${"a".repeat(4095)}`;
  expect(macosUserHome(layout(longest), APP_ID)).toBe(longest);
});
