/** The CLI resolves this module to the app's actual generated import file. */
declare module "bunaway:plugin-imports" {
  export const pluginImports: import("./plugin-contract.ts").PluginImports;
}
