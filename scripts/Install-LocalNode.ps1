param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) {
    throw 'The local installer supports Windows x64 and ARM64. Install Node.js 24 LTS manually on this platform.'
}
$tools = Join-Path $root '.tools'
New-Item -ItemType Directory -Force $tools | Out-Null
$baseUrl = 'https://nodejs.org/dist/latest-v24.x'
$checksums = (Invoke-WebRequest -UseBasicParsing "$baseUrl/SHASUMS256.txt").Content
$entry = $checksums -split "`n" | Where-Object { $_ -match "node-v[\d.]+-win-$architecture.zip$" } | Select-Object -First 1
if (-not $entry) { throw 'Could not find the official Node.js archive checksum.' }
$parts = $entry.Trim() -split '\s+'
$filename = $parts[1]
$archive = Join-Path $tools $filename
Write-Output "Downloading $filename from nodejs.org..."
try {
    Invoke-WebRequest -UseBasicParsing "$baseUrl/$filename" -OutFile $archive
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $parts[0]) { throw 'Node.js archive failed SHA-256 verification. Installation aborted.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
}
Write-Output 'Node.js installed locally. Activate it in this terminal with:'
Write-Output '  . .\scripts\Use-LocalNode.ps1'
