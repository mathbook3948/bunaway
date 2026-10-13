import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkRoot, json, writeJson } from "#cli/files";
import { run } from "#cli/processes";
import { createProject, packageDirectory } from "./project.ts";

/** Creates the same common app definition used by the actual iOS Simulator fixture. */
export async function iosFixture(root: string): Promise<void> {
  await createProject(root);
  const packagePath = resolve(root, "package.json");
  const pkg = await json(packagePath);
  if (
    typeof pkg !== "object" ||
    pkg === null ||
    !("dependencies" in pkg) ||
    typeof pkg.dependencies !== "object" ||
    pkg.dependencies === null
  ) {
    throw new Error("Missing generated fixture dependencies.");
  }
  await writeJson(packagePath, {
    ...pkg,
    dependencies: {
      ...pkg.dependencies,
      "@bunaway/protocol": `file:${resolve(await packageDirectory(), "bunaway-protocol-0.0.0.tgz")}`,
    },
  });

  await cp(
    resolve(frameworkRoot, "tests/fixtures/ios"),
    resolve(root, "src-bunaway"),
    {
      recursive: true,
    },
  );

  await writeJson(resolve(root, "src-bunaway/bunaway.json"), {
    version: 1,
    build: {
      app: "src-bunaway/app.ts",
      frontend: "src-bunaway/web",
    },
    app: {
      appId: "dev.bunaway.ios.fixture",
      title: "Bunaway iOS",
      view: "main",
      home: "https://app.bunaway.local:443/index.html?probe=1",
      window: {
        width: 800,
        height: 600,
      },
    },
  });
  await run(
    [
      process.execPath,
      "install",
      "--ignore-scripts",
    ],
    root,
  );
}
