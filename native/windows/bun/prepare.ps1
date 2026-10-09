param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$pin = Get-Content -LiteralPath (Join-Path $root 'runtime/build-manifests/windows-x64.json') -Raw | ConvertFrom-Json
$sdk = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deps.json') -Raw | ConvertFrom-Json).webview2Sdk
# VerifyOnly requires existing artifacts and never downloads or unpacks dependencies.
function Fetch([string]$Url, [string]$Path, [string]$Expected) {
    if (!(Test-Path -LiteralPath $Path)) {
        if ($VerifyOnly) { throw "Missing dependency: $Path" }
        Invoke-WebRequest -Uri $Url -OutFile $Path
    }
    Verify $Path $Expected
}
function Verify([string]$Path, [string]$Expected) {
    if (!(Test-Path -LiteralPath $Path)) { throw "Missing extracted dependency: $Path" }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "Hash mismatch: $Path" }
}
$cache = Join-Path $root 'build/cache/bun'
$vendor = Join-Path $root 'build/cache/webview2'
New-Item -ItemType Directory -Force -Path $cache, $vendor | Out-Null
$archive = Join-Path $cache 'bun-windows-x64-baseline.zip'
Fetch $pin.bun.archiveUrl $archive $pin.bun.archiveSha256
$bun = Join-Path $cache 'bun-windows-x64-baseline/bun.exe'
if (!(Test-Path -LiteralPath $bun) -and !$VerifyOnly) { Expand-Archive -LiteralPath $archive -DestinationPath $cache }
Verify $bun $pin.bun.executableSha256
Fetch $pin.bun.licenseUrl (Join-Path $cache 'LICENSE.bun') $pin.bun.licenseSha256
$sdkArchive = Join-Path $vendor ('webview2-' + $sdk.version + '.nupkg')
Fetch $sdk.archiveUrl $sdkArchive $sdk.archiveSha256
$unpacked = Join-Path $vendor 'sdk'
if (!(Test-Path -LiteralPath $unpacked) -and !$VerifyOnly) { Expand-Archive -LiteralPath $sdkArchive -DestinationPath $unpacked }
foreach ($file in @('build/native/x64/WebView2Loader.dll', 'LICENSE.txt')) {
    Verify (Join-Path $unpacked $file) $sdk.files.$file
}
Write-Output "Windows Bun/FFI dependencies verified; no native compilation."
