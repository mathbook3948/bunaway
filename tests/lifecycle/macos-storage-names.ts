import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { BunawayError } from "@bunaway/plugin";
import type { MacosStorage } from "../../plugins/storage/src/platforms/macos.ts";
import { executeMacosStorage } from "../fixtures/macos-storage-operations.ts";

/**
 * Exercise name aliasing on the volume that holds the caller's temporary root. APFS keeps the
 * stored spelling but may fold case and Unicode normalization when it looks a name up, so the
 * adapter has to agree with the file system instead of normalizing names itself.
 */
export function verifyMacosNames(
  storage: MacosStorage,
  root: string,
): string[] {
  const call = (operation: string, input: Record<string, string>) =>
    executeMacosStorage(storage, operation, input);
  const folder = `${root}/names`;
  assert.equal(
    storage.createDirectory({
      path: folder,
      recursive: false,
    }),
    null,
  );
  const results: string[] = [];

  // "é" as one code point (NFC) and as "e" plus a combining accent (NFD).
  const composed = "\u00e9.txt";
  const decomposed = "e\u0301.txt";
  assert.notEqual(composed, decomposed);
  assert.equal(
    call("storage.writeText", {
      path: `${folder}/${composed}`,
      text: "composed",
    }),
    null,
  );
  const folds = existsSync(`${folder}/${decomposed}`);
  assert.equal(
    call("storage.exists", {
      path: `${folder}/${decomposed}`,
    }),
    folds,
  );
  if (folds) {
    assert.equal(
      call("storage.readText", {
        path: `${folder}/${decomposed}`,
      }),
      "composed",
    );
    // Writing through the other spelling replaces the same file instead of adding a second one.
    call("storage.writeText", {
      path: `${folder}/${decomposed}`,
      text: "decomposed",
    });
    assert.equal(readFileSync(`${folder}/${composed}`, "utf8"), "decomposed");
  } else {
    assert.equal(
      call("storage.writeText", {
        path: `${folder}/${decomposed}`,
        text: "decomposed",
      }),
      null,
    );
    assert.equal(readFileSync(`${folder}/${composed}`, "utf8"), "composed");
  }
  const listed = call("storage.readDirectory", {
    path: folder,
  });
  const byName = (
    left: {
      name: string;
    },
    right: {
      name: string;
    },
  ) => Number(left.name > right.name) - Number(left.name < right.name);
  assert(Array.isArray(listed));
  assert.deepEqual(
    [
      ...listed,
    ].sort(byName),
    readdirSync(folder)
      .map((name) => ({
        name,
        kind: "file",
      }))
      .sort(byName),
  );
  if (folds) {
    // The spelling used when the file was created stays, even after a write through the other one.
    assert.deepEqual(listed, [
      {
        name: composed,
        kind: "file",
      },
    ]);
  }
  assert.equal(Array.isArray(listed) && listed.length, folds ? 1 : 2);
  results.push(
    `Unicode composed and decomposed names follow the volume (${folds ? "folded" : "distinct"}) and listings keep the stored spelling`,
  );

  const cased = `${folder}/Case.txt`;
  const lower = `${folder}/case.txt`;
  assert.equal(
    call("storage.writeText", {
      path: cased,
      text: "upper",
    }),
    null,
  );
  const insensitive = existsSync(lower);
  assert.equal(
    call("storage.exists", {
      path: lower,
    }),
    insensitive,
  );
  if (insensitive) {
    assert.equal(
      call("storage.readText", {
        path: lower,
      }),
      "upper",
    );
    // A case-only move targets the file itself: it is either refused like an existing destination
    // or renames in place, and in both cases it never leaves a second entry or loses the content.
    try {
      call("storage.move", {
        from: cased,
        to: lower,
      });
    } catch (error) {
      assert(
        error instanceof BunawayError && error.code === "INVALID_ARGUMENT",
      );
    }
    const entries = readdirSync(folder).filter(
      (name) => name.toLowerCase() === "case.txt",
    );
    assert.equal(entries.length, 1);
    assert.equal(readFileSync(`${folder}/${entries[0]}`, "utf8"), "upper");
  } else {
    assert.equal(
      call("storage.move", {
        from: cased,
        to: lower,
      }),
      null,
    );
    assert.equal(readdirSync(folder).includes("case.txt"), true);
    assert.equal(readdirSync(folder).includes("Case.txt"), false);
  }
  results.push(
    `case-only names follow the volume (${insensitive ? "case-insensitive" : "case-sensitive"}) for lookup and moves`,
  );
  return results;
}
