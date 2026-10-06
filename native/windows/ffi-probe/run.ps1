param(
    [ValidateSet('Basic', 'EarlyClose', 'Modal', 'Worker', 'WorkerSize', 'WorkerEarlyClose', 'WorkerMulti')][string]$Mode = 'Worker'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
& (Join-Path $PSScriptRoot '../bun/prepare.ps1')
$bun = Join-Path $root 'runtime/bun-bundle/vendor/bun-windows-x64-baseline/bun.exe'
$results = Join-Path $root 'build/windows-ffi-probe'
New-Item -ItemType Directory -Force -Path $results | Out-Null
# This child is the test subject, not a native app host. No C/C++ build is involved.
$start = [Diagnostics.ProcessStartInfo]::new($bun)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WorkingDirectory = $root
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.ArgumentList.Add('--no-env-file')
$entry = if ($Mode.StartsWith('Worker')) { 'worker.ts' } else { 'main.ts' }
$start.ArgumentList.Add((Join-Path $PSScriptRoot $entry))
if ($Mode -in @('EarlyClose', 'WorkerEarlyClose')) { $start.ArgumentList.Add('--early-close') }
if ($Mode -eq 'Modal') { $start.ArgumentList.Add('--modal') }
if ($Mode -eq 'WorkerSize') { $start.ArgumentList.Add('--size') }
if ($Mode -eq 'WorkerMulti') { $start.ArgumentList.Add('--multi') }
$process = [Diagnostics.Process]::Start($start)
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$timedOut = !$process.WaitForExit(30000)
if ($timedOut) { $process.Kill($true); $process.WaitForExit() }
$out = $stdout.GetAwaiter().GetResult()
$err = $stderr.GetAwaiter().GetResult()
[IO.File]::WriteAllText((Join-Path $results "$Mode.ndjson"), $out)
[IO.File]::WriteAllText((Join-Path $results "$Mode.stderr.txt"), $err)
Write-Output $out
if ($err) { Write-Output $err }
$code = $process.ExitCode
$process.Dispose()
if ($timedOut) { throw "FFI probe timed out; its process tree was terminated. Logs: $results" }
foreach ($line in ($out -split "`n" | Where-Object { $_.Trim() })) {
    $event = $line | ConvertFrom-Json
    if ($event.event -ne 'browser-process') { continue }
    $browser = Get-Process -Id $event.pid -ErrorAction SilentlyContinue
    $browserExited = $true
    if ($browser) {
        $browserExited = $browser.WaitForExit(5000)
        $browser.Dispose()
    }
    $browserResult = @{ event = 'browser-exit-check'; pid = $event.pid; exited = $browserExited; timeoutMs = 5000 } | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $results "$Mode.ndjson") -Value $browserResult -Encoding utf8
    Write-Output $browserResult
    if (!$browserExited) { throw "WebView2 browser $($event.pid) survived probe shutdown." }
    Write-Output "WebView2 browser $($event.pid) exited."
}
if ($code -ne 0) { throw "FFI $Mode gate failed with exit code $code. Logs: $results" }
Write-Output "FFI $Mode passed. Logs: $results"
