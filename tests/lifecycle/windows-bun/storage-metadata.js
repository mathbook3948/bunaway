import { createClient } from "@bunaway/client";
import { storage } from "@bunaway/plugin-storage";

const client = createClient();
const file = {
  scope: "appData",
  path: "notes/한글 folder/현재 draft.txt",
};
const directory = {
  scope: "appData",
  path: "notes/한글 folder",
};
const missing = {
  scope: "appData",
  path: "notes/missing.txt",
};
const denied = {
  scope: "appData",
  path: "private/missing.txt",
};

function check(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function checkTimes(metadata) {
  for (const key of [
    "createdAtMs",
    "modifiedAtMs",
    "accessedAtMs",
  ]) {
    check(
      metadata[key] === null || Number.isFinite(metadata[key]),
      `Invalid ${key}`,
    );
  }
}

let report = {
  pass: false,
};
// Exercise the metadata API from WebView and return both success and failure over the host channel.
try {
  await client.ready;
  const existsFile = await storage.exists(file);
  const existsDirectory = await storage.exists(directory);
  const existsMissing = await storage.exists(missing);
  const fileMetadata = await storage.stat(file);
  const directoryMetadata = await storage.stat(directory);
  const missingMetadata = await storage.stat(missing);
  check(existsFile, "File existence query returned false");
  check(existsDirectory, "Directory existence query returned false");
  check(!existsMissing, "Missing path existence query returned true");
  check(fileMetadata?.kind === "file", "File metadata kind mismatch");
  check(
    fileMetadata.sizeBytes ===
      new TextEncoder().encode("공백과 한글 경로 🙂").byteLength,
    "File metadata size mismatch",
  );
  checkTimes(fileMetadata);
  check(
    directoryMetadata?.kind === "directory" &&
      directoryMetadata.sizeBytes === null,
    "Directory metadata mismatch",
  );
  checkTimes(directoryMetadata);
  check(missingMetadata === null, "Missing path stat did not return null");

  const deniedCodes = [];
  for (const operation of [
    () => storage.exists(denied),
    () => storage.stat(denied),
  ]) {
    try {
      await operation();
      throw new Error("Denied path unexpectedly returned a value");
    } catch (error) {
      if (error?.code !== "PERMISSION_DENIED") {
        throw error;
      }
      deniedCodes.push(error.code);
    }
  }
  report = {
    pass: true,
    existsFile,
    existsDirectory,
    existsMissing,
    file: fileMetadata,
    directory: directoryMetadata,
    missing: missingMetadata,
    denied: deniedCodes,
  };
} catch (error) {
  // Send browser-side failures through the same host channel as successful results.
  report = {
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

await client.invoke("test.report", report);
await client.invoke("test.report-confirmed", true);
await client.close();
window.close();
