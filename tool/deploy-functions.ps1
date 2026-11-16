$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'firebase.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$functionConfig = @($config.functions)[0]
$sourcePath = Join-Path $projectRoot $functionConfig.source
$indexPath = Join-Path $sourcePath 'index.js'
$source = Get-Content -LiteralPath $indexPath -Raw
$names = [regex]::Matches($source, '(?m)^exports\.(\w+)\s*=') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
if (-not $names) { throw "No exported functions found in $indexPath" }
# Explicit function names prevent deployment from proposing deletion of
# functions maintained in the other repository's default codebase.
$targets = ($names | ForEach-Object { "functions:$_" }) -join ','
& firebase deploy --project peakpath-ccd4a --config $configPath --only $targets
if ($LASTEXITCODE -ne 0) { throw 'Function deployment failed.' }
