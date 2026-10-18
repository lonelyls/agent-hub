$ErrorActionPreference = 'Stop'
$tools = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'
$runtime = Get-ChildItem -LiteralPath $tools -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'node-v*-win-*' -and (Test-Path (Join-Path $_.FullName 'node.exe')) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $runtime) { throw 'No project-local Node.js found. Run .\scripts\Install-LocalNode.ps1 first, or use a system Node.js installation.' }
$env:PATH = $runtime.FullName + ';' + $env:PATH
& (Join-Path $runtime.FullName 'node.exe') --version
