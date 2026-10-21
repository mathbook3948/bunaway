import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PLUGIN_SETTINGS_MAX_BYTES,
  parsePluginSettings,
} from "@bunaway/runtime-bun/app-metadata";
import { readProjectSettings, runtimeSettings } from "#cli/config";
import { writeJson } from "#cli/files";

test("plugin settings must be an object of objects for installed plugins", () => {
  const installed = new Set([
    "updater",
  ]);
  const clause = {
    updater: {
      endpoint: "https://updates.example.com/",
    },
  };
  expect(parsePluginSettings(clause, installed)).toEqual(clause);
  expect(parsePluginSettings({})).toEqual({});
  for (const value of [
    null,
    [],
    "updater",
    {
      updater: null,
    },
    {
      updater: [],
    },
    {
      updater: "https://updates.example.com/",
    },
  ]) {
    expect(() => parsePluginSettings(value)).toThrow();
  }
  expect(() =>
    parsePluginSettings(
      {
        other: {},
      },
      installed,
    ),
  ).toThrow("plugins.other: no installed plugin has this name");
});

test("plugin settings are limited to a total serialized size", () => {
  const fits = {
    updater: {
      pad: "x".repeat(PLUGIN_SETTINGS_MAX_BYTES - 22),
    },
  };
  expect(() => parsePluginSettings(fits)).not.toThrow();
  expect(() =>
    parsePluginSettings({
      updater: {
        pad: "x".repeat(PLUGIN_SETTINGS_MAX_BYTES),
      },
    }),
  ).toThrow("at most");
  // The limit counts bytes, not UTF-16 code units.
  expect(() =>
    parsePluginSettings({
      updater: {
        pad: "한".repeat(PLUGIN_SETTINGS_MAX_BYTES / 3),
      },
    }),
  ).toThrow("at most");
});

test("bunaway.json accepts a plugins section and runtimeSettings forwards it as app.pluginSettings", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-plugin-settings-"));
  try {
    await mkdir(resolve(root, "src-bunaway"));
    const plugins = {
      updater: {
        endpoint: "https://updates.example.com/{{target}}",
      },
    };
    await writeJson(resolve(root, "src-bunaway/bunaway.json"), {
      version: 1,
      build: {
        app: "src-bunaway/app.ts",
        frontend: "dist",
      },
      app: {},
      plugins,
    });
    expect((await readProjectSettings(root)).plugins).toEqual(plugins);
    const project = {
      app: {
        appId: "com.example.app",
        title: "Example",
      },
      policy: {
        version: 1,
        views: [],
      },
      pluginSettings: plugins,
    } as unknown as Parameters<typeof runtimeSettings>[0];
    expect(runtimeSettings(project).app).toMatchObject({
      pluginSettings: plugins,
    });
    expect(
      "pluginSettings" in
        runtimeSettings({
          ...project,
          pluginSettings: undefined as never,
        }).app,
    ).toBe(false);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
