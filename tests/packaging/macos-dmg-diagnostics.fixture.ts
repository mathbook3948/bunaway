import assert from "node:assert/strict";
import { fstatSync, statfsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Read-only probes have bounded lifetimes and retain their own exit codes. */
async function probe(args: string[], input?: string) {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    code,
    stdout,
    stderr,
  };
}

/** Observe only this disposable fixture's images; never detach or enumerate their contents. */
async function ownedImages(roots: string[]) {
  const result = await probe([
    "/usr/bin/hdiutil",
    "info",
    "-plist",
  ]);
  if (result.code !== 0) {
    return {
      error: result.stderr,
      code: result.code,
    };
  }
  const converted = await probe(
    [
      "/usr/bin/plutil",
      "-convert",
      "json",
      "-o",
      "-",
      "-",
    ],
    result.stdout,
  );
  if (converted.code !== 0) {
    return {
      error: converted.stderr,
      code: converted.code,
    };
  }
  const info: unknown = JSON.parse(converted.stdout);
  const images =
    info && typeof info === "object" ? Reflect.get(info, "images") : undefined;
  if (!Array.isArray(images)) {
    return [];
  }
  return images.filter((image: unknown) => {
    if (!image || typeof image !== "object") {
      return false;
    }
    const path = Reflect.get(image, "image-path");
    return (
      typeof path === "string" &&
      roots.some((root) => path.startsWith(`${root}/`))
    );
  });
}

/** Capture an actual create invocation without changing its filesystem, descriptors or result. */
export async function diagnoseDmg(args: string[]): Promise<never> {
  const temporary = process.env.TMPDIR;
  assert(
    temporary && args[0] === "create",
    "Expected fixture-owned DMG creation",
  );
  const root = await realpath(dirname(temporary));
  const roots = [
    root,
    resolve(dirname(temporary)),
  ];
  const source = args[args.indexOf("-srcfolder") + 1];
  const artifact = args.at(-1);
  assert(source && artifact);
  assert((await realpath(source)).startsWith(`${root}/`));
  assert((await realpath(dirname(artifact))).startsWith(`${root}/`));
  assert(
    fstatSync(1).isFile() && fstatSync(2).isFile(),
    "Preserve real regular-file capture",
  );
  const destination = process.env.BUNAWAY_DMG_DIAGNOSTICS_DIR;
  assert(destination, "Missing fixture diagnostic destination");
  const directory = resolve(destination, crypto.randomUUID());
  await mkdir(directory, {
    recursive: true,
  });
  // Run create before any external probe: an info request can warm DiskImages
  // services or change timing, obscuring the failure we are trying to observe.
  const started = Date.now();
  const executedArgs = [
    args[0] ?? "create",
    "-verbose",
    ...args.slice(1),
  ];
  const child = Bun.spawn(
    [
      "/usr/bin/hdiutil",
      ...executedArgs,
    ],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await child.exited;
  const elapsedMs = Date.now() - started;
  const descriptors = await probe([
    "/usr/sbin/lsof",
    "-a",
    "-p",
    String(process.pid),
    "-d",
    "0,1,2",
    "-Ffn",
  ]);
  const holders = await probe([
    "/usr/sbin/lsof",
    "+D",
    source,
    "-Fpcfn",
  ]);
  const after = await ownedImages(roots);
  const output: Record<string, string> = {};
  let fd = "";
  for (const line of descriptors.stdout.split("\n")) {
    if (line.startsWith("f")) {
      fd = line.slice(1);
    }
    if (line.startsWith("n") && (fd === "1" || fd === "2")) {
      const path = line.slice(1);
      if (roots.some((root) => path.startsWith(`${root}/`))) {
        output[fd === "1" ? "stdout" : "stderr"] = await readFile(path, "utf8");
      }
    }
  }
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify(
      {
        pid: process.pid,
        parentPid: process.ppid,
        toolPid: child.pid,
        args,
        executedArgs,
        temporary,
        source,
        artifact,
        sourceFilesystem: statfsSync(source),
        stdin: {
          regular: fstatSync(0).isFile(),
          fifo: fstatSync(0).isFIFO(),
        },
        descriptors,
        holders,
        after,
        probeTiming: "after create exited",
        code,
        elapsedMs,
        ...output,
      },
      null,
      2,
    ),
  );
  process.exit(code);
}
