param([string]$Bun = (Get-Command bun -ErrorAction Stop).Source, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$pin = Get-Content -LiteralPath (Join-Path $root 'runtime/build-manifests/windows-x64.json') -Raw | ConvertFrom-Json
$deps = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deps.json') -Raw | ConvertFrom-Json
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
New-Item -ItemType Directory -Force -Path $cache, (Join-Path $root 'native/windows/vendor') | Out-Null
$archive = Join-Path $cache 'bun-windows-x64-baseline.zip'
Download $pin.bun.archiveUrl $archive $pin.bun.archiveSha256
$bundled = Join-Path $cache 'bun-windows-x64-baseline/bun.exe'
if (!(Test-Path -LiteralPath $bundled)) { Expand-Archive -LiteralPath $archive -DestinationPath $cache -Force }
Check-Hash $bundled $pin.bun.executableSha256
Download $pin.bun.licenseUrl (Join-Path $cache 'LICENSE.bun') $pin.bun.licenseSha256
$jsonDir = Join-Path $root 'native/windows/vendor'
Download $pin.json.headerUrl (Join-Path $jsonDir 'json.hpp') $pin.json.headerSha256
Download $pin.json.licenseUrl (Join-Path $jsonDir 'LICENSE.nlohmann-json') $pin.json.licenseSha256
# WebView2 SDK: pinned nupkg with per-file hashes verified on extraction.
$sdkDir = Join-Path $PSScriptRoot 'vendor/webview2'
$sdkPkg = Join-Path $PSScriptRoot ("vendor/webview2-sdk-" + $deps.webview2Sdk.version + ".nupkg")
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'vendor') | Out-Null
Download $deps.webview2Sdk.archiveUrl $sdkPkg $deps.webview2Sdk.archiveSha256
foreach ($entry in $deps.webview2Sdk.files.PSObject.Properties) {
    $name = $entry.Name
    $out = switch -Regex ($name) {
        '^build/native/include/(.+)$' { Join-Path $sdkDir "include/$($Matches[1])" }
        '^build/native/x64/(.+)$' { Join-Path $sdkDir "lib/x64/$($Matches[1])" }
        '^LICENSE\.txt$' { Join-Path $sdkDir $deps.webview2Sdk.license }
        default { $null }
    }
    if ($null -eq $out) { continue }
    if (!(Test-Path -LiteralPath $out)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
        $temp = Join-Path $env:TEMP ("wv2-" + [IO.Path]::GetRandomFileName())
        Expand-Archive -LiteralPath $sdkPkg -DestinationPath $temp -Force
        Copy-Item -LiteralPath (Join-Path $temp $name.Replace('/', [IO.Path]::DirectorySeparatorChar)) -Destination $out -Force
        Remove-Item -Recurse -Force $temp
    }
    Check-Hash $out $entry.Value
}
if ((& $Bun --version) -ne $pin.bun.version) { throw 'Build Bun version must match the pin.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'MSVC C++ build tools are required to build this host.' }
. (Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
$env:VSLANG = '1033'
$build = Join-Path $root 'build/windows-host'
Run 'cmake' @('-S', $PSScriptRoot, '-B', $build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release')
Run 'cmake' @('--build', $build)
Run $Bun @((Join-Path $root 'packages/protocol/scripts/generate.ts'))
Run $Bun @((Join-Path $root 'node_modules/@biomejs/biome/bin/biome'), 'format', '--write', (Join-Path $root 'native/host-api/generated'))
$package = Join-Path $root 'build/windows-host-package'
New-Item -ItemType Directory -Force -Path $package, (Join-Path $package 'assets'), (Join-Path $package 'assets/web'), (Join-Path $package 'runtime'), (Join-Path $package 'licenses') | Out-Null
Copy-Item -LiteralPath (Join-Path $build 'bunaway-host.exe') -Destination $package -Force
Copy-Item -LiteralPath $bundled -Destination (Join-Path $package 'runtime/bun.exe') -Force
Copy-Item -LiteralPath (Join-Path $cache 'LICENSE.bun'), (Join-Path $jsonDir 'LICENSE.nlohmann-json'), (Join-Path $sdkDir $deps.webview2Sdk.license) -Destination (Join-Path $package 'licenses') -Force
$generated = Join-Path $root 'native/host-api/generated'
$assets = @('bunfig.toml', 'tsconfig.json', 'app.json', 'policy.json')
foreach ($name in $assets) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "test/$name") -Destination (Join-Path $package 'assets') -Force }
foreach ($name in @('process.schema.json', 'message.schema.json', 'policy.schema.json', 'host-call.schema.json', 'host-operations.json')) {
    Copy-Item -LiteralPath (Join-Path $generated $name) -Destination (Join-Path $package 'assets') -Force
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'test/web') -File) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $package 'assets/web') -Force
}
Run $Bun @('build', (Join-Path $PSScriptRoot 'test/backend.ts'), '--target=bun', '--outfile', (Join-Path $package 'assets/backend.js'))
$hashes = [ordered]@{}
foreach ($directory in @('assets', 'licenses')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $package $directory) -File -Recurse) {
        $relative = $file.FullName.Substring($package.Length + 1).Replace('\', '/')
        $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$pin | Add-Member -NotePropertyName assets -NotePropertyValue $hashes -Force
$pin | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $package 'manifest.json') -Encoding utf8NoBOM
Write-Output "Host package: $package"
if (!$SkipTests) {
    Run (Join-Path $build 'windows-host-regressions.exe') @($package)
    Run $Bun @((Join-Path $root 'tests/lifecycle/windows-host.ts'), '--package', $package)
}
