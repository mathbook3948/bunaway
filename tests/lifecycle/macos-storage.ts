import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import { MacosStorage } from "../../plugins/storage/src/platforms/macos.ts";

const mode = process.argv[2];
const pathArgument = process.argv[3];
const compiled = import.meta.path.startsWith("/$bunfs/");
const command = (...args: string[]) =>
  compiled
    ? [
        process.execPath,
        ...args,
      ]
    : [
        process.execPath,
        "--no-env-file",
        import.meta.path,
        ...args,
      ];

function expectCode(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error) => error instanceof BunawayError && error.code === code,
  );
}

/** A real competing process replaces a parent or leaf with an outside symlink. */
function runRacer(root: string, kind: string): void {
  const slot = `${root}/slot`;
  const parked = `${root}/parked`;
  const outside = `${root}/outside`;
  const candidate = kind === "parent" ? slot : `${slot}/target`;
  const saved = kind === "parent" ? parked : `${slot}/parked`;
  const destination = kind === "parent" ? outside : `${outside}/target`;
  writeFileSync(`${root}/ready.new`, "ready");
  renameSync(`${root}/ready.new`, `${root}/ready`);
  let swaps = 0;
  while (!existsSync(`${root}/stop`)) {
    if (kind === "leaf") {
      // Atomic replacements avoid a missing-name window in which O_CREAT
      // could create a fresh file and make the racer's symlink fail.
      symlinkSync(destination, saved);
      renameSync(saved, candidate);
      writeFileSync(saved, "inside");
      renameSync(saved, candidate);
    } else {
      renameSync(candidate, saved);
      symlinkSync(destination, candidate);
      unlinkSync(candidate);
      renameSync(saved, candidate);
    }
    swaps++;
  }
  console.log(
    JSON.stringify({
      swaps,
    }),
  );
}

