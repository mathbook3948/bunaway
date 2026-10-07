import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pin from "../../../runtime/build-manifests/windows-x64.json";
import { json, projectPath, verifyHash } from "./files.ts";

export function windowsInspectorArgument(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Inspector port must be an integer between 1 and 65535.");
  return `--inspect=127.0.0.1:${port}/bunaway`;
}

export async function writeWindowsLauncher(source: string, destination: string): Promise<void> {
  const script = await readFile(source, "utf8");
  if (!script.includes("__BUN_SHA256__")) throw new Error("Missing launcher runtime pin.");
  await writeFile(destination, script.replace("__BUN_SHA256__", pin.bun.executableSha256));
}

export async function verifyWindowsLaunch(root: string): Promise<void> {
  const manifest = (await json(resolve(root, "manifest.json"))) as {
    bun?: { executableSha256?: string; sourceRevision?: string; packagedSha256?: string };
    assets: Record<string, string>;
  };
  if (
    manifest.bun?.executableSha256 !== pin.bun.executableSha256 ||
    manifest.bun.sourceRevision !== pin.bun.sourceRevision
  )
    throw new Error("Package Bun provenance does not match the framework pin.");
  const runtimeHash = manifest.bun.packagedSha256 ?? pin.bun.executableSha256;
  if (!/^[a-f0-9]{64}$/.test(runtimeHash)) throw new Error("Invalid packaged Bun hash.");
  await verifyHash(resolve(root, "runtime/bun.exe"), runtimeHash);
  if (!manifest.assets?.["assets/boot.js"]) throw new Error("Missing Windows bootstrap inventory.");
  for (const [name, expected] of Object.entries(manifest.assets))
    await verifyHash(await projectPath(root, name), expected);
}

export function windowsLaunchEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(parent).filter(([name]) =>
      /^(SystemRoot|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|PROGRAMDATA|ALLUSERSPROFILE|ProgramFiles|ProgramFiles\(x86\))$/i.test(
        name,
      ),
    ),
  );
  if (!parent.SystemRoot) throw new Error("SystemRoot is required for Windows launch.");
  environment.PATH = `${parent.SystemRoot}\\System32`;
  return environment;
}

// Development runner only: request normal teardown on the app's actual Win32 windows.
export async function closeWindowsApp(pid: number): Promise<number> {
  const { dlopen, JSCallback, ptr } = await import("bun:ffi");
  const api = dlopen("user32.dll", {
    EnumWindows: { args: ["ptr", "i64"], returns: "i32" },
    GetWindowThreadProcessId: { args: ["u64", "ptr"], returns: "u32" },
    GetClassNameW: { args: ["u64", "ptr", "i32"], returns: "i32" },
    PostMessageW: { args: ["u64", "u32", "u64", "i64"], returns: "i32" },
  });
  const windows: bigint[] = [];
  const owner = new Uint32Array(1);
  const name = Buffer.alloc(512);
  const callback = new JSCallback(
    (window: bigint) => {
      api.symbols.GetWindowThreadProcessId(window, ptr(owner));
      const count = api.symbols.GetClassNameW(window, ptr(name), 256);
      if (
        owner[0] === pid &&
        name
          .subarray(0, count * 2)
          .toString("utf16le")
          .startsWith("bunaway-bun-")
      )
        windows.push(window);
      return 1;
    },
    { args: ["u64", "i64"], returns: "i32" },
  );
  try {
    api.symbols.EnumWindows(callback.ptr, 0n);
    for (const window of windows) {
      api.symbols.PostMessageW(window, 0x1f, 0n, 0n);
      api.symbols.PostMessageW(window, 0x10, 0n, 0n);
    }
    return windows.length;
  } finally {
    callback.close();
    api.close();
  }
}
