#!/usr/bin/env bun
// PATH-scoped tool replacements run only inside each distribution test's child process.
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

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
  assert(failure === "dmg", "Unexpected hdiutil replacement");
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
  const path = args.at(-1);
  if (failure === "manifest" && path?.endsWith("/runtime/bun")) {
    const manifest = resolve(dirname(dirname(path)), "manifest.json");
    // Confirm the test reached the real staged manifest before corrupting it.
    await readFile(manifest);
    await writeFile(manifest, "invalid");
  }
}
