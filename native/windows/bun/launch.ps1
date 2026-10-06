param([switch]$Wait)
$ErrorActionPreference = 'Stop'
$package = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $package 'manifest.json') -Raw | ConvertFrom-Json
function Check([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "Package hash mismatch: $Path" }
}
$bun = Join-Path $package 'runtime/bun.exe'
# Filled from the framework pin at packaging; the manifest cannot choose a runtime.
Check $bun '__BUN_SHA256__'
foreach ($asset in $manifest.assets.PSObject.Properties) {
    if ($asset.Name -match '(^/|\\|(^|/)\.\.(/|$))') { throw 'Invalid asset path' }
    Check (Join-Path $package $asset.Name) $asset.Value
}
$start = [Diagnostics.ProcessStartInfo]::new($bun)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WorkingDirectory = Join-Path $package 'assets'
$start.EnvironmentVariables.Clear()
foreach ($name in @('SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $start.EnvironmentVariables[$name] = $value }
}
$start.EnvironmentVariables['PATH'] = Join-Path $env:SystemRoot 'System32'
# Windows PowerShell/.NET Framework has no ArgumentList. These are fixed relative paths.
$start.Arguments = '--no-env-file --no-install --config=./bunfig.toml --tsconfig-override=./tsconfig.json ./boot.js'
$process = [Diagnostics.Process]::Start($start)
if ($Wait) { $process.WaitForExit(); $code = $process.ExitCode; $process.Dispose(); exit $code }
$process.Dispose()
