/**
 * Child process of `windows-trash-limits.test.ts`: call `opener.trashFile` once on the path in
 * argv and print `ok` or the error code. The shell caches Recycle Bin settings for the life of a
 * process, so the test runs every call in a fresh process and never changes how later tests see
 * the bin.
 */
import createOperationsDefinition from "#plugins/opener/src/index";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

const [root, path] = process.argv.slice(2);
if (!root || !path) {
  throw new Error("Expected a data root and a file path.");
}
const adapter = createOperationsFactory(
  createOperationsDefinition,
  "windows",
)({
  dataRoot: root,
  capabilities: [],
});
try {
  await adapter.execute(
    "opener.trashFile",
    {
      path,
    },
    "backend",
  );
  console.log("ok");
} catch (error) {
  console.log(
    error instanceof Error && "code" in error ? String(error.code) : "unknown",
  );
} finally {
  await adapter.dispose();
}
