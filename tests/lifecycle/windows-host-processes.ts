import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { viewDirName } from "../../native/windows/bun/view-profile.ts";

export async function rendererPids(
  dataRoot: string,
  viewId: string,
  legacyProfile = false,
) {
  // Select only renderers belonging to this view's WebView user-data directory.
  const inventory = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BUNAWAY_TEST_WEB_DATA) -and $_.CommandLine.Contains('--type=renderer') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress",
    ],
    {
      env: {
        ...process.env,
        BUNAWAY_TEST_WEB_DATA: legacyProfile
          ? join(dataRoot, "webview")
          : join(dataRoot, "webview", viewDirName(viewId)),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const pidsText = await new Response(inventory.stdout).text();
  assert.equal(
    await inventory.exited,
    0,
    await new Response(inventory.stderr).text(),
  );
  const parsed = JSON.parse(pidsText || "[]") as number[] | number;
  return Array.isArray(parsed)
    ? parsed
    : [
        parsed,
      ];
}

// taskkill delivers WM_CLOSE to only one top-level window per call. A real
// multi-window app needs WM_CLOSE on every window, like a session logoff does.
export async function closeAllWindows(pid: number) {
  const script = `
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<IntPtr> WindowsOf(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
Add-Type -TypeDefinition $src
foreach ($h in [Win32]::WindowsOf([uint32]$env:BUNAWAY_CLOSE_PID)) {
  [void][Win32]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
`;
  const poster = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      script,
    ],
    {
      env: {
        ...process.env,
        BUNAWAY_CLOSE_PID: String(pid),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  assert.equal(
    await poster.exited,
    0,
    await new Response(poster.stderr).text(),
  );
}

export async function watch(pids: number[]) {
  const watcher = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "windows-bun-process.ts"),
      "--watch",
      ...pids.map(String),
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = watcher.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  assert.equal(new TextDecoder().decode(first.value), "watch-ready\n");
  return async () => {
    assert.equal(
      await watcher.exited,
      0,
      "Captured OS process handles must signal exit",
    );
    assert.equal(await new Response(watcher.stderr).text(), "");
  };
}
