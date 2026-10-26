import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";
import { waitFor } from "../fixtures/deadlines.ts";
import { attachVirtualDisk } from "../fixtures/windows-virtual-disk.ts";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wcv-${crypto.randomUUID().slice(0, 8)}`,
);
const home = `${root}/home`;
const volume = `${root}/volume`;
const storage = new WindowsStorage();
const transfer = (from: string, to: string) =>
  storage.move({
    from,
    to,
  });

function expectCode(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error) => error instanceof BunawayError && error.code === code,
  );
}

const content = "cross volume payload 한글 🙂";

await mkdir(home, {
  recursive: true,
});
await mkdir(volume);
const disk = attachVirtualDisk(root, [
  volume,
]);
try {
  if (!disk) {
    assert.ok(
      !process.env.CI,
      "The CI runner must be able to mount a virtual disk.",
    );
    console.log("SKIP cross-volume move: diskpart is not usable here.");
  } else {
    // The mounted folder must be another volume, or the move below would be a plain rename.
    assert.notEqual((await stat(home)).dev, (await stat(volume)).dev);

    // A regular file moves with its content and the source is gone.
    await writeFile(`${home}/한글 file.txt`, content);
    assert.equal(
      transfer(`${home}/한글 file.txt`, `${volume}/한글 moved.txt`),
      null,
    );
    assert.equal(existsSync(`${home}/한글 file.txt`), false);
    assert.equal(await readFile(`${volume}/한글 moved.txt`, "utf8"), content);

    // The same direction back is symmetric.
    assert.equal(
      transfer(`${volume}/한글 moved.txt`, `${home}/back.txt`),
      null,
    );
    assert.equal(existsSync(`${volume}/한글 moved.txt`), false);
    assert.equal(await readFile(`${home}/back.txt`, "utf8"), content);

    // An existing destination is refused before any copy, and neither side changes.
    await writeFile(`${home}/source.txt`, "source");
    await writeFile(`${volume}/existing.txt`, "existing");
    expectCode(
      () => transfer(`${home}/source.txt`, `${volume}/existing.txt`),
      "INVALID_ARGUMENT",
    );
    assert.equal(await readFile(`${home}/source.txt`, "utf8"), "source");
    assert.equal(await readFile(`${volume}/existing.txt`, "utf8"), "existing");

    // A missing source is a target error and creates nothing.
    expectCode(
      () => transfer(`${home}/absent.txt`, `${volume}/absent.txt`),
      "INVALID_ARGUMENT",
    );
    assert.equal(existsSync(`${volume}/absent.txt`), false);

    // A directory stays unsupported across volumes and is left whole.
    await mkdir(`${home}/dir/nested`, {
      recursive: true,
    });
    await writeFile(`${home}/dir/nested/inner.txt`, "inner");
    expectCode(() => transfer(`${home}/dir`, `${volume}/dir`), "UNSUPPORTED");
    assert.equal(
      await readFile(`${home}/dir/nested/inner.txt`, "utf8"),
      "inner",
    );
    assert.equal(existsSync(`${volume}/dir`), false);

    // Links are not followed into a copy; the link and its target stay and nothing is created.
    await writeFile(`${home}/link-target.txt`, "target");
    for (const type of [
      "file",
      "junction",
    ] as const) {
      const target =
        type === "file" ? `${home}/link-target.txt` : `${home}/dir`;
      const link = `${home}/link-${type}`;
      try {
        await symlink(target, link, type);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          console.log(`SKIP ${type} link: creation is not permitted here.`);
          continue;
        }
        throw error;
      }
      expectCode(() => transfer(link, `${volume}/link-${type}`), "UNSUPPORTED");
      assert.equal(existsSync(`${volume}/link-${type}`), false);
      assert.equal((await stat(target)).isDirectory(), type === "junction");
    }

    // Within one volume a link, a file and a directory still move as before.
    await mkdir(`${home}/same`);
    assert.equal(transfer(`${home}/dir`, `${home}/same/dir`), null);
    assert.equal(
      await readFile(`${home}/same/dir/nested/inner.txt`, "utf8"),
      "inner",
    );

    // A source held open without delete sharing: the copy can succeed but the delete cannot. The
    // move must report failure and keep the source whole. The destination may remain, which the
    // documentation states, so this only records it.
    await writeFile(`${home}/locked.txt`, "locked content");
    const marker = `${home}/locked.ready`;
    const holder = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        `$f=[IO.File]::Open('${home}/locked.txt','Open','Read','Read');[IO.File]::WriteAllText('${marker}','1');Start-Sleep -Seconds 120`,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      await waitFor(() => existsSync(marker), {
        deadline: "childStep",
        what: "the lock holder to open the source",
        failed: () =>
          holder.exitCode === null
            ? undefined
            : new Error(`The lock holder exited with ${holder.exitCode}.`),
      });
      assert.throws(() =>
        transfer(`${home}/locked.txt`, `${volume}/locked.txt`),
      );
      console.log(
        `INFO locked source: destination remained = ${existsSync(`${volume}/locked.txt`)}`,
      );
    } finally {
      holder.kill();
      await holder.exited;
    }
    assert.equal(
      await readFile(`${home}/locked.txt`, "utf8"),
      "locked content",
    );

    // A read-only source: record the outcome and require that a success removed the source.
    await writeFile(`${home}/readonly.txt`, "readonly content");
    await chmod(`${home}/readonly.txt`, 0o444);
    let readonlyMoved = false;
    try {
      transfer(`${home}/readonly.txt`, `${volume}/readonly.txt`);
      readonlyMoved = true;
    } catch (error) {
      console.log(`INFO read-only source refused: ${String(error)}`);
    }
    if (readonlyMoved) {
      assert.equal(existsSync(`${home}/readonly.txt`), false);
      assert.equal(
        await readFile(`${volume}/readonly.txt`, "utf8"),
        "readonly content",
      );
    } else {
      assert.equal(
        await readFile(`${home}/readonly.txt`, "utf8"),
        "readonly content",
      );
    }
  }
} finally {
  disk?.detach();
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage cross-volume move: file content and unicode names in both directions, existing destination, missing source, directory and links unsupported, same-volume moves unchanged, locked and read-only sources",
);
