import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { packFramework } from "../../packages/cli/scripts/pack.ts";
import { createProject as generateProject } from "../../packages/cli/src/create.ts";

export const storageRoundtripUI = `
import { client as fixtureClient } from "./client.ts";
await fixtureClient.invoke("message.save", "CLI FFI 한글");
if (await fixtureClient.invoke("message.read", null) !== "CLI FFI 한글")
  throw new Error("CLI storage roundtrip failed");
window.close();
`;

let artifacts: Promise<string> | undefined;
let artifactDirectory: string | undefined;

process.once("exit", () => {
  if (artifactDirectory) {
    rmSync(artifactDirectory, {
      recursive: true,
      force: true,
    });
  }
});

export function packageDirectory(): Promise<string> {
  artifacts ??= (async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "bunaway-test-packages-"),
    );
    artifactDirectory = directory;
    await packFramework(directory, {
      localDependencies: true,
    });
    return directory;
  })();
  return artifacts;
}

export async function createProject(directory: string): Promise<string> {
  return generateProject(directory, {
    packageDirectory: await packageDirectory(),
  });
}
