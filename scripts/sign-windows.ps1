param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $FilePath)) {
  throw "File to sign not found: $FilePath"
}

$certPath = $env:WINDOWS_CERTIFICATE_PATH
if (-not $certPath) {
  $certPath = Join-Path (Get-Location) 'certificate\certificate.pfx'
}

if (-not (Test-Path -LiteralPath $certPath)) {
  throw "Windows signing certificate not found: $certPath"
}

if (-not $env:WINDOWS_CERTIFICATE_PASSWORD) {
  throw 'WINDOWS_CERTIFICATE_PASSWORD is not set.'
}

$signtoolPath = $env:WINDOWS_SIGNTOOL_PATH
if (-not $signtoolPath) {
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $signtoolPath = Get-ChildItem -Path $kitsRoot -Recurse -Filter signtool.exe |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $signtoolPath -or -not (Test-Path -LiteralPath $signtoolPath)) {
  throw 'signtool.exe was not found.'
}

Write-Host "Signing $FilePath"
Write-Host "Using signtool: $signtoolPath"

& $signtoolPath sign `
  /f "$certPath" `
  /p "$env:WINDOWS_CERTIFICATE_PASSWORD" `
  /fd SHA256 `
  /tr http://timestamp.digicert.com `
  /td SHA256 `
  /v `
  "$FilePath"

if ($LASTEXITCODE -ne 0) {
  throw "signtool failed with exit code $LASTEXITCODE"
}
