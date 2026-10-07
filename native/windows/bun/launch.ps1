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
# Keep the JSON off the command line so UTF-8 encoding cannot exceed its character limit.
$launch = @{ argv = $launchArguments; cwd = $PWD.ProviderPath } | ConvertTo-Json -Compress
$launchBytes = [Text.Encoding]::UTF8.GetBytes($launch)
if ($launchArguments.Count -gt 256 -or $launchBytes.Length -gt 65536) { throw 'Invalid launch arguments' }
$start.RedirectStandardInput = $true
$start.Arguments = '--no-env-file --no-install --config=./bunfig.toml --tsconfig-override=./tsconfig.json ./boot.js --launch-stdin'
$process = [Diagnostics.Process]::Start($start)
try {
    try { $process.StandardInput.BaseStream.Write($launchBytes, 0, $launchBytes.Length) }
    # Close the pipe without writing through the console's text encoding.
    finally { $process.StandardInput.BaseStream.Close() }
    if ($waitForExit) { $process.WaitForExit(); exit $process.ExitCode }
} finally { $process.Dispose() }
