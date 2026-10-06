import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleWindowsHost } from "../../packages/cli/src/assets.ts";

test("Windows app entry names cannot collide with the host or break shared bundle imports", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-windows-assets-"));
  const host = resolve(import.meta.dir, "../../native/windows/bun");
  const protocol = resolve(import.meta.dir, "../../packages/protocol/src/index.ts");
  try {
    for (const name of ["boot.ts", "app.ts", "ui.ts"]) {
      const entry = resolve(root, name);
      const destination = resolve(root, `out-${name}`);
      await mkdir(destination);
      await writeFile(
        entry,
        `import { BunawayError } from ${JSON.stringify(protocol)}; export default { commands: {}, events: {}, name: ${JSON.stringify(name)}, error: new BunawayError({ code: "CANCELLED", message: "test" }) };`,
      );
      await bundleWindowsHost(host, destination, entry);
      const outputs = await readdir(destination);
      for (const expected of ["boot.js", "app.js", "ui.js", "host-operations.js"])
        expect(outputs).toContain(expected);
      expect(outputs.some((output) => output.startsWith("chunk-"))).toBe(true);
      const app = (await import(pathToFileURL(resolve(destination, "app.js")).href)).default;
      expect(app.name).toBe(name);
      expect(app.error.code).toBe("CANCELLED");
      expect(await readFile(resolve(destination, "boot.js"), "utf8")).toContain(
        "verifyWindowsPackage",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
