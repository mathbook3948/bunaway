import { expect, test } from "bun:test";
import {
  createPackageQueries,
  isManagedByStore,
} from "#plugins/updater/src/platforms/windows-package-identity";

const windowsOnly = process.platform === "win32" ? test : test.skip;

/**
 * Real kernel32 calls. The test process is a plain executable without package identity, so the
 * package query must report no package and the updater must not treat the install as managed.
 */
windowsOnly("an unpackaged process is not managed by the Store", () => {
  const queries = createPackageQueries();
  expect(queries.packagePath()).toBeNull();
  expect(isManagedByStore(queries)).toBe(false);
});
