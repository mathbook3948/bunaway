import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KERNEL32, pick, win32CallError } from "@bunaway/plugin/win32";
import safeStorage from "@bunaway/plugin-safe-storage/native/windows";

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
      let calls = 0;
      const codes = new Set<number>();
      for (let sample = 0; sample < LAST_ERROR_SAMPLES; sample++) {
        codes.add(
          win32CallError(
            () => {
              calls++;
              return crypt.symbols.CryptUnprotectData(
                ptr(blob),
                null,
                null,
                null,
                null,
                1,
                ptr(output),
              );
            },
            () => kernel.symbols.GetLastError(),
          ),
        );
      }
      // The call count shows how often the first last-error read was overwritten.
      console.log(
        "DPAPI last error samples:",
        LAST_ERROR_SAMPLES,
        "calls:",
        calls,
        "codes:",
        [
          ...codes,
        ].join(","),
      );
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
