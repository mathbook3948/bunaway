import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KERNEL32, pick, win32CallError } from "@bunaway/plugin/win32";
import safeStorage from "@bunaway/plugin-safe-storage/native/windows";
import { safeStorageLimits } from "../../plugins/safe-storage/src/contract.ts";

const environment = {
  dataRoot: "unused",
  capabilities: [],
};

test.skipIf(process.platform !== "win32")(
  "real DPAPI round trips bytes and Unicode, rejects tampering, and survives adapter disposal and process restart",
  async () => {
    const create = safeStorage._definition.nativePlatforms.windows?.create;
    if (!create) {
      throw new Error("Windows data protection adapter is missing.");
    }
    const adapter = create(environment);
    const other = create(environment);
    const root = resolve(
      import.meta.dir,
      `../../build/dpapi-${crypto.randomUUID()}`,
    );
    try {
      expect(
        await adapter.execute("safe-storage.isAvailable", null, "backend"),
      ).toBe(true);
      for (const text of [
        "",
        "\uFEFF한글\u0000🙂",
        "x".repeat(32768),
        "🙂".repeat(16384),
      ]) {
        const ciphertext = await adapter.execute(
          "safe-storage.encryptString",
          {
            text,
          },
          "backend",
        );
        expect(typeof ciphertext).toBe("string");
        expect(ciphertext).not.toBe(text);
        expect(
          await other.execute(
            "safe-storage.decryptString",
            {
              ciphertext,
            },
            "backend",
          ),
        ).toBe(text);
      }
      await expect(
        adapter.execute(
          "safe-storage.encryptString",
          {
            text: "🙂".repeat(16385),
          },
          "backend",
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      for (const bytes of [
        "",
        Buffer.from(
          Array.from(
            {
              length: 256,
            },
            (_, index) => index,
          ),
        ).toString("base64"),
        Buffer.alloc(256 * 1024, 255).toString("base64"),
      ]) {
        const ciphertext = await adapter.execute(
          "safe-storage.encryptBytes",
          {
            bytes,
          },
          "backend",
        );
        expect(
          await other.execute(
            "safe-storage.decryptBytes",
            {
              ciphertext,
            },
            "backend",
          ),
        ).toBe(bytes);
      }
      const ciphertext = await adapter.execute(
        "safe-storage.encryptString",
        {
          text: "restart 한글🙂",
        },
        "backend",
      );
      if (typeof ciphertext !== "string") {
        throw new Error("Ciphertext must be base64.");
      }
      const damaged = Buffer.from(ciphertext, "base64");
      damaged[damaged.length - 1] = (damaged.at(-1) ?? 0) ^ 0xff;
      for (const invalid of [
        damaged.toString("base64"),
        "AA==",
        ciphertext.slice(0, -4),
      ]) {
        await expect(
          adapter.execute(
            "safe-storage.decryptString",
            {
              ciphertext: invalid,
            },
            "backend",
          ),
        ).rejects.toMatchObject({
          code: "INTERNAL",
        });
      }
      const invalidUtf8 = await adapter.execute(
        "safe-storage.encryptBytes",
        {
          bytes: "/w==",
        },
        "backend",
      );
      await expect(
        adapter.execute(
          "safe-storage.decryptString",
          {
            ciphertext: invalidUtf8,
          },
          "backend",
        ),
      ).rejects.toThrow();
      await adapter.dispose();
      await adapter.dispose();
      await expect(
        adapter.execute("safe-storage.isAvailable", null, "backend"),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
      expect(
        await other.execute("safe-storage.isAvailable", null, "backend"),
      ).toBe(true);
      await mkdir(root, {
        recursive: true,
      });
      const inputPath = resolve(root, "protected.txt");
      await writeFile(inputPath, ciphertext);
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "fixtures/windows-dpapi-decrypt.ts"),
          inputPath,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15000,
        },
      );
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, errors).toBe(0);
      expect(output.trim()).toBe(JSON.stringify("restart 한글🙂"));
    } finally {
      await adapter.dispose();
      await other.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

/** ERROR_INVALID_PARAMETER, which DPAPI leaves for bytes that are not a protected-data blob. */
const ERROR_INVALID_PARAMETER = 87;
const LAST_ERROR_SAMPLES = 200;

test.skipIf(process.platform !== "win32")(
  "a failed DPAPI call leaves a readable last error through the FFI layer",
  () => {
    const kernel = dlopen("kernel32.dll", pick(KERNEL32, "GetLastError"));
    const crypt = dlopen("crypt32.dll", {
      CryptUnprotectData: {
        args: [
          "ptr",
          "ptr",
          "ptr",
          "ptr",
          "ptr",
          "u32",
          "ptr",
        ],
        returns: "i32",
      },
    });
    try {
      const garbage = Buffer.alloc(32, 7);
      const blob = Buffer.alloc(16);
      blob.writeUInt32LE(garbage.length, 0);
      blob.writeBigUInt64LE(BigInt(ptr(garbage)), 8);
      const output = Buffer.alloc(16);
      const codes = new Set<number>();
      for (let sample = 0; sample < LAST_ERROR_SAMPLES; sample++) {
        codes.add(
          win32CallError(
            () =>
              crypt.symbols.CryptUnprotectData(
                ptr(blob),
                null,
                null,
                null,
                null,
                1,
                ptr(output),
              ),
            () => kernel.symbols.GetLastError(),
          ),
        );
      }
      expect([
        ...codes,
      ]).toEqual([
        ERROR_INVALID_PARAMETER,
      ]);
    } finally {
      crypt.close();
      kernel.close();
    }
  },
);

const CREDENTIAL_BYTES = 80;
const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;

function credentialEnvironment(id: string) {
  return {
    ...environment,
    app: {
      id,
      launch: {
        mode: "development" as const,
        executablePath: "unused",
        args: [],
      },
    },
  };
}

/** Read the stored entry directly, bypassing the plugin, to check how Windows holds it. */
function readRawCredential(target: string) {
  const advapi = dlopen("advapi32.dll", {
    CredReadW: {
      args: [
        "ptr",
        "u32",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    CredFree: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
  });
  try {
    const out = Buffer.alloc(8);
    const name = Buffer.from(`${target}\0`, "utf16le");
    if (!advapi.symbols.CredReadW(ptr(name), CRED_TYPE_GENERIC, 0, ptr(out))) {
      return null;
    }
    const address = Number(out.readBigUInt64LE(0));
    try {
      const header = Buffer.from(
        toArrayBuffer(address as Pointer, 0, CREDENTIAL_BYTES),
      );
      const size = header.readUInt32LE(32);
      const blob = Buffer.from(
        toArrayBuffer(Number(header.readBigUInt64LE(40)) as Pointer, 0, size),
      );
      return {
        persist: header.readUInt32LE(48),
        text: blob.toString("utf16le"),
      };
    } finally {
      advapi.symbols.CredFree(address as Pointer);
    }
  } finally {
    advapi.close();
  }
}

test.skipIf(process.platform !== "win32")(
  "real Credential Manager stores, replaces, reads and deletes app-scoped secrets",
  async () => {
    const create = safeStorage._definition.nativePlatforms.windows?.create;
    if (!create) {
      throw new Error("Windows data protection adapter is missing.");
    }
    const suffix = crypto.randomUUID();
    const appOne = `test.bunaway.${suffix}.one`;
    const first = create(credentialEnvironment(appOne));
    const second = create(credentialEnvironment(`test.bunaway.${suffix}.two`));
    const adapters = [
      first,
      second,
    ];
    const run = (adapter: typeof first, name: string, payload: unknown) =>
      adapter.execute(`safe-storage.${name}`, payload as never, "backend");
    const unicode = "토큰\u{1F642}-﻿";
    const longest = "x".repeat(safeStorageLimits.secretCharacters);
    try {
      expect(
        await run(first, "getSecret", {
          key: "token",
        }),
      ).toBeNull();
      expect(
        await run(first, "deleteSecret", {
          key: "token",
        }),
      ).toBe(false);
      expect(
        await run(first, "setSecret", {
          key: "token",
          value: unicode,
        }),
      ).toBeNull();
      expect(
        await run(first, "getSecret", {
          key: "token",
        }),
      ).toBe(unicode);
      // Replacing the same key keeps one entry with the new value.
      await run(first, "setSecret", {
        key: "token",
        value: longest,
      });
      expect(
        await run(first, "getSecret", {
          key: "token",
        }),
      ).toBe(longest);
      // Another app id cannot see the entry, and the stored target is namespaced and local only.
      expect(
        await run(second, "getSecret", {
          key: "token",
        }),
      ).toBeNull();
      expect(
        await run(second, "deleteSecret", {
          key: "token",
        }),
      ).toBe(false);
      expect(readRawCredential(`bunaway.safe-storage:${appOne}:token`)).toEqual(
        {
          persist: CRED_PERSIST_LOCAL_MACHINE,
          text: longest,
        },
      );
      expect(readRawCredential("token")).toBeNull();
      // A new adapter for the same app reads what the first one wrote.
      const reopened = create(credentialEnvironment(appOne));
      adapters.push(reopened);
      expect(
        await run(reopened, "getSecret", {
          key: "token",
        }),
      ).toBe(longest);
      expect(
        await run(reopened, "deleteSecret", {
          key: "token",
        }),
      ).toBe(true);
      expect(
        await run(first, "getSecret", {
          key: "token",
        }),
      ).toBeNull();
      expect(
        await run(first, "deleteSecret", {
          key: "token",
        }),
      ).toBe(false);
      // Without a host app id the credential operations fail and DPAPI keeps working.
      const anonymous = create(environment);
      adapters.push(anonymous);
      await expect(
        run(anonymous, "setSecret", {
          key: "token",
          value: "v",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(await run(anonymous, "isAvailable", null)).toBe(true);
    } finally {
      await run(first, "deleteSecret", {
        key: "token",
      }).catch(() => false);
      for (const adapter of adapters) {
        adapter.dispose();
      }
    }
  },
);
