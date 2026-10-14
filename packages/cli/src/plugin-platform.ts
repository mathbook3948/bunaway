import { pathToFileURL } from "node:url";

/**
 * Inspect portable module exports in an isolated build process, without invoking native functions.
 * Neutral bundles need operation keys, not executable schemas: the owning native export validates calls.
 * Import resolution includes named, default and star re-exports without implementing a second module resolver.
 */
export async function platformModuleStub(
  entry: string,
  directory: string,
): Promise<string> {
  const module: Record<string, unknown> = await import(
    pathToFileURL(entry).href
  );
  // Resolve the author's schema implementation, just as their platform module does.
  const schemas: Record<string, unknown> = await import(
    pathToFileURL(Bun.resolveSync("zod", directory)).href
  );
  const schemaClass = schemas.ZodType;
  if (typeof schemaClass !== "function") {
    throw new Error("Native plugins require Zod schemas.");
  }
  const unavailable = `function () { throw new Error("Load the plugin native/<platform> export on its owning host."); }`;
  const encode = (value: unknown, ancestors: ReadonlySet<object>): string => {
    if (value instanceof schemaClass) {
      return "z.unknown()";
    }
    if (value === undefined) {
      return "undefined";
    }
    if (typeof value === "bigint") {
      return `${value}n`;
    }
    if (typeof value === "number") {
      return Object.is(value, -0) ? "-0" : String(value);
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return JSON.stringify(value);
    }
    if (typeof value !== "object" && typeof value !== "function") {
      throw new Error(
        "Native platform exports must be functions, schemas or plain declaration values.",
      );
    }
    if (ancestors.has(value)) {
      throw new Error(
        "Native platform declarations cannot contain circular values.",
      );
    }
    const visited = new Set([
      ...ancestors,
      value,
    ]);
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, visited)).join(",")}]`;
    }
    if (
      typeof value !== "function" &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error(
        "Native platform instances must be created during initialize.",
      );
    }
    const entries = Object.entries(value)
      .map(([key, item]) => `[${JSON.stringify(key)}]:${encode(item, visited)}`)
      .join(",");
    // Function metadata includes defineNativeAdapter's immutable support keys.
    return typeof value === "function"
      ? `Object.assign(${unavailable}, {${entries}})`
      : `{${entries}}`;
  };
  return `import { z } from "zod";\n${Object.entries(module)
    .map(
      ([name, value], index) =>
        `const exported${index} = ${encode(value, new Set())}; export { exported${index} as ${JSON.stringify(name)} };`,
    )
    .join("\n")}`;
}
