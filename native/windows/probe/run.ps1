param([string]$Bun = (Get-Command bun -ErrorAction Stop).Source, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$pin = Get-Content -LiteralPath (Join-Path $root 'runtime/build-manifests/windows-x64.json') -Raw | ConvertFrom-Json
function Check-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "Hash mismatch: $Path" }
}
function Download([string]$Url, [string]$Path, [string]$Hash) {
    if (!(Test-Path -LiteralPath $Path)) { Invoke-WebRequest -Uri $Url -OutFile $Path }
    Check-Hash $Path $Hash
}
function Run([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
$cache = Join-Path $root 'runtime/bun-bundle/vendor'
$json = Join-Path $root 'native/windows/vendor'
New-Item -ItemType Directory -Force -Path $cache, $json | Out-Null
$archive = Join-Path $cache 'bun-windows-x64-baseline.zip'
Download $pin.bun.archiveUrl $archive $pin.bun.archiveSha256
$bundled = Join-Path $cache 'bun-windows-x64-baseline/bun.exe'
if (!(Test-Path -LiteralPath $bundled)) { Expand-Archive -LiteralPath $archive -DestinationPath $cache -Force }
Check-Hash $bundled $pin.bun.executableSha256
Download $pin.bun.licenseUrl (Join-Path $cache 'LICENSE.bun') $pin.bun.licenseSha256
Download $pin.json.headerUrl (Join-Path $json 'json.hpp') $pin.json.headerSha256
Download $pin.json.licenseUrl (Join-Path $json 'LICENSE.nlohmann-json') $pin.json.licenseSha256
if ((& $Bun --version) -ne $pin.bun.version) { throw 'Build Bun version must match the pin.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'MSVC C++ build tools are required to build this development probe.' }
. (Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
$env:VSLANG = '1033'
$build = Join-Path $root 'build/windows-probe'
Run 'cmake' @('-S', $PSScriptRoot, '-B', $build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release')
Run 'cmake' @('--build', $build)
Run $Bun @((Join-Path $root 'packages/protocol/scripts/generate.ts'))
Run $Bun @((Join-Path $root 'node_modules/@biomejs/biome/bin/biome'), 'format', '--write', (Join-Path $root 'native/host-api/generated'))
$package = Join-Path $root 'build/windows-probe-package'
New-Item -ItemType Directory -Force -Path $package, (Join-Path $package 'assets'), (Join-Path $package 'runtime'), (Join-Path $package 'licenses') | Out-Null
Copy-Item -LiteralPath (Join-Path $build 'bunaway-probe.exe') -Destination $package -Force
Copy-Item -LiteralPath $bundled -Destination (Join-Path $package 'runtime/bun.exe') -Force
Copy-Item -LiteralPath (Join-Path $cache 'LICENSE.bun'), (Join-Path $json 'LICENSE.nlohmann-json') -Destination (Join-Path $package 'licenses') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bunfig.toml'), (Join-Path $PSScriptRoot 'tsconfig.json'), (Join-Path $root 'native/host-api/generated/process.schema.json') -Destination (Join-Path $package 'assets') -Force
Run $Bun @('build', (Join-Path $PSScriptRoot 'backend.ts'), '--target=bun', '--outfile', (Join-Path $package 'assets/backend.js'))
$assets = [ordered]@{}
foreach ($directory in @('assets', 'licenses')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $package $directory) -File) {
        $assets["$directory/$($file.Name)"] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$pin | Add-Member -NotePropertyName assets -NotePropertyValue $assets -Force
$pin | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $package 'manifest.json') -Encoding utf8NoBOM
Write-Output "Probe package: $package"
if (!$SkipTests) { Run $Bun @((Join-Path $root 'tests/lifecycle/windows-process.ts'), '--package', $package) }
