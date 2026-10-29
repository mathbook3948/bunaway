import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { attemptAllAsync } from "@bunaway/plugin";
import { checkHresult } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { checkCallbacks, disposeCom } from "#native/windows/bun/com";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-taskbar-progress");
await mkdir(output, {
  recursive: true,
});
const CAPTION = `Taskbar progress ${crypto.randomUUID()}`;
// The test process owns the window and sets the progress; a second process plays the UI Automation
// client, finds the window's button in the Explorer taskbar and reports every property it can read.
const clientScript = resolve(output, "taskbar-client.ps1");
await writeFile(
  clientScript,
  `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Emit($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
function Describe($element) {
  $result = @{
    name = $element.Current.Name
    className = $element.Current.ClassName
    automationId = $element.Current.AutomationId
    controlType = $element.Current.ControlType.ProgrammaticName
    helpText = $element.Current.HelpText
  }
  $patterns = @()
  foreach ($pattern in $element.GetSupportedPatterns()) { $patterns += $pattern.ProgrammaticName }
  $result.patterns = $patterns
  # Only supported patterns are read, so a failure here is a real UI Automation error and fails the command.
  if ($patterns -contains 'RangeValuePatternIdentifiers.Pattern') {
    $range = $element.GetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern)
    $result.range = @{ value = $range.Current.Value; minimum = $range.Current.Minimum; maximum = $range.Current.Maximum }
  }
  if ($patterns -contains 'ValuePatternIdentifiers.Pattern') {
    $value = $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $result.valuePattern = $value.Current.Value
  }
  if ($patterns -contains 'LegacyIAccessiblePatternIdentifiers.Pattern') {
    $legacy = $element.GetCurrentPattern([Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $result.legacy = @{
      name = $legacy.Current.Name
      value = $legacy.Current.Value
      state = [int64]$legacy.Current.State
      description = $legacy.Current.Description
      role = [int64]$legacy.Current.Role
    }
  }
  return $result
}
# The taskbar groups buttons per process, so the button is named after the executable, not the caption.
function FindGroups() {
  $root = [Windows.Automation.AutomationElement]::RootElement
  $list = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'MSTaskListWClass')))
  if ($null -eq $list) { return @{ list = $false; buttons = @() } }
  $buttons = @()
  foreach ($node in $list.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
    if ($node.Current.Name -like 'Bun - *') { $buttons += $node }
  }
  return @{ list = $true; buttons = $buttons }
}
Emit @{ ready = $true }
while ($true) {
  $command = [Console]::In.ReadLine()
  if ($null -eq $command -or $command -eq 'quit') { break }
  try {
    if ($command -eq 'button') {
      $found = FindGroups
      $described = @()
      foreach ($node in $found.buttons) { $described += (Describe $node) }
      Emit @{ taskList = $found.list; count = $described.Count; button = $described | Select-Object -First 1 }
    }
  } catch {
    Emit @{ error = $_.Exception.Message }
  }
}
`,
);
checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
type Progress = Parameters<Windows["setTaskbarProgress"]>[1];
let windows: Windows | undefined;
let hwnd = 0n;
let quit = false;
const lines: string[] = [];
const errors: string[] = [];
const client = Bun.spawn(
  [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    clientScript,
  ],
  {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const collect = async (stream: ReadableStream<Uint8Array>, into: string[]) => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, {
      stream: true,
    });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    into.push(...parts.filter((part) => part.trim()));
  }
  if (pending.trim()) {
    into.push(pending);
  }
};
const reading = collect(client.stdout, lines);
const readingErrors = collect(client.stderr, errors);
const results: Record<string, unknown> = {};
const summary: Record<string, unknown> = {};
const states: Array<
  [
    string,
    Progress,
  ]
