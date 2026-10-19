import { dirname, isAbsolute, resolve } from "node:path";
import { build, type PluginBuild } from "esbuild";
import { inside } from "./files.ts";

type PackageImportKind =
  | "import-statement"
  | "dynamic-import"
  | "require-call"
  | "require-resolve";

function isPackageImportKind(kind: string): kind is PackageImportKind {
  return (
    kind === "import-statement" ||
    kind === "dynamic-import" ||
    kind === "require-call" ||
    kind === "require-resolve"
  );
}

/**
 * Decide whether Bun keeps resolving an import or it becomes an external package import.
 * Local files and project-internal `#imports` stay with Bun; dependency targets are externalized.
 */
async function externalizePackageImport(
  resolver: PluginBuild,
  root: string,
  {
    path,
    importer,
    kind,
  }: {
    path: string;
    importer: string;
    kind: string;
  },
): Promise<
  | {
      path: string;
      external: true;
    }
  | undefined
> {
  // Windows entrypoints start with a drive letter, not a slash.
  if (isAbsolute(path)) {
    return;
  }
  if (!isPackageImportKind(kind)) {
    throw new Error(`Unsupported plugin package import kind: ${kind}`);
  }
  const resolved = await resolver.resolve(path, {
    resolveDir: dirname(importer),
    kind,
  });
  if (resolved.errors.length) {
    throw new AggregateError(
      resolved.errors.map((error) => new Error(error.text)),
      `Could not resolve plugin import ${path} from ${importer}.`,
    );
  }
  if (
    !resolved.external &&
    (!path.startsWith("#") || inside(resolve(root, "src"), resolved.path))
  ) {
    // Let Bun apply its complete local resolver, including browser
    // remaps. Returning an absolute file would bypass that step.
    return;
  }
  return {
    // Preserve the selected package, not an alias that could select
    // a different branch when the neutral output is inspected in Bun.
    path: resolved.external ? resolved.path : path,
    external: true,
  };
}

/**
 * Run Bun's plugin bundle while esbuild identifies external package-import targets.
 * Bun 1.4.2 externalizes #imports before resolving them and has no post-remap hook.
 * esbuild resolves the package map before externalizing dependency targets, without
 * requiring those dependencies to expose an entry for this build target. Bun owns
 * local resolution, including browser replacements and disabled modules.
 */
export async function buildPluginBundle(
  root: string,
  config: Bun.BuildConfig & {
    target: "browser" | "bun";
  },
): Promise<Bun.BuildOutput> {
  let output: Bun.BuildOutput | undefined;
  await build({
    stdin: {
      contents: "",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    logLevel: "silent",
    platform: config.target === "bun" ? "node" : "browser",
    // Match Bun 1.4.2's defaults, including its browser-only module condition.
    // NODE_ENV=production disables development; Bun does not add production here.
    conditions: [
      ...(config.target === "bun"
        ? [
            "bun",
          ]
        : [
            "module",
          ]),
      ...(process.env.NODE_ENV === "production"
        ? []
        : [
            "development",
          ]),
    ],
    packages: "external",
    plugins: [
      {
        name: "bunaway-plugin-import-resolver",
        setup(resolver) {
          // The resolver stays alive until Bun finishes; esbuild emits no product code.
          resolver.onStart(async () => {
            output = await Bun.build({
              ...config,
              // Externalize dependencies below, after resolving package maps. Bun must
              // retain local imports so its browser remaps and disabled modules still run.
              packages: "bundle",
              plugins: [
                ...(config.plugins ?? []),
                {
                  name: "bunaway-plugin-imports",
                  setup(builder) {
                    builder.onResolve(
                      {
                        filter: /^[^./]/,
                      },
                      (args) => externalizePackageImport(resolver, root, args),
                    );
                  },
                },
              ],
            });
          });
        },
      },
    ],
  });
  if (!output) {
    throw new Error("Native plugin import resolver did not run.");
  }
  return output;
}
