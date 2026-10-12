import { createClient } from "@bunaway/client";
import { path } from "@bunaway/plugin-path";

const client = createClient();
let report = {
  pass: false,
};
try {
  await client.ready;
  let directories = 0;
  for (const directory of [
    "home",
    "documents",
    "downloads",
    "desktop",
    "pictures",
    "music",
    "videos",
  ]) {
    const value = await path.getDirectory({
      directory,
    });
    if (
      !value ||
      !(await path.isAbsolute({
        path: value,
      }))
    ) {
      throw new Error(`Invalid ${directory} directory.`);
    }
    directories++;
  }
  const joined = await path.join({
    paths: [
      "C:/한글",
      "folder",
      "..",
      "🙂.txt",
    ],
  });
  const normalized = await path.normalize({
    path: "//server/share/한글/../memo.txt",
  });
  const resolved = await path.resolve({
    base: "C:/app/data",
    paths: [
      "..",
      "memo.txt",
    ],
  });
  const basename = await path.basename({
    path: joined,
    suffix: ".txt",
  });
  const extension = await path.extname({
    path: joined,
  });
  const lexical =
    joined === "C:\\한글\\🙂.txt" &&
    normalized === "\\\\server\\share\\memo.txt" &&
    resolved === "C:\\app\\memo.txt" &&
    basename === "🙂" &&
    extension === ".txt";
  if (!lexical) {
    throw new Error("Windows lexical helper results mismatch.");
  }
  let denied = false;
  try {
    await path.dirname({
      path: joined,
    });
  } catch (error) {
    denied = error.code === "PERMISSION_DENIED";
  }
  if (!denied) {
    throw new Error("Path grants allowed a different operation.");
  }
  report = {
    pass: true,
    directories,
    lexical,
    denied,
  };
} catch (error) {
  report = {
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
await client.invoke("test.report", report);
await client.invoke("test.report-confirmed", true);
await client.close();