if (process.platform !== "darwin") {
  throw new Error("This fixture requires real macOS.");
}
if (mode === "racer") {
  assert(pathArgument);
  runRacer(pathArgument, process.argv[4] ?? "parent");
} else if (mode === "verify") {
  assert(pathArgument);
  const storage = new MacosStorage();
  try {
    assert.equal(
      storage.execute("storage.readText", {
        path: `${pathArgument}/restart.txt`,
      }),
      "restart 한글\0✓",
    );
    assert.equal(
      storage.execute("storage.readBytes", {
        path: `${pathArgument}/restart.bin`,
      }),
      "AP+A",
    );
  } finally {
    storage.dispose();
  }
} else {
  const root = realpathSync(
    mkdtempSync(resolve(tmpdir(), "bunaway-macos-storage-")),
  );
  const storage = new MacosStorage();
  const call = (operation: string, path: string, text?: string) =>
    storage.execute(
      operation,
      text === undefined
        ? {
            path,
          }
        : {
            path,
            text,
          },
    );
  const bytes = (operation: string, path: string, value: Buffer) =>
    storage.execute(operation, {
      path,
      bytes: value.toString("base64"),
    });
  const transfer = (operation: string, from: string, to: string) =>
    storage.execute(operation, {
      from,
      to,
    });
  const results: string[] = [];
  try {
    const other = new MacosStorage();
    other.dispose();
    other.dispose();
    expectCode(
      () =>
        other.execute("storage.exists", {
          path: `${root}/missing`,
        }),
      "CANCELLED",
    );
    assert.equal(call("storage.exists", `${root}/absent/leaf`), false);
    assert.equal(call("storage.stat", `${root}/absent/leaf`), null);
    assert.equal(existsSync(`${root}/absent`), false);

    const textPath = `${root}/한글 memo/current.txt`;
    assert.equal(
      call("storage.writeText", textPath, "\uFEFFhello 한글\0✓"),
      null,
    );
    assert.equal(call("storage.readText", textPath), "\uFEFFhello 한글\0✓");
    call("storage.writeText", textPath, "short");
    assert.equal(call("storage.readText", textPath), "short");
    call("storage.appendText", textPath, "\0tail");
    assert.equal(call("storage.readText", textPath), "short\0tail");
    call("storage.writeText", textPath, "");
    assert.equal(statSync(textPath).size, 0);
    call("storage.appendText", `${root}/empty.txt`, "");
    assert.equal(statSync(`${root}/empty.txt`).size, 0);
    assert.equal(statSync(textPath).mode & 0o777, 0o600);
    assert.equal(statSync(`${root}/한글 memo`).mode & 0o777, 0o700);
    results.push(
      "text, Unicode, BOM, NUL, truncation, append, empty creation and private modes",
    );

    const arbitrary = Buffer.from([
      0,
      255,
      128,
      1,
    ]);
    bytes("storage.writeBytes", `${root}/bytes.bin`, arbitrary);
    assert.equal(
      call("storage.readBytes", `${root}/bytes.bin`),
      arbitrary.toString("base64"),
    );
    bytes("storage.appendBytes", `${root}/bytes.bin`, arbitrary);
    assert.equal(
      call("storage.readBytes", `${root}/bytes.bin`),
      Buffer.concat([
        arbitrary,
        arbitrary,
      ]).toString("base64"),
    );
    bytes("storage.writeBytes", `${root}/bytes.bin`, Buffer.alloc(0));
    assert.equal(call("storage.readBytes", `${root}/bytes.bin`), "");
    writeFileSync(
      `${root}/bad-utf8`,
      Buffer.from([
        0xff,
      ]),
    );
    assert.throws(() => call("storage.readText", `${root}/bad-utf8`));
    const bound = Buffer.alloc(256 * 1024, 0xa5);
    bytes("storage.writeBytes", `${root}/bound`, bound);
    assert.equal(
      call("storage.readBytes", `${root}/bound`),
      bound.toString("base64"),
    );
    bytes(
      "storage.appendBytes",
      `${root}/bound`,
      Buffer.from([
        0,
      ]),
    );
    assert.throws(() => call("storage.readBytes", `${root}/bound`));
    results.push(
      "arbitrary bytes, canonical base64, strict UTF-8 and binary read bound",
    );

    const nativeInfo = statSync(textPath);
    const info = call("storage.stat", textPath);
    assert(info && typeof info === "object" && !Array.isArray(info));
    assert.equal(info.kind, "file");
    assert.equal(info.sizeBytes, nativeInfo.size);
    assert.equal(info.modifiedAtMs, Math.trunc(nativeInfo.mtimeMs));
    assert.equal(info.createdAtMs, Math.trunc(nativeInfo.birthtimeMs));
    const dirInfo = call("storage.stat", `${root}/한글 memo`);
    assert(dirInfo && typeof dirInfo === "object" && !Array.isArray(dirInfo));
    assert.equal(dirInfo.kind, "directory");
    assert.equal(dirInfo.sizeBytes, null);
    expectCode(
      () => call("storage.readText", `${root}/한글 memo`),
      "PERMISSION_DENIED",
    );
    expectCode(
      () => call("storage.readText", `${root}/absent`),
      "INVALID_ARGUMENT",
    );
    results.push(
      "native metadata, file and directory kinds, absent versus denied",
    );

    for (const invalid of [
      "relative",
      "/",
      `${root}/../bad`,
      `${root}/./bad`,
      `${root}//bad`,
      `${root}/bad/`,
      `${root}/nul\0`,
      `${root}/line\n`,
      `${root}/\uD800`,
      `${root}/${"a".repeat(256)}`,
    ]) {
      expectCode(() => call("storage.exists", invalid), "INVALID_ARGUMENT");
    }
    symlinkSync(textPath, `${root}/symlink`);
    symlinkSync(`${root}/missing`, `${root}/dangling`);
    symlinkSync(`${root}/한글 memo`, `${root}/parent-link`);
    linkSync(textPath, `${root}/hardlink`);
    for (const linked of [
      `${root}/symlink`,
      `${root}/dangling`,
      `${root}/hardlink`,
      textPath,
      `${root}/parent-link/current.txt`,
    ]) {
      for (const operation of [
        "storage.exists",
        "storage.stat",
        "storage.readText",
        "storage.writeText",
        "storage.appendText",
      ]) {
        expectCode(
          () =>
            call(
              operation,
              linked,
              operation.includes("Text") ? "unchanged" : undefined,
            ),
          "PERMISSION_DENIED",
        );
      }
    }
    assert.equal(readFileSync(textPath).length, 0);
    unlinkSync(`${root}/hardlink`);
    execFileSync("/usr/bin/mkfifo", [
      `${root}/fifo`,
    ]);
    expectCode(() => call("storage.stat", `${root}/fifo`), "PERMISSION_DENIED");
    for (const operation of [
      "storage.writeText",
      "storage.appendText",
    ]) {
      expectCode(
        () => call(operation, `${root}/fifo`, "blocked"),
        "PERMISSION_DENIED",
      );
    }
    for (const operation of [
      "storage.writeBytes",
      "storage.appendBytes",
    ]) {
      expectCode(
        () => bytes(operation, `${root}/fifo`, arbitrary),
        "PERMISSION_DENIED",
      );
    }
    // O_NONBLOCK ensures inspecting a FIFO does not wait for another process.
    results.push(
      "path aliases, symlink parents and leaves, dangling links, hardlinks and FIFO rejection",
    );

    const denied = `${root}/denied`;
    writeFileSync(denied, "private");
    chmodSync(denied, 0);
    try {
      for (const operation of [
        "storage.exists",
        "storage.stat",
        "storage.readText",
        "storage.writeText",
      ]) {
        expectCode(
          () => call(operation, denied, "blocked"),
          "PERMISSION_DENIED",
        );
      }
    } finally {
      chmodSync(denied, 0o600);
    }
    assert.equal(readFileSync(denied, "utf8"), "private");
    results.push("OS permission denial preserves existing data");

    const source = `${root}/source`;
    const copy = `${root}/copy`;
    const large = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < large.length; i++) {
      large[i] = i % 251;
    }
    writeFileSync(source, large);
    assert.equal(transfer("storage.copyFile", source, copy), null);
    assert.deepEqual(readFileSync(copy), large);
    assert.deepEqual(readFileSync(source), large);
    writeFileSync(`${root}/too-large`, Buffer.alloc(large.length + 1));
    expectCode(
      () =>
        transfer(
          "storage.copyFile",
          `${root}/too-large`,
          `${root}/not-created`,
        ),
      "INVALID_ARGUMENT",
    );
    assert.equal(existsSync(`${root}/not-created`), false);
    for (const target of [
      copy,
      `${root}/symlink`,
      `${root}/dangling`,
      `${root}/한글 memo`,
    ]) {
      expectCode(
        () => transfer("storage.copyFile", source, target),
        "INVALID_ARGUMENT",
      );
      expectCode(() => transfer("storage.move", source, target), "UNSUPPORTED");
    }
    assert.deepEqual(readFileSync(copy), large);
    expectCode(
      () =>
        transfer("storage.copyFile", source, `${root}/missing-parent/target`),
      "INVALID_ARGUMENT",
    );
    assert.equal(existsSync(`${root}/missing-parent`), false);
    assert.equal(
      transfer("storage.copyFile", `${root}/empty.txt`, `${root}/empty-copy`),
      null,
    );
    assert.equal(statSync(`${root}/empty-copy`).size, 0);
    expectCode(
      () => transfer("storage.move", copy, `${root}/moved`),
      "UNSUPPORTED",
    );
    assert.deepEqual(readFileSync(copy), large);
    assert.equal(existsSync(`${root}/moved`), false);
    expectCode(
      () =>
        transfer(
          "storage.move",
          `${root}/한글 memo`,
          `${root}/renamed-directory`,
        ),
      "UNSUPPORTED",
    );
    assert.equal(existsSync(`${root}/한글 memo/current.txt`), true);
    assert.equal(existsSync(`${root}/renamed-directory`), false);
    results.push(
      "bounded multi-chunk and empty copies, atomic no-replace and fail-closed move",
    );

    for (const kind of [
      "parent",
      "leaf",
    ]) {
      const raceRoot = `${root}/race-${kind}`;
      mkdirSync(`${raceRoot}/slot`, {
        recursive: true,
      });
      mkdirSync(`${raceRoot}/outside`);
      writeFileSync(`${raceRoot}/slot/target`, "inside");
      writeFileSync(`${raceRoot}/outside/target`, "outside");
      const racer = Bun.spawn(command("racer", raceRoot, kind), {
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const deadline = performance.now() + 10_000;
        while (!existsSync(`${raceRoot}/ready`)) {
          assert(performance.now() < deadline, "Racer failed to become ready.");
          await Bun.sleep(10);
        }
        for (let i = 0; i < 500; i++) {
          try {
            if (kind === "parent") {
              assert.equal(
                call("storage.readText", `${raceRoot}/slot/target`),
                "inside",
              );
            } else {
              call("storage.writeText", `${raceRoot}/slot/target`, "inside");
            }
          } catch (error) {
            assert(
              error instanceof BunawayError &&
                [
                  "PERMISSION_DENIED",
                  "INVALID_ARGUMENT",
                ].includes(error.code),
            );
          }
        }
        writeFileSync(`${raceRoot}/stop`, "stop");
        assert.equal(
          await racer.exited,
          0,
          await new Response(racer.stderr).text(),
        );
        const report = JSON.parse(await new Response(racer.stdout).text());
        assert(report.swaps > 0, "Racer did not replace any paths.");
        assert.equal(
          readFileSync(`${raceRoot}/outside/target`, "utf8"),
          "outside",
        );
      } finally {
        racer.kill();
        await racer.exited;
      }
    }
    results.push(
      "real competing-process parent and leaf replacement never modifies symlink referents",
    );

    call("storage.writeText", `${root}/restart.txt`, "restart 한글\0✓");
    bytes(
      "storage.writeBytes",
      `${root}/restart.bin`,
      Buffer.from([
        0,
        255,
        128,
      ]),
    );
    storage.dispose();
    const verified = Bun.spawn(command("verify", root), {
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(
      await verified.exited,
      0,
      await new Response(verified.stderr).text(),
    );
    results.push(
      "storage persists through adapter disposal and independent process restart",
    );
    const final = new MacosStorage();
    try {
      final.execute("storage.exists", {
        path: source,
      });
      const before = readdirSync("/dev/fd").length;
      for (let i = 0; i < 300; i++) {
        final.execute("storage.exists", {
          path: source,
        });
        expectCode(
          () =>
            final.execute("storage.stat", {
              path: `${root}/symlink`,
            }),
          "PERMISSION_DENIED",
        );
      }
      assert(
        readdirSync("/dev/fd").length <= before + 2,
        "Storage descriptors leaked.",
      );
    } finally {
      final.dispose();
    }
    results.push(
      "multiple adapters, repeated disposal, descriptor cleanup after success and denial",
    );
    mkdirSync(resolve("build"), {
      recursive: true,
    });
    await Bun.write(
      resolve("build/macos-storage-results.json"),
      `${JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          bun: Bun.version,
          revision: Bun.revision,
          compiled,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `macOS storage: ${results.length} native scenarios passed (${compiled ? "signed compiled" : "source"}).`,
    );
  } finally {
    storage.dispose();
    chmodSync(root, 0o700);
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
