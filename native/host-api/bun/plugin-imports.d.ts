/** The CLI supplies this build-only module from its app-module generator. */
declare module "bunaway:plugin-imports" {
  export const pluginImports: import("./plugin-contract.ts").PluginImports;
}
