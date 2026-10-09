import { resolve } from "node:path";
import type { BuildTarget } from "./contract.ts";

/**
 * Shared app-output layout for CLI builds and packaging. Work and locks are disposable;
 * output and packaged are published artifacts. Callers validate targets and use
 * ownedDirectory before filesystem access, including cleanup.
 */
export function outputPaths(root: string, target: BuildTarget) {
  const internal = resolve(root, ".bunaway");
  const output = resolve(root, "dist", target);
  return {
    internal,
    output,
    development: resolve(internal, target),
    work: resolve(internal, "work", target),
    locks: resolve(internal, "locks", target),
    packaged: resolve(output, "packaged"),
  };
}
