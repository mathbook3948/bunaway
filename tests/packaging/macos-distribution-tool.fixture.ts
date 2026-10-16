#!/usr/bin/env bun
// PATH-scoped tool replacements run only inside each distribution test's child process.
import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const tool = basename(process.argv[1] ?? "");
const args = process.argv.slice(2);
const failure = process.env.BUNAWAY_TEST_TOOL_FAILURE;
if (tool === "xcrun") {
  const log = process.env.NOTARY_LOG;
  assert(log, "Missing notary log path");
  await appendFile(log, `${JSON.stringify(args)}\n`);
  if (args[0] === "notarytool") {
    console.log(
      JSON.stringify({
        status: process.env.NOTARY_STATUS ?? "Accepted",
      }),
    );
  } else {
    assert(args[0] === "stapler" && args[2], "Unexpected notary operation");
    const path = args[2];
    if (extname(path) === ".zip" || process.env.FAIL_STAPLE === "1") {
      process.exit(65);
    }
    if (extname(path) === ".app") {
      const ticket = resolve(path, "Contents/Resources/test-ticket");
      if (args[1] === "staple") {
        await writeFile(ticket, "ticket");
      } else if (!(await Bun.file(ticket).exists())) {
        process.exit(65);
      }
    } else if (extname(path) === ".dmg") {
      if (args[1] === "staple") {
        await appendFile(path, "ticket");
      } else if (process.env.FAIL_VALIDATE === "1") {
        process.exit(65);
      }
    }
  }
} else if (tool === "hdiutil") {
  if (failure === "diagnostic") {
    const { diagnoseDmg } = await import("./macos-dmg-diagnostics.fixture.ts");
    await diagnoseDmg(args);
  }
  assert(
    fstatSync(1).isFile() && fstatSync(2).isFile(),
    "hdiutil output must use regular files",
  );
  const isBusyMode =
    failure === "dmg-busy-once" || failure === "dmg-busy-always";
  assert(failure === "dmg" || isBusyMode, "Unexpected hdiutil replacement");
  // The invocation count lives outside the packaging scratch directory, which tests require to end empty.
  const statePath = process.env.BUNAWAY_TEST_TOOL_STATE;
  assert(statePath, "Missing hdiutil state path");
  await appendFile(statePath, "x");
  const invocation = (await Bun.file(statePath).text()).length;
  const artifact = args[args.length - 1];
  assert(artifact, "Missing hdiutil artifact path");
  if (isBusyMode) {
    if (failure === "dmg-busy-once" && invocation > 1) {
      // The packager must remove the partial image left by the busy attempt.
      assert(
        !(await Bun.file(artifact).exists()),
        "Partial DMG was not removed before retry",
      );
      await writeFile(artifact, "fixture-dmg");
      process.exit(0);
    }
    await writeFile(artifact, "partial");
    console.error("hdiutil: create failed - Resource busy");
    process.exit(1);
  }
  process.exit(47);
} else if (tool === "mv") {
  if (
    (failure === "final-rename" && args[0]?.endsWith("/new.app")) ||
    (failure === "backup-rename" && args[1]?.endsWith("/previous.app")) ||
    (failure === "rollback" &&
      [
        "/new.app",
        "/previous.app",
      ].some((name) => args[0]?.endsWith(name)))
  ) {
    process.exit(47);
  }
  const child = Bun.spawn(
    [
      "/bin/mv",
      ...args,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(await child.exited);
} else {
  assert(tool === "codesign", `Unexpected tool: ${tool}`);
  if (failure === "verification" && args[0] === "--verify") {
    process.exit(47);
  }
  const child = Bun.spawn(
    [
      "/usr/bin/codesign",
      ...args,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await child.exited;
  if (code !== 0) {
    process.exit(code);
  }
}
