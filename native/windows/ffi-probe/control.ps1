param([ValidateRange(1, 10)][int]$Repeat = 3)
$ErrorActionPreference = 'Stop'
# Diagnostic control only: official managed WebView2 with a WinForms message loop.
# Never loaded by the Bun implementation. Windows PowerShell supplies .NET Framework.
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$sdk = Join-Path $PSScriptRoot '../bun/vendor/sdk'
$deps = Get-Content (Join-Path $PSScriptRoot '../bun/deps.json') -Raw | ConvertFrom-Json
$archive = Join-Path $PSScriptRoot ('../bun/vendor/webview2-' + $deps.webview2Sdk.version + '.nupkg')
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $deps.webview2Sdk.archiveSha256) { throw 'SDK archive hash mismatch' }
$output = Join-Path $root ('build/windows-ffi-probe/control-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $output | Out-Null
$source = @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public static class WebViewControlProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern bool SetDllDirectory(string path);
  static void Log(string name, double ms) {
    Console.WriteLine("{\"event\":\"" + name + "\",\"elapsedMs\":" + ms.ToString("F3", CultureInfo.InvariantCulture) + "}");
  }
  public static int Run(string sdk, string root) {
    if (!SetDllDirectory(Path.Combine(sdk, "build/native/x64"))) throw new Exception("SetDllDirectory failed");
    Application.EnableVisualStyles();
    var context = new ApplicationContext();
    var form = new Form { Text="WebView2 official control diagnostic", Width=640, Height=480 };
    var web = new WebView2 { Dock=DockStyle.Fill };
    form.Controls.Add(web);
    var clock = new Stopwatch();
    var lifetime = Stopwatch.StartNew();
    var timer = new System.Windows.Forms.Timer { Interval=5 };
    CoreWebView2Environment environment = null;
    Process browser = null;
    bool started=false, closing=false, signalled=false, exited=false, failed=false;
    double exitMs=0;
    timer.Tick += (s,e) => {
      if (closing && !signalled && browser != null && browser.HasExited) {
        signalled=true; Log("browser-handle-signalled", clock.Elapsed.TotalMilliseconds);
      }
      if (exited || (closing && clock.ElapsedMilliseconds >= 15000) || lifetime.ElapsedMilliseconds >= 25000) context.ExitThread();
    };
    EventHandler idle = null;
    idle = async (s,e) => {
      if (started) return;
      started=true; Application.Idle -= idle;
      try {
        var profile=Path.Combine(root, "profile-control-" + Process.GetCurrentProcess().Id);
        environment=await CoreWebView2Environment.CreateAsync(null, profile);
        await web.EnsureCoreWebView2Async(environment);
        var core=web.CoreWebView2;
        browser=Process.GetProcessById((int)core.BrowserProcessId);
        var handle=browser.Handle; // Retain this process identity across PID reuse.
        Console.WriteLine("{\"event\":\"control-runtime\",\"version\":\"" + environment.BrowserVersionString + "\",\"pid\":" + browser.Id + "}");
        environment.BrowserProcessExited += (sender,args) => {
          if (args.BrowserProcessId != browser.Id || (int)args.BrowserProcessExitKind != 0) failed=true;
          exited=true; exitMs=clock.Elapsed.TotalMilliseconds; Log("browser-exited", exitMs);
        };
        core.WebMessageReceived += (sender,args) => {
          if (args.TryGetWebMessageAsString() != "rendered" || closing) { failed=true; return; }
          Log("rendered", lifetime.Elapsed.TotalMilliseconds);
          SynchronizationContext.Current.Post(_ => {
            closing=true; clock.Restart();
            web.Dispose(); // Official control owns the COM Close/Release sequence.
            form.Dispose();
            Log("window-closed", clock.Elapsed.TotalMilliseconds);
          }, null);
        };
        core.NavigateToString("<!doctype html><h1>Official WebView2 control</h1><script>requestAnimationFrame(()=>chrome.webview.postMessage('rendered'))</script>");
      } catch (Exception error) {
        failed=true; Console.Error.WriteLine(error); context.ExitThread();
      }
    };
    Application.Idle += idle;
    form.Show(); timer.Start();
    Application.Run(context);
    timer.Dispose(); web.Dispose(); form.Dispose();
    GC.KeepAlive(environment);
    if (browser != null) browser.Dispose();
    Log(exited ? "control-complete" : "control-timeout", clock.Elapsed.TotalMilliseconds);
    return !failed && exited && exitMs <= 5000 ? 0 : 1;
  }
}
'@
$sourcePath = Join-Path $output 'control.cs'
Set-Content -LiteralPath $sourcePath -Value $source -Encoding utf8
$child = @'
param($sdk, $source, $root)
$ErrorActionPreference='Stop'
$core=Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$forms=Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
Add-Type -Path $core
Add-Type -Path $forms
Add-Type -Path $source -ReferencedAssemblies $core,$forms,'System.Windows.Forms','System.Drawing'
exit [WebViewControlProbe]::Run($sdk, $root)
'@
$childPath = Join-Path $output 'child.ps1'
Set-Content -LiteralPath $childPath -Value $child -Encoding utf8
$results = @()
for ($iteration=1; $iteration -le $Repeat; $iteration++) {
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'))
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    foreach ($argument in @('-NoProfile','-STA','-File',$childPath,$sdk,$sourcePath,(Join-Path $root 'build/windows-ffi-probe'))) { $start.ArgumentList.Add($argument) }
    $process=[Diagnostics.Process]::Start($start)
    $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
    $timedOut=!$process.WaitForExit(35000)
    if ($timedOut) { $process.Kill($true); $process.WaitForExit() }
    [IO.File]::WriteAllText((Join-Path $output "$iteration.ndjson"), $stdout.GetAwaiter().GetResult())
    [IO.File]::WriteAllText((Join-Path $output "$iteration.stderr.txt"), $stderr.GetAwaiter().GetResult())
    $result=@{run=$iteration; exitCode=$process.ExitCode; timedOut=$timedOut}
    $process.Dispose(); $results += $result
    $result | ConvertTo-Json -Compress | Write-Output
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'results.json') -Encoding utf8
Write-Output "Control evidence: $output"
if ($results | Where-Object exitCode -ne 0) { exit 1 }
