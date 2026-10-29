# Installs the pinned Inno Setup compiler for all users. Shared by the composite action and by
# tests/lifecycle/windows-template-installer.ts, so the version and checksum have one definition.
$ErrorActionPreference = 'Stop'
$downloadDirectory = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$installer = Join-Path $downloadDirectory 'innosetup-6.7.3.exe'
Invoke-WebRequest -Uri 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe' -OutFile $installer
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732') {
  throw 'Inno Setup installer checksum mismatch.'
}
$installation = Start-Process -FilePath $installer -ArgumentList '/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/ALLUSERS' -Wait -PassThru -WindowStyle Hidden
if ($installation.ExitCode -ne 0) { throw "Inno Setup installation failed: $($installation.ExitCode)" }
if (-not (Test-Path -LiteralPath "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe")) {
  throw 'Inno Setup compiler is required for Windows installer regression tests.'
}
