import { createClient } from "@bunaway/client";
import storage from "@bunaway/plugin-storage";

const client = createClient();
const file = {
  path: `${globalThis.storageTestDirectory}/notes/한글 folder/현재 draft.txt`,
};
const directory = {
  path: `${globalThis.storageTestDirectory}/notes/한글 folder`,
};
const missing = {
  path: `${globalThis.storageTestDirectory}/notes/missing.txt`,
};
const outsideNotes = {
  path: `${globalThis.storageTestDirectory}/private/missing.txt`,
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
let stage = "metadata";
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

  const outside = [
    await storage.exists(outsideNotes),
    await storage.stat(outsideNotes),
  ];
  const binaryFile = {
    path: `${globalThis.storageTestDirectory}/bytes/한글.bin`,
  };
  await storage.writeBytes({
    ...binaryFile,
    bytes: "AP8=",
  });
  await storage.appendBytes({
    ...binaryFile,
    bytes: "gA==",
  });
  const bytes = await storage.readBytes(binaryFile);
  check(bytes === "AP+A", "Byte round trip or append mismatch");
  await storage.writeBytes({
    ...binaryFile,
    bytes: "",
  });
  await storage.appendText({
    ...binaryFile,
    text: "한글",
  });
  await storage.appendText({
    ...binaryFile,
    text: "🙂",
  });
  const appended = await storage.readBytes(binaryFile);
  check(
    atob(appended) ===
      String.fromCharCode(...new TextEncoder().encode("한글🙂")),
    "UTF-8 append mismatch",
  );
  let deniedTextReplacement = false;
  try {
    await storage.writeText({
      ...binaryFile,
      text: "denied",
    });
  } catch (error) {
    deniedTextReplacement = error.code === "PERMISSION_DENIED";
  }
  check(
    deniedTextReplacement,
    "Byte write or append grant allowed text replacement",
  );
  const copied = {
    path: `${globalThis.storageTestDirectory}/copied 한글.txt`,
  };
  const moved = {
    path: `${globalThis.storageTestDirectory}/moved 한글.txt`,
  };
  await storage.copyFile({
    from: file.path,
    to: copied.path,
  });
  check(
    (await storage.readText(copied)) === "공백과 한글 경로 🙂",
    "Copied bytes mismatch",
  );
  await storage.move({
    from: copied.path,
    to: moved.path,
  });
  check(
    !(await storage.exists(copied)) && (await storage.exists(moved)),
    "Move did not rename the checked file",
  );
  check(
    (await storage.readText(moved)) === "공백과 한글 경로 🙂",
    "Moved bytes mismatch",
  );
  let deniedWrite = false;
  try {
    await storage.writeText({
      ...moved,
      text: "denied",
    });
  } catch (error) {
    deniedWrite = error.code === "PERMISSION_DENIED";
  }
  check(deniedWrite, "Transfer grants allowed unrestricted text writing");

  const createdDirectory = {
    path: `${globalThis.storageTestDirectory}/created/한글`,
  };
  stage = "recursive directory creation";
  await storage.createDirectory({
    ...createdDirectory,
    recursive: true,
  });
  stage = "existing directory creation";
  await storage.createDirectory(createdDirectory);
  stage = "Unicode directory listing";
  const entries = await storage.readDirectory(directory);
  check(
    entries.some(
      (entry) => entry.name === "현재 draft.txt" && entry.kind === "file",
    ),
    "Directory enumeration missed its Unicode child",
  );
  stage = "empty directory listing";
  check(
    (await storage.readDirectory(createdDirectory)).length === 0,
    "Created directory was not empty",
  );
  stage = "empty directory removal";
  await storage.remove(createdDirectory);
  stage = "removed directory existence";
  check(
    !(await storage.exists(createdDirectory)),
    "Empty directory was not removed",
  );
  let deniedTextWrite = false;
  stage = "text-write permission denial";
  try {
    await storage.writeText({
      path: `${globalThis.storageTestDirectory}/denied.txt`,
      text: "denied",
    });
  } catch (error) {
    deniedTextWrite = error.code === "PERMISSION_DENIED";
  }
  check(deniedTextWrite, "Directory grants allowed text writing");
  report = {
    pass: true,
    bytes,
    appended,
    deniedTextReplacement,
    transfers: true,
    deniedWrite,

    directoryOperations: true,
    deniedTextWrite,
    existsFile,
    existsDirectory,
    existsMissing,
    file: fileMetadata,
    directory: directoryMetadata,
    missing: missingMetadata,
    outside,
  };
} catch (error) {
  // Send browser-side failures through the same host channel as successful results.
  report = {
    pass: false,
    error: `${stage}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

await client.invoke("test.report", report);
await client.invoke("test.report-confirmed", true);
await client.close();
window.close();
