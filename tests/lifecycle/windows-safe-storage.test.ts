import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
