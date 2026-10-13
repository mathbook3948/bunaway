import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import { defineNativePlugin } from "@bunaway/plugin";
import { safeStorageOperations } from "../../../plugins/safe-storage/src/contract.ts";
import { MacosKeychain } from "../../../plugins/safe-storage/src/macos-keychain.ts";
import { createOperations } from "../../../plugins/safe-storage/src/platforms/macos.ts";
import { keychainFixture } from "../../lifecycle/fixtures/macos-keychain.ts";

/** Production factory and schemas with only the Keychain location isolated for native host tests. */
export const fixturePlugin = defineNativePlugin({
  name: "safe-storage",
  operations: safeStorageOperations,
  platforms: {
    macos: {
      execution: "io",
      create(environment) {
        assert.equal(isMainThread, false);
        assert.equal(environment.app?.id, "tests.macos.safe-storage");
        assert.equal(
          environment.app?.launch.executablePath,
          realpathSync(process.execPath),
        );
        const temporary = resolve(environment.dataRoot, "temp");
        const path = resolve(temporary, "synthetic.keychain");
        writeFileSync(
          resolve(temporary, "trusted-app.json"),
          JSON.stringify(environment.app),
        );
        return createOperations(environment, (appId) => {
          const fixture = keychainFixture();
          let provider: MacosKeychain;
          try {
            const reference =
              existsSync(path) || existsSync(`${path}-db`)
                ? fixture.open(path)
                : fixture.create(path);
            provider = new MacosKeychain(appId, reference);
          } catch (error) {
            fixture.dispose(false);
            throw error;
          }
          return {
            available: () => provider.available(),
            read: () => provider.read(),
            add: (key) => provider.add(key),
            dispose() {
              try {
                provider.dispose();
              } finally {
                fixture.dispose(false);
              }
              if (existsSync(resolve(temporary, "backend-report.json"))) {
                assert(
                  existsSync(resolve(temporary, "core-cleaned")),
                  "Core cleanup must precede adapter disposal",
                );
              }
              writeFileSync(resolve(temporary, "native-cleaned"), "done");
            },
          };
        });
      },
    },
  },
});

export default fixturePlugin.definition;
