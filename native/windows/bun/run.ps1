param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
& (Join-Path $PSScriptRoot 'prepare.ps1')
$bun = Join-Path $root 'runtime/bun-bundle/vendor/bun-windows-x64-baseline/bun.exe'
& $bun --no-env-file (Join-Path $PSScriptRoot 'package.ts')
if ($LASTEXITCODE -ne 0) { throw 'Windows package build failed' }
if (!$SkipTests) {
    foreach ($scenario in @('', '--modal', '--early-close', '--creation-failure')) {
        $arguments = @('--no-env-file', (Join-Path $root 'tests/lifecycle/windows-bun.ts'))
        if ($scenario) { $arguments += $scenario }
        & $bun @arguments
        if ($LASTEXITCODE -ne 0) { throw "Windows core scenario failed: $scenario" }
    }
    & $bun --no-env-file (Join-Path $root 'tests/lifecycle/windows-bun-window-api.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows public window API regression failed' }

    & $bun --no-env-file test (Join-Path $root 'tests/lifecycle/desktop.test.ts') (Join-Path $root 'tests/lifecycle/windows-bun-instance.test.ts') (Join-Path $root 'tests/cli/windows-assets.test.ts') (Join-Path $root 'tests/cli/windows-compile.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows instance and compiled app regression failed' }
    foreach ($scenario in @('hide', 'veto', 'dev-veto', 'dev-hide', 'dev-pending')) {
        & $bun --no-env-file (Join-Path $root 'tests/lifecycle/windows-desktop.ts') $scenario
        if ($LASTEXITCODE -ne 0) { throw "Windows desktop lifecycle failed: $scenario" }
    }
    & $bun --no-env-file (Join-Path $root 'tests/lifecycle/windows-bun-storage.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows handle storage regression failed' }
    & $bun --no-env-file (Join-Path $root 'tests/lifecycle/windows-storage-metadata.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows WebView2 storage metadata regression failed' }
    & $bun --no-env-file (Join-Path $root 'tests/lifecycle/windows-bun-cli.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows independent CLI regression failed' }
    & $bun --no-env-file (Join-Path $root 'tests/lifecycle/windows-app-reload.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows app reload regression failed' }
    & $bun --no-env-file (Join-Path $root 'tests/lifecycle/windows-host.ts') --package (Join-Path $root 'build/windows-bun-package')
    if ($LASTEXITCODE -ne 0) { throw 'Windows Bun regression failed' }
}
