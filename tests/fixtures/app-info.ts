import type { AppInfo } from "@bunaway/core";
import type { AppMetadata } from "@bunaway/runtime-bun/app-metadata";

/** Host-known app facts shared by tests that start a Core or process runtime. */
export const testAppMetadata: AppMetadata = {
  name: "Bunaway Test",
  identifier: "dev.bunaway.test",
  version: "1.2.3",
  framework: "0.4.5",
};

/** Complete `ctx.app` value for tests that call `createCore` directly. */
export const testAppInfo: AppInfo = {
  name: testAppMetadata.name,
  identifier: testAppMetadata.identifier,
  version: testAppMetadata.version,
  runtime: {
    framework: testAppMetadata.framework,
    bun: Bun.version,
    webview: null,
  },
};

/** Default export lets generated-module resolvers point at this file. */
export default testAppMetadata;
