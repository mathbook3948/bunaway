$ErrorActionPreference = 'Stop'
# Avoid parameter binding so -- and PowerShell common-parameter names stay app arguments.
$launchArguments = @($args)
$waitForExit = $launchArguments.Count -gt 0 -and $launchArguments[0] -ieq '-Wait'
if ($waitForExit) { $launchArguments = @($launchArguments | Select-Object -Skip 1) }
$package = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $package 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Check([string]$Path, [string]$Expected) {
    # Do not depend on module discovery inherited from another PowerShell version.
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        if ($actual -ne $Expected) { throw "Package hash mismatch: $Path" }
    } finally {
        if ($stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}
$bun = Join-Path $package 'runtime/bun.exe'
# Filled from the framework pin at build, then rebound to signed bytes at packaging.
# The manifest alone cannot choose which runtime this launcher starts.
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
# The payload contains no command-line metacharacters and keeps the caller's cwd.
$launch = @{ argv = $launchArguments; cwd = $PWD.ProviderPath } | ConvertTo-Json -Compress
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($launch))
# Windows PowerShell/.NET Framework has no ArgumentList. The encoded payload needs no quoting.
$start.Arguments = '--no-env-file --no-install --config=./bunfig.toml --tsconfig-override=./tsconfig.json ./boot.js --launch-payload ' + $payload
$process = [Diagnostics.Process]::Start($start)
if ($waitForExit) { $process.WaitForExit(); $code = $process.ExitCode; $process.Dispose(); exit $code }
$process.Dispose()
