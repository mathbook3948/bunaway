import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import safeStorage from "@bunaway/plugin-safe-storage/native/windows";

/**
 * Runs as a second local Windows user. Arguments: the base64 DPAPI blob another user protected,
 * the path to write this user's own blob to, and the path to write the JSON result to.
 *
 * The result records the account this process runs as, whether it could unprotect the foreign
 * blob (never the plaintext) and whether it can round trip its own blob after reading it back from
 * disk, so a failure on the foreign blob is attributable to the user boundary and not to a broken
 * profile or a damaged file.
 */
const [foreignPath, ownBlobPath, resultPath] = process.argv.slice(2);
const create = safeStorage._definition.nativePlatforms.windows?.create;
if (!foreignPath || !ownBlobPath || !resultPath || !create) {
  throw new Error("The other-user fixture requires three paths and Windows.");
}
const adapter = create({
  dataRoot: "unused",
  capabilities: [],
});

const OWN_TEXT = "second user 한글🙂";

async function decrypt(ciphertext: string) {
  return await adapter.execute(
    "safe-storage.decryptString",
    {
      ciphertext,
    },
    "backend",
  );
}

/** The error code a rejected adapter call carries, when it has one. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

try {
  const ownBlob = await adapter.execute(
    "safe-storage.encryptString",
    {
      text: OWN_TEXT,
    },
    "backend",
  );
  if (typeof ownBlob !== "string") {
    throw new Error("Ciphertext must be base64.");
  }
  await writeFile(ownBlobPath, ownBlob);
  // Decrypt what was written, so the check covers the exact file the first user is given.
  const ownRoundTrip =
    (await decrypt(await readFile(ownBlobPath, "utf8"))) === OWN_TEXT;
  let foreign: {
    decrypted: boolean;
    code?: string | undefined;
  };
  try {
    await decrypt(await readFile(foreignPath, "utf8"));
    foreign = {
      decrypted: true,
    };
  } catch (error) {
    foreign = {
      decrypted: false,
      code: errorCode(error),
    };
  }
  await writeFile(
    resultPath,
    JSON.stringify({
      // The account of the process token, not the inherited USERNAME variable.
      user: userInfo().username,
      ownRoundTrip,
      foreign,
    }),
  );
} finally {
  await adapter.dispose();
}
