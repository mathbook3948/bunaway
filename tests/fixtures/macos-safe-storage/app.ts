import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import safeStorage from "@bunaway/plugin-safe-storage";
import windows from "@bunaway/plugin-windows";
import { fixturePlugin } from "./plugin.ts";

const temporary = process.env.TMPDIR;
assert(temporary);
const ciphertextPath = resolve(temporary, "caller-owned-ciphertext.txt");
let restarted = false;
export default defineApp({
  modules: [],
  plugins: [
    fixturePlugin,
    windows,
    {
      name: "safe-storage-test",
      version: "1",
      async setup() {
        assert.equal(await safeStorage.isAvailable(null), true);
        restarted = existsSync(ciphertextPath);
        const ciphertext = restarted
          ? readFileSync(ciphertextPath, "utf8")
          : await safeStorage.encryptString({
              text: "synthetic restart 한글🙂",
            });
        assert.equal(
          await safeStorage.decryptString({
            ciphertext,
          }),
          "synthetic restart 한글🙂",
        );
        if (!restarted) {
          writeFileSync(ciphertextPath, ciphertext);
        }
        const bytes = Buffer.from([
          0,
          255,
          42,
        ]).toString("base64");
        const protectedBytes = await safeStorage.encryptBytes({
          bytes,
        });
        assert.equal(
          await safeStorage.decryptBytes({
            ciphertext: protectedBytes,
          }),
          bytes,
        );
        writeFileSync(
          resolve(temporary, "backend-report.json"),
          JSON.stringify({
            restarted,
            roundTrip: true,
          }),
        );
        return () => writeFileSync(resolve(temporary, "core-cleaned"), "done");
      },
    },
  ],
  commands: {
    "test.report": {
      input: {
        enum: [
          "passed",
          "failed",
        ],
      },
      output: {
        const: null,
      },
      async run(payload: unknown) {
        assert(payload === "passed" || payload === "failed");
        writeFileSync(resolve(temporary, "web-report"), payload);
        return null;
      },
    },
  },
});
