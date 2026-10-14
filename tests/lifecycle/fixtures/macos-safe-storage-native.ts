import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativePluginAdapter } from "@bunaway/plugin";
import { MacosKeychain } from "../../../plugins/safe-storage/src/macos-keychain.ts";
import { macosSafeStorageOperations as macosOperations } from "../../fixtures/injected-native-plugins.ts";
import { keychainFixture } from "./macos-keychain.ts";

const APP_ID = "tests.bunaway.safe-storage.synthetic";
const compiled = import.meta.path.startsWith("/$bunfs/");
const [mode, path, ciphertextPath] = process.argv.slice(2);
const fixture = keychainFixture();

if (mode === "decrypt") {
  let ownedAdapter: NativePluginAdapter | undefined;
  try {
    assert(path && ciphertextPath);
    const reference = fixture.open(path);
    ownedAdapter = macosOperations(
      APP_ID,
      () => new MacosKeychain(APP_ID, reference),
    );
    const adapter = ownedAdapter;
    const ciphertext = await Bun.file(ciphertextPath).text();
    assert.equal(
      await adapter.execute(
        "safe-storage.decryptString",
        {
          ciphertext,
        },
        "backend",
      ),
      "restart 한글🙂",
    );
    console.log("synthetic-restart-ok");
  } finally {
    await ownedAdapter?.dispose();
    fixture.dispose(false);
  }
} else {
  const root = await mkdtemp(join(tmpdir(), "bunaway-keychain-"));
  const keychainPath = join(root, "synthetic.keychain");
  let ownedAdapter: NativePluginAdapter | undefined;
  let ownedOther: NativePluginAdapter | undefined;
  try {
    const reference = fixture.create(keychainPath);
    ownedAdapter = macosOperations(
      APP_ID,
      () => new MacosKeychain(APP_ID, reference),
    );
    const adapter = ownedAdapter;
    ownedOther = macosOperations(
      APP_ID,
      () => new MacosKeychain(APP_ID, reference),
    );
    const other = ownedOther;
    assert.equal(
      await adapter.execute("safe-storage.isAvailable", null, "backend"),
      true,
    );
    for (const text of [
      "",
      "\uFEFF한글\u0000🙂",
      "🙂".repeat(16384),
    ]) {
      const ciphertext = await adapter.execute(
        "safe-storage.encryptString",
        {
          text,
        },
        "backend",
      );
      assert.equal(
        await other.execute(
          "safe-storage.decryptString",
          {
            ciphertext,
          },
          "backend",
        ),
        text,
      );
    }
    for (const bytes of [
      "",
      Buffer.from([
        0,
        255,
        42,
      ]).toString("base64"),
      Buffer.alloc(256 * 1024, 255).toString("base64"),
    ]) {
      const ciphertext = await adapter.execute(
        "safe-storage.encryptBytes",
        {
          bytes,
        },
        "backend",
      );
      assert.equal(
        await other.execute(
          "safe-storage.decryptBytes",
          {
            ciphertext,
          },
          "backend",
        ),
        bytes,
      );
    }
    const ciphertext = await adapter.execute(
      "safe-storage.encryptString",
      {
        text: "restart 한글🙂",
      },
      "backend",
    );
    assert.equal(typeof ciphertext, "string");
    if (typeof ciphertext !== "string") {
      throw new Error("Expected ciphertext");
    }
    const damaged = Buffer.from(ciphertext, "base64");
    damaged[damaged.length - 1] = (damaged.at(-1) ?? 0) ^ 1;
    await assert.rejects(
      async () =>
        await adapter.execute(
          "safe-storage.decryptString",
          {
            ciphertext: damaged.toString("base64"),
          },
          "backend",
        ),
    );
    fixture.lock();
    assert.equal(
      await adapter.execute("safe-storage.isAvailable", null, "backend"),
      false,
    );
    fixture.unlock();
    assert.equal(
      await other.execute(
        "safe-storage.decryptString",
        {
          ciphertext,
        },
        "backend",
      ),
      "restart 한글🙂",
    );
    // Any JS app namespace in this same host can address this account. appId is not an OS principal.
    const sameExecutable = new MacosKeychain(APP_ID, reference);
    try {
      const key = sameExecutable.read();
      assert.equal(key?.length, 32);
      key?.fill(0);
    } finally {
      sameExecutable.dispose();
    }
    await adapter.dispose();
    await adapter.dispose();
    await assert.rejects(
      async () =>
        await adapter.execute("safe-storage.isAvailable", null, "backend"),
    );
    const inputPath = join(root, "ciphertext.txt");
    await writeFile(inputPath, ciphertext);
    const args = compiled
      ? [
          process.execPath,
          "decrypt",
          keychainPath,
          inputPath,
        ]
      : [
          process.execPath,
          "--no-env-file",
          import.meta.path,
          "decrypt",
          keychainPath,
          inputPath,
        ];
    const child = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, errors);
    assert.match(output, /synthetic-restart-ok/);
    console.log(
      JSON.stringify({
        keychain: "disposable-private",
        mode: compiled ? "compiled" : "shared-bun",
        roundTrip: true,
        restart: true,
        tamper: true,
        lockedStatus: true,
        appIdIsNamespace: true,
      }),
    );
  } finally {
    await ownedAdapter?.dispose();
    await ownedOther?.dispose();
    try {
      fixture.dispose(true);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  }
}
