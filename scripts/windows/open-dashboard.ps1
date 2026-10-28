[CmdletBinding()]
param([switch]$CheckOnly)
& (Join-Path $PSScriptRoot 'start.ps1') -Action Start -CheckOnly:$CheckOnly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
