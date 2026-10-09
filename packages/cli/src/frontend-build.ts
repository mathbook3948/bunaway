import type { Project } from "./config.ts";
import { runManagedCommand } from "./managed-command.ts";

const BUILD_STACK = "BUNAWAY_BUILD_STACK";

/** Read the app-root chain propagated through nested frontend build processes. */
function buildStack(): string[] {
  const value = process.env[BUILD_STACK];
  if (value === undefined) {
    return [];
  }
  const stack: unknown = JSON.parse(value);
  if (!Array.isArray(stack) || stack.some((root) => typeof root !== "string")) {
    throw new Error(`Invalid ${BUILD_STACK}.`);
  }
  return stack as string[];
}

/** Reject a frontend command that recursively invokes the app build. */
export function assertNotFrontendBuild(root: string): void {
  if (buildStack().includes(root)) {
    throw new Error(
      "Recursive app build: build.command must run the web build only, for example bun run build:web.",
    );
  }
}

/** Run the configured frontend build and attach recursive-build context to child processes. */
export async function buildFrontend(
  project: Project,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!project.buildCommand) {
    return;
  }
  assertNotFrontendBuild(project.root);
  console.log(`Building frontend: ${project.buildCommand.join(" ")}`);
  // Use this CLI's Bun executable so nested builds follow the pinned runtime.
  const args =
    project.buildCommand[0] === "bun"
      ? [
          process.execPath,
          ...project.buildCommand.slice(1),
        ]
      : project.buildCommand;
  try {
    await runManagedCommand(
      args,
      project.root,
      {
        [BUILD_STACK]: JSON.stringify([
          ...buildStack(),
          project.root,
        ]),
      },
      signal,
      project.frameworkRoot,
    );
  } catch (error) {
    throw new Error(
      `Frontend build failed (build.command): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
