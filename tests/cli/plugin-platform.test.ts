import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { platformModuleStub } from "#cli/plugin-platform";

/** Write a module exporting `source`, stub it as the CLI does and return the stub text. */
async function stubFor(source: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-platform-stub-"));
  try {
    const entry = resolve(root, "platform.mjs");
    await Bun.write(entry, source);
    // The stub resolves zod from the repository, so the module imports that same copy.
    return await platformModuleStub(entry, import.meta.dir);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

test("platform stubs keep declaration values, replace schemas and make functions throw when called", async () => {
  const stub = await stubFor(`
import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
export const values = [1, -0, 2n, "text", true, null, undefined, { nested: [z.string()] }];
export default Object.assign(function create() {}, { thread: "worker", schema: z.object({}) });
`);
  expect(stub.startsWith('import { z } from "zod";\n')).toBe(true);
  expect(stub).toContain(
    'const exported1 = [1,-0,2n,"text",true,null,undefined,{["nested"]:[z.unknown()]}]; export { exported1 as "values" };',
  );
  expect(stub).toContain(
    'const exported0 = Object.assign(function () { throw new Error("Load the plugin native/<platform> export on its owning host."); }, {["thread"]:"worker",["schema"]:z.unknown()}); export { exported0 as "default" };',
  );
});

test("platform stubs reject circular values, class instances and exports without a source form", async () => {
  await expect(
    stubFor("const loop = {}; loop.self = loop; export default loop;"),
  ).rejects.toThrow("Native platform declarations cannot contain circular");
  await expect(
    stubFor("export default new (class Adapter {})();"),
  ).rejects.toThrow("Native platform instances must be created during");
  await expect(stubFor("export default Symbol('x');")).rejects.toThrow(
    "Native platform exports must be functions, schemas or plain declaration values.",
  );
});