> = [
  [
    "none-initial",
    {
      state: "none",
    },
  ],
  [
    "normal-25",
    {
      state: "normal",
      value: 0.25,
    },
  ],
  [
    "normal-75",
    {
      state: "normal",
      value: 0.75,
    },
  ],
  [
    "paused-75",
    {
      state: "paused",
      value: 0.75,
    },
  ],
  [
    "error-75",
    {
      state: "error",
      value: 0.75,
    },
  ],
  [
    "indeterminate",
    {
      state: "indeterminate",
    },
  ],
  [
    "none",
    {
      state: "none",
    },
  ],
];
try {
  const host = new Windows(() => {});
  windows = host;
  const clientFailure = () =>
    client.exitCode === null
      ? undefined
      : new Error(
          `UI Automation client exited (${client.exitCode}): ${errors.join("\n")}`,
        );
  const pump = <T>(done: () => T | false | undefined, what: string) =>
    waitFor(
      () => {
        host.pump();
        checkCallbacks();
        return done() || undefined;
      },
      {
        deadline: "nativeFixture",
        what,
        intervalMs: 5,
        failed: clientFailure,
      },
    );
  /** Send one command to the client and pump until it answers with one JSON line. */
  const ask = async (command: string): Promise<Record<string, unknown>> => {
    const before = lines.length;
    client.stdin.write(`${command}\n`);
    client.stdin.flush();
    await pump(() => lines.length > before, `client answer to ${command}`);
    const line = lines.splice(before, 1)[0] as string;
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`client answered ${command} with non-JSON text: ${line}`);
    }
    assert.equal(answer.error, undefined, `${command}: ${answer.error}`);
    return answer;
  };
  await pump(() => lines.length >= 1, "client process start");
  lines.shift();
  hwnd = host.create(CAPTION, 640, 480, () => {});
  host.show(hwnd, true);
  /** Set progress, retrying while Explorer has not yet created the taskbar button. */
  const setProgress = (progress: Progress) =>
    pump(() => {
      try {
        host.setTaskbarProgress(hwnd, progress);
        return true;
      } catch (error) {
        if (error instanceof BunawayError && error.code === "BUSY") {
          return undefined;
        }
        throw error;
      }
    }, "taskbar button creation");
  for (const [label, progress] of states) {
    await setProgress(progress);
    // Explorer accepted the call (no BUSY or native failure); now read the button it drew.
    const answer = await ask("button");
    assert.equal(answer.taskList, true, "Explorer taskbar task list");
    // Exactly one Bun group button; it must disappear with the window below, which ties it to this window.
    assert.equal(
      answer.count,
      1,
      `${label}: expected one Bun taskbar button (${JSON.stringify(answer)})`,
    );
    results[label] = answer.button;
  }
  // Explorer's grouped button exposes its name and Invoke only. Whether any state reaches a property is
  // recorded, not asserted: the fill and colour of the progress are not asserted.
  const readings = Object.values(results) as Array<{
    name: string;
    patterns: string[];
    range?: unknown;
    legacy?: unknown;
    valuePattern?: unknown;
  }>;
  summary.buttonName = readings[0]?.name;
  summary.patterns = readings[0]?.patterns;
  summary.exposesProgress = readings.some(
    (reading) => reading.range || reading.legacy || reading.valuePattern,
  );
  summary.distinctReadings = new Set(
    readings.map((reading) => JSON.stringify(reading)),
  ).size;
  // Destroying the window removes its group button.
  host.destroy(hwnd);
  hwnd = 0n;
  await waitFor(
    async () => {
      host.pump();
      return (await ask("button")).count === 0 || undefined;
    },
    {
      deadline: "childStep",
      what: "taskbar button removal after the window is destroyed",
      intervalMs: 100,
      failed: clientFailure,
    },
  );
  client.stdin.write("quit\n");
  client.stdin.flush();
  assert.equal(
    await pump(() => client.exitCode ?? undefined, "client exit"),
    0,
  );
  quit = true;
} finally {
  const host = windows;
  await attemptAllAsync(
    [
      () => {
        if (!quit) {
          client.kill();
        }
      },
      async () => {
        await Promise.allSettled([
          client.exited,
          reading,
          readingErrors,
        ]);
      },
      () => {
        if (hwnd) {
          host?.destroy(hwnd);
        }
      },
      () => disposeCom(),
      () => host?.dispose(),
      () => ole.symbols.CoUninitialize(),
      () => disposeWin32Bindings(),
    ],
    "Taskbar progress test cleanup",
  );
}
await writeFile(
  resolve(root, "build/windows-taskbar-progress-results.json"),
  JSON.stringify(
    {
      pass: true,
      ...summary,
      results,
    },
    null,
    2,
  ),
);
console.log(
  `PASS the taskbar accepts every progress state and its button is read through UI Automation ${JSON.stringify(summary)}`,
);
