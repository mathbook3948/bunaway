import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { inside } from "./files.ts";

/**
 * Run Bun's plugin bundle while esbuild owns target-aware package-import resolution.
 * Bun 1.4.2 externalizes #imports before resolving them and has no post-remap hook.
 * esbuild resolves the package map before externalizing dependency targets, without
 * requiring those dependencies to expose an entry for this build target.
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
              plugins: [
                {
                  name: "bunaway-plugin-imports",
                  setup(builder) {
                    builder.onResolve(
                      {
                        filter: /^#/,
                      },
                      async ({ path, importer, kind }) => {
                        if (
                          kind !== "import-statement" &&
                          kind !== "dynamic-import" &&
                          kind !== "require-call" &&
                          kind !== "require-resolve"
                        ) {
                          throw new Error(
                            `Unsupported plugin package import kind: ${kind}`,
                          );
                        }
                        const resolved = await resolver.resolve(path, {
                          resolveDir: dirname(importer),
                          kind,
                        });
                        if (resolved.errors.length) {
                          throw new AggregateError(
                            resolved.errors.map(
                              (error) => new Error(error.text),
                            ),
                            `Could not resolve plugin import ${path} from ${importer}.`,
                          );
                        }
                        if (
                          !resolved.external &&
                          inside(resolve(root, "src"), resolved.path)
                        ) {
                          return {
                            path: resolved.path,
                            external: false,
                          };
                        }
                        return {
                          // Preserve the selected package, not an alias that could select
                          // a different branch when the neutral output is inspected in Bun.
                          path: resolved.external ? resolved.path : path,
                          external: true,
                        };
                      },
                    );
                  },
                },
                ...(config.plugins ?? []),
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
