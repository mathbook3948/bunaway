import assert from "node:assert/strict";
import { resolve } from "node:path";
import { acquireBuildOutputLock } from "@bunaway/packaging";

const root = process.argv[2];
const mode = process.argv[3];
assert(root && mode);
const args = process.argv.slice(4);
const appId = "dev.bunaway.fixture.debug";
// A separate tool process must see the lock during every install and launcher stage.
await assert.rejects(acquireBuildOutputLock(root, "android"), /locked/);
if (args.includes("install")) {
  const manifest = await Bun.file(
    resolve(root, "dist/android/manifest.json"),
  ).json();
  assert.equal(manifest.appId, appId);
  if (mode === "cancel") {
    await Bun.write(resolve(root, "adb-ready"), "ready");
    await Bun.sleep(60000);
  }
  if (mode === "install-failure") {
    throw new Error("install fixture failure");
  }
  console.log("Success");
} else if (args.includes("force-stop")) {
  assert.equal(args.at(-1), appId);
} else if (args.includes("resolve-activity")) {
  assert.equal(args.at(-1), appId);
  console.log(`${appId}/dev.bunaway.app.MainActivity`);
} else {
  assert(args.includes("start"));
  assert.equal(args.at(-1), `${appId}/dev.bunaway.app.MainActivity`);
  console.log(
    mode === "launch-failure" ? "Error: launch fixture failure" : "Status: ok",
  );
}
