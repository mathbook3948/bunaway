import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

// Toolchain discovery and helpers shared by the Windows channel adapters.
// Adapters never touch the build artifact: they copy it into the runner-owned
// staging directory first and every mutation happens on the copy.

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  exe: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<ToolResult> {
  const proc = Bun.spawn([exe, ...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

// Runs a packaging tool and throws with captured output on failure.
export async function must(
  exe: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<ToolResult> {
  const result = await run(exe, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).slice(0, 2000);
    throw new Error(`${basenameOf(exe)} exited ${result.code}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// Latest Windows SDK tool (signtool.exe, makeappx.exe) under the x64 bin dir.
export async function findWindowsKitTool(tool: string): Promise<string | undefined> {
  const kits = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin",
  );
  let versions: string[] = [];
  try {
    versions = (await readdir(kits, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^10\./.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return undefined;
  }
  for (const version of versions) {
    const candidate = join(kits, version, "x64", tool);
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

const ISCC_CANDIDATES = [
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
  join(process.env.ProgramFiles ?? "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
];

export async function findIscc(): Promise<string | undefined> {
  for (const candidate of ISCC_CANDIDATES) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

export async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// Copies the channel-neutral package dir (manifest.json, assets/, licenses/,
// runtime/, host executable) into a staging payload directory. The `packaged`
// subtree inside the artifact dir holds earlier package outputs and is not
// part of the payload — skipping it also keeps staging (which lives under
// packaged/) out of the copy.
export async function copyPayload(packageDir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  // Copy entries individually: fs.cp refuses a destination inside the source
  // (staging lives under packageDir/packaged/), so that subtree is excluded
  // by name rather than by a filter.
  for (const entry of await readdir(packageDir)) {
    if (entry === "packaged") continue;
    await cp(join(packageDir, entry), join(dest, entry), { recursive: true });
  }
}

// Deterministic Inno AppId GUID derived from the app identifier so repeated
// installs of the same app upgrade in place (over-install update contract).
export function stableGuid(identifier: string): string {
  const hex = createHash("sha256").update(`bunaway:${identifier}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function toWindowsPath(path: string): string {
  return path.split("/").join(sep === "\\" ? "\\" : "/");
}
