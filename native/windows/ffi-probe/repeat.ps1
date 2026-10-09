param(
    [ValidateRange(1, 20)][int]$Repeat = 3,
    [ValidateSet('Basic', 'Worker', 'WorkerSize', 'WorkerEarlyClose', 'WorkerMulti')]
    [string[]]$Modes = @('Basic', 'Worker', 'WorkerSize', 'WorkerEarlyClose', 'WorkerMulti')
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$logs = Join-Path $root 'build/windows-ffi-probe'
$batch = Join-Path $logs ('repeat-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $batch | Out-Null
$results = @()
# Save source hashes with batch logs to tie results to this probe revision.
Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'main.ts'), (Join-Path $PSScriptRoot 'worker.ts'), (Join-Path $PSScriptRoot 'ui.ts'), (Join-Path $PSScriptRoot 'run.ps1') -Algorithm SHA256 |
    Select-Object Path, Hash | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $batch 'sources.json') -Encoding utf8
for ($iteration = 1; $iteration -le $Repeat; $iteration++) {
    foreach ($mode in $Modes) {
        $name = "$iteration-$mode"
        $arguments = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'run.ps1'), '-Mode', $mode)
        & pwsh @arguments *> (Join-Path $batch "$name.driver.txt")
        $code = $LASTEXITCODE
        Copy-Item -LiteralPath (Join-Path $logs "$mode.ndjson") -Destination (Join-Path $batch "$name.ndjson")
        Copy-Item -LiteralPath (Join-Path $logs "$mode.stderr.txt") -Destination (Join-Path $batch "$name.stderr.txt")
        $events = Get-Content -LiteralPath (Join-Path $batch "$name.ndjson") | ForEach-Object { $_ | ConvertFrom-Json }
        $shutdown = @($events | Where-Object event -eq 'browser-shutdown')
        $stderrText = Get-Content -LiteralPath (Join-Path $batch "$name.stderr.txt") -Raw
        $result = [ordered]@{
            run = $name; exitCode = $code
            browsers = @($shutdown | Select-Object viewId, pid, exited, elapsedMs)
            classWarning = [bool]($stderrText -match 'Failed to unregister class Chrome_WidgetWin_0')
        }
        $results += $result
        $result | ConvertTo-Json -Compress | Write-Output
        $results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $batch 'results.json') -Encoding utf8
    }
}
Write-Output "Batch evidence: $batch"
if ($results | Where-Object { $_.exitCode -ne 0 }) { exit 1 }
