import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { frameworkRoot } from "./files.ts";

if (import.meta.main) {
  if (process.platform !== "win32") {
    throw new Error("Command Job worker is Windows-only.");
  }
  const lease = process.argv[2];
  const command = JSON.parse(process.argv[3] ?? "null") as string[];
  if (!lease || !Array.isArray(command) || !command.length) {
    throw new Error("Invalid command worker input.");
  }
  const { containAppProcess, terminateAppDescendants } = await import(
    pathToFileURL(resolve(frameworkRoot, "native/windows/bun/job.ts")).href
  );
  // Assign this worker before spawning so the command and its descendants join its Job.
  containAppProcess(lease);
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  let finishing: Promise<never> | undefined;
  const finish = (code: number): Promise<never> =>
    (finishing ??= (async () => {
      try {
        // A command can exit while descendants still hold files or ports.
        await terminateAppDescendants();
      } catch (error) {
        console.error(`Command cleanup failed: ${String(error)}`);
        code = 1;
      }
      process.exit(code);
    })());
  // EOF also handles an abruptly killed CLI. Job closure remains the crash fallback.
  void Bun.stdin.text().then(() => finish(0));
  await finish(await child.exited);
}
