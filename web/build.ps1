$ErrorActionPreference = "Stop"

$env:MCLP_NODE_MODULES = Join-Path $env:USERPROFILE ".mclp-web\node_modules"
$vite = Join-Path $env:MCLP_NODE_MODULES ".bin\vite.cmd"
$webRoot = Split-Path -Parent $PSCommandPath

if (-not (Test-Path -LiteralPath $vite)) {
    throw "Vite nao encontrado. Rode npm install --prefix $env:USERPROFILE\.mclp-web primeiro."
}

Push-Location $webRoot
try {
    & $vite build --config (Join-Path $webRoot "vite.config.ts")
}
finally {
    Pop-Location
}
