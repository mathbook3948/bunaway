import { resolve } from "node:path";
import { checkArtifact } from "../src/distribution.ts";

if (!process.argv[2])
  throw new Error("Usage: bun run framework:check <extracted-package-directory>");
await checkArtifact(resolve(process.argv[2]));
console.log("Framework artifact inventory, versions, schemas and license hashes are valid.");
