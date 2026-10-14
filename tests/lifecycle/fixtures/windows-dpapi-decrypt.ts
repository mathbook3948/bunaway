import safeStorage from "@bunaway/plugin-safe-storage/native/windows";

const path = process.argv[2];
const create = safeStorage._definition.nativePlatforms.windows?.create;
if (!path || !create) {
  throw new Error("DPAPI restart fixture requires input and Windows.");
}
const adapter = create({
  dataRoot: "unused",
  capabilities: [],
});
try {
  const ciphertext = await Bun.file(path).text();
  console.log(
    JSON.stringify(
      await adapter.execute(
        "safe-storage.decryptString",
        {
          ciphertext,
        },
        "backend",
      ),
    ),
  );
} finally {
  await adapter.dispose();
}
