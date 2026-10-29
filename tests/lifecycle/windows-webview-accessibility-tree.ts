import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkHresult } from "@bunaway/plugin/win32";
import { checkCallbacks, disposeCom } from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { loadUiaProbe } from "#plugins/appearance/src/platforms/windows-accessibility";
import { waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-accessibility-tree");
const assets = resolve(output, "assets");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
const CAPTION = "Accessibility tree regression";
const READING_NAME = "Accessibility tree reading name";
const BUTTON_NAME = "Run diagnostics";
const HEADING_NAME = "Accessibility tree heading";
const INPUT_NAME = "Search field";
await writeFile(
  resolve(assets, "web/index.html"),
  `<!doctype html><title>Accessibility tree</title>
  <h1>${HEADING_NAME}</h1>
  <button aria-label="${BUTTON_NAME}">Go</button>
  <input type="text" aria-label="${INPUT_NAME}">`,
);
// The test process hosts the window, so a second process plays the screen reader: it reads
// the tree through the same managed UI Automation client API and registers an event handler,
// which is what makes UiaClientsAreListening report a listening client.
const clientScript = resolve(output, "uia-client.ps1");
await writeFile(
  clientScript,
  `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, Accessibility -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class UiaListener {
  [DllImport("oleacc.dll")]
  static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out object accessible);
  /** The MSAA name of the window client object, which is where the annotation is applied. */
  public static string MsaaName(IntPtr hwnd) {
    Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    object accessible;
    int result = AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC, ref iid, out accessible);
    if (result < 0) { return "hresult " + result.ToString("x"); }
    return ((Accessibility.IAccessible)accessible).get_accName(0);
  }
  static void OnChanged(object sender, StructureChangedEventArgs args) { }
  public static void Add(IntPtr hwnd) {
    AutomationElement window = AutomationElement.FromHandle(hwnd);
    Automation.AddStructureChangedEventHandler(window, TreeScope.Subtree, OnChanged);
  }
  public static void Remove() { Automation.RemoveAllEventHandlers(); }
}
'@
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$hwnd = [IntPtr]::Zero
function Emit($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
Emit @{ ready = $true }
while ($true) {
  $command = [Console]::In.ReadLine()
  if ($null -eq $command -or $command -eq 'quit') { break }
  try {
    if ($command.StartsWith('hwnd ')) {
      $hwnd = [IntPtr]::new([int64]$command.Substring(5))
      Emit @{ attached = $true }
    } elseif ($command -eq 'window') {
      $element = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
      Emit @{ name = $element.Current.Name; msaa = [UiaListener]::MsaaName($hwnd) }
    } elseif ($command -eq 'tree') {
      $element = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
      $all = $element.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
      $nodes = @()
      foreach ($node in $all) {
        $nodes += @{ type = $node.Current.ControlType.ProgrammaticName; name = $node.Current.Name }
      }
      Emit @{ nodes = $nodes }
    } elseif ($command -eq 'listen') {
      [UiaListener]::Add($hwnd)
      Emit @{ listening = $true }
    } elseif ($command -eq 'unlisten') {
      [UiaListener]::Remove()
      Emit @{ listening = $false }
    }
  } catch {
    Emit @{ error = $_.Exception.Message }
  }
}
`,
);
checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
const probe = loadUiaProbe();
let hwnd = 0n;
let webview: WebView | undefined;
let documents = 0;
let browserVersion = "";
let verified = false;
const lines: string[] = [];
const client = Bun.spawn(
  [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    clientScript,
  ],
  {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const errors: string[] = [];
const collect = async (
  stream: ReadableStream<Uint8Array>,
  into: string[],
  split: boolean,
) => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, {
      stream: true,
    });
    if (!split) {
      continue;
    }
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    into.push(...parts.filter((part) => part.trim()));
  }
  if (pending.trim()) {
    into.push(pending);
  }
};
const reading = collect(client.stdout, lines, true);
const readingErrors = collect(client.stderr, errors, true);
const results: Record<string, unknown> = {};
try {
  hwnd = windows.create(CAPTION, 640, 480, () => {});
  webview = new WebView(
    hwnd,
    {
      view: "main",
      title: CAPTION,
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
      },
    },
    assets,
    resolve(output, `data-${crypto.randomUUID()}`),
    resolve(
      root,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    [
      "https://app.bunaway.local",
    ],
    {
      message() {},
      revoke() {},
      sameDocument() {},
      close() {
        throw new Error("Unexpected close before cleanup");
      },
      ready() {
        webview?.navigate();
      },
      documentComplete(error) {
        assert.equal(error, null);
        documents++;
      },
      log(event, data) {
        if (event === "webview-ready" && data && "browserVersion" in data) {
          browserVersion = String(data.browserVersion);
        }
      },
    },
  );
  const created = webview;
  const pump = <T>(done: () => T | false | undefined, what: string) =>
    waitFor(
      () => {
        windows.pump();
        checkCallbacks();
        return done() || undefined;
      },
      {
        deadline: "nativeFixture",
        what,
        intervalMs: 5,
        failed: () => created.failure,
      },
    );
  /** Repeat an asynchronous probe that itself pumps messages while it waits for the client. */
  const retry = <T>(
    probe: () => Promise<T | undefined>,
    what: string,
  ): Promise<T> =>
    waitFor(probe, {
      deadline: "nativeFixture",
      what,
      intervalMs: 100,
      failed: () => created.failure,
    });
  /** Send one command to the client process and pump until it answers with one JSON line. */
  const ask = async (command: string): Promise<Record<string, unknown>> => {
    const before = lines.length;
    client.stdin.write(`${command}\n`);
    client.stdin.flush();
    await pump(() => lines.length > before, `client answer to ${command}`);
    const answer = JSON.parse(lines[before] as string) as Record<
      string,
      unknown
    >;
    assert.equal(answer.error, undefined, `${command}: ${answer.error}`);
    lines.splice(before, 1);
    return answer;
  };
  await pump(() => lines.length >= 1, "client process start");
  lines.shift();
  await ask(`hwnd ${hwnd}`);
  await pump(() => documents >= 1, "first document");
  windows.show(hwnd, true);

  // (1) The reading name replaces the caption for MSAA clients; the UIA Name stays the caption.
  windows.setTitle(hwnd, CAPTION);
  windows.setAccessibleTitle(hwnd, READING_NAME);
  type WindowNames = {
    name: string;
    msaa: string;
  };
  /** Wait until the client reads `expected` as the MSAA name; return the UIA Name read with it. */
  const expectMsaaName = async (expected: string, what: string) => {
    let seen: WindowNames | undefined;
    await waitFor(
      async () => {
        seen = (await ask("window")) as WindowNames;
        return seen.msaa === expected || undefined;
      },
      {
        deadline: "childStep",
        what,
        intervalMs: 100,
        failed: () => created.failure,
      },
    ).catch((error: Error) => {
      throw new Error(
        `${error.message} (last UIA and MSAA names: ${JSON.stringify(seen)})`,
      );
    });
    return seen?.name;
  };
  results.uiaNameWithAccessibleTitle = await expectMsaaName(
    READING_NAME,
    "MSAA name from the accessible title",
  );
  assert.equal(windows.getTitle(hwnd), CAPTION);
  windows.setAccessibleTitle(hwnd, "");
  assert.equal(
    await expectMsaaName(CAPTION, "MSAA name back to the caption"),
    CAPTION,
  );
  assert.equal(windows.getTitle(hwnd), CAPTION);

  // (2) The document's controls reach the UIA tree with their roles and names.
  const baseline = probe.clientsAreListening();
  results.listeningBeforeClient = baseline;
  await ask("listen");
  type Node = {
    type: string;
    name: string;
  };
  let tree: Node[] = [];
  const has = (list: Node[], types: string[], name: string) =>
    list.some((node) => node.name === name && types.includes(node.type));
  const buttonTypes = [
    "ControlType.Button",
  ];
  const headingTypes = [
    "ControlType.Text",
    "ControlType.Header",
  ];
  const inputTypes = [
    "ControlType.Edit",
  ];
  const complete = (list: Node[]) =>
    has(list, buttonTypes, BUTTON_NAME) &&
    has(list, headingTypes, HEADING_NAME) &&
    has(list, inputTypes, INPUT_NAME);
  // Chromium builds its accessibility tree after a client connects, so the nodes arrive late.
  await retry(async () => {
    tree = (await ask("tree")).nodes as Node[];
    return complete(tree) || undefined;
  }, "WebView2 accessibility tree nodes");
  results.treeNodes = tree.length;

  // (3) A listening client makes the state true; dropping it lets the state fall back.
  assert.equal(
    probe.clientsAreListening(),
    true,
    "UiaClientsAreListening with a connected client",
  );
  await ask("unlisten");
  // The state may stay set until the client process ends; that is recorded, not asserted.
  const released = await waitFor(
    () => {
      windows.pump();
      return !probe.clientsAreListening() || undefined;
    },
    {
      deadline: "childStep",
      what: "UiaClientsAreListening after the handlers are removed",
      intervalMs: 20,
    },
  ).catch(() => false);
  results.falseAfterRemovingHandlers = released === true;
  client.stdin.write("quit\n");
  client.stdin.flush();
  await client.exited;
  // Windows may keep reporting a listener after the client is gone, so the outcome is recorded.
  results.falseAfterClientExit =
    released === true ||
    (await waitFor(
      () => {
        windows.pump();
        return !probe.clientsAreListening() || undefined;
      },
      {
        deadline: "childStep",
        what: "UiaClientsAreListening after the client exits",
        intervalMs: 20,
      },
    ).catch(() => false));
  verified = true;
} finally {
  client.kill();
  await Promise.allSettled([
    client.exited,
    reading,
    readingErrors,
  ]);
  if (webview) {
    webview.requestClose();
    const closing = webview;
    const pumpUntil = (done: () => boolean, what: string) =>
      waitFor(
        () => {
          windows.pump();
          return done() || undefined;
        },
        {
          deadline: "nativeFixture",
          what,
          intervalMs: 5,
        },
      );
    await pumpUntil(() => closing.detach(), "controller detach");
    windows.destroy(hwnd);
    hwnd = 0n;
    await pumpUntil(() => closing.finish(), "native resource release");
  }
  if (hwnd) {
    windows.destroy(hwnd);
  }
  probe.close();
  disposeCom();
  windows.dispose();
  ole.symbols.CoUninitialize();
  disposeWin32Bindings();
}
assert(verified);
await writeFile(
  resolve(root, "build/windows-webview-accessibility-tree-results.json"),
  JSON.stringify(
    {
      pass: true,
      browserVersion,
      ...results,
    },
    null,
    2,
  ),
);
console.log(
  "PASS an MSAA client reads the accessible window name; a UI Automation client reads the WebView2 button, heading and text input and flips the client connection state",
);
