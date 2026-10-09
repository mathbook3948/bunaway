import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type NativePluginContract,
  NativeRegistry,
  validateValue,
} from "@bunaway/protocol";

/** Installed Windows plugin data. Executable imports live in a separate generated module. */
export type ManifestPlugin = {
  name: string;
  version: string;
  native: NativePluginContract;
  /** Worker owning the adapter; omitted when Windows has no implementation. */
  execution?: "io" | "ui";
  /** Whether a resource-scope matcher is available; this does not grant permission. */
  authorization: boolean;
};

const manifestSchema = {
  type: "object",
  properties: {
    format: {
      const: 1,
    },
    app: {
      type: "object",
    },
    policy: {
      type: "object",
    },
    plugins: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
          version: {
            type: "string",
          },
          native: {
            type: "object",
          },
          execution: {
            enum: [
              "io",
              "ui",
            ],
          },
          authorization: {
            type: "boolean",
          },
        },
        required: [
          "name",
          "version",
          "native",
          "authorization",
        ],
        additionalProperties: false,
      },
    },
    developmentSdk: {
      type: "object",
    },
  },
  required: [
    "format",
    "app",
    "policy",
    "plugins",
    "developmentSdk",
  ],
  additionalProperties: false,
} as const;

/** App-specific generated data, separate from the final package's file hashes. */
export type AppManifest = {
  format: 1;
  app: Record<string, unknown>;
  policy: Record<string, unknown>;
  plugins: ManifestPlugin[];
  developmentSdk: Record<string, string>;
};

/** Validate generated data before use; app settings and policy retain their host validators. */
export function parseAppManifest(value: unknown): AppManifest {
  if (
    !value ||
    typeof value !== "object" ||
    !("plugins" in value) ||
    !Array.isArray(value.plugins)
  ) {
    throw new Error("Invalid app manifest.");
  }
  // Installed catalogs have no aggregate wire-message budget; validate each plugin separately.
  const manifest = validateValue(manifestSchema, {
    ...value,
    plugins: [],
  });
  // Metadata must not consume the native contract's existing byte or depth budget.
  const pluginSchema = manifestSchema.properties.plugins.items;
  const plugins = value.plugins.map((plugin: unknown) => {
    if (
      !plugin ||
      typeof plugin !== "object" ||
      Array.isArray(plugin) ||
      !("native" in plugin)
    ) {
      throw new Error("Invalid manifest plugin.");
    }
    const metadata = validateValue(pluginSchema, {
      ...plugin,
      native: {},
    });
    return {
      ...metadata,
      // NativeRegistry below validates this detached contract before it can be returned.
      native: validateValue(
        pluginSchema.properties.native,
        plugin.native,
      ) as unknown as NativePluginContract,
    };
  });
  // NativeRegistry validates the nested native contracts, including schemas and duplicate names.
  new NativeRegistry(plugins, {
    mode: "catalog",
  });
  const developmentSdk = Object.fromEntries(
    Object.entries(manifest.developmentSdk).map(([name, entry]) => {
      if (typeof entry !== "string" || !/^sdk[0-9]+\.(?:js|cjs)$/.test(entry)) {
        throw new Error("Invalid development SDK inventory.");
      }
      return [
        name,
        entry,
      ];
    }),
  );
  return {
    ...manifest,
    plugins,
    developmentSdk,
  };
}

/** Read the execution manifest from development assets or the compiled executable. */
export async function readAppManifest(assets: string): Promise<AppManifest> {
  return parseAppManifest(
    JSON.parse(await readFile(resolve(assets, "manifest.json"), "utf8")),
  );
}
