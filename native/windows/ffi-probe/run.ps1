param(
    [ValidateSet('Basic', 'EarlyClose', 'Modal', 'Worker', 'WorkerSize', 'WorkerEarlyClose', 'WorkerMulti')][string]$Mode = 'Worker'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$pin = Get-Content -LiteralPath (Join-Path $root 'runtime/build-manifests/windows-x64.json') -Raw | ConvertFrom-Json
$deps = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../host/deps.json') -Raw | ConvertFrom-Json
function Check-Hash([string]$Path, [string]$Hash) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw "Hash mismatch: $Path" }
}
function Download([string]$Url, [string]$Path, [string]$Hash) {
    if (!(Test-Path -LiteralPath $Path)) { Invoke-WebRequest -Uri $Url -OutFile $Path }
    Check-Hash $Path $Hash
}
$cache = Join-Path $root 'runtime/bun-bundle/vendor'
$sdkCache = Join-Path $PSScriptRoot '../host/vendor'
$results = Join-Path $root 'build/windows-ffi-probe'
New-Item -ItemType Directory -Force -Path $cache, $sdkCache, $results | Out-Null
$archive = Join-Path $cache 'bun-windows-x64-baseline.zip'
Download $pin.bun.archiveUrl $archive $pin.bun.archiveSha256
$bun = Join-Path $cache 'bun-windows-x64-baseline/bun.exe'
if (!(Test-Path -LiteralPath $bun)) { Expand-Archive -LiteralPath $archive -DestinationPath $cache }
Check-Hash $bun $pin.bun.executableSha256
Download $pin.bun.licenseUrl (Join-Path $cache 'LICENSE.bun') $pin.bun.licenseSha256
$sdkArchive = Join-Path $sdkCache ('webview2-sdk-' + $deps.webview2Sdk.version + '.nupkg')
Download $deps.webview2Sdk.archiveUrl $sdkArchive $deps.webview2Sdk.archiveSha256
$sdk = Join-Path $sdkCache 'sdk'
if (!(Test-Path -LiteralPath $sdk)) { Expand-Archive -LiteralPath $sdkArchive -DestinationPath $sdk }
foreach ($entry in $deps.webview2Sdk.files.PSObject.Properties) {
    Check-Hash (Join-Path $sdk $entry.Name) $entry.Value
}
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
