import type { Project } from "./config.ts";
import { run } from "./files.ts";

const BUILD_STACK = "BUNAWAY_BUILD_STACK";

function buildStack(): string[] {
  const value = process.env[BUILD_STACK];
  if (value === undefined) return [];
  const stack: unknown = JSON.parse(value);
  if (!Array.isArray(stack) || stack.some((root) => typeof root !== "string")) {
    throw new Error(`Invalid ${BUILD_STACK}.`);
  }
  return stack as string[];
}

export function assertNotFrontendBuild(root: string): void {
  if (buildStack().includes(root)) {
    throw new Error(
      "Recursive app build: build.command must run the web build only, for example bun run build:web.",
    );
  }
}

export async function buildFrontend(project: Project): Promise<void> {
  if (!project.buildCommand) return;
  assertNotFrontendBuild(project.root);
  console.log(`Building frontend: ${project.buildCommand.join(" ")}`);
  const args =
    project.buildCommand[0] === "bun"
      ? [process.execPath, ...project.buildCommand.slice(1)]
      : project.buildCommand;
  try {
    await run(args, project.root, {
      [BUILD_STACK]: JSON.stringify([...buildStack(), project.root]),
    });
  } catch (error) {
    throw new Error(
      `Frontend build failed (build.command): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
