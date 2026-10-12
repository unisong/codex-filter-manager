[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status', 'Run', 'Test')]
    [string]$Action = 'Status',
    [ValidateRange(1024, 65535)]
    [int]$Port = 18181,
    [string]$Upstream,
    [string]$Config,
    [string]$Runtime,
    [string]$CcDb
)
$ErrorActionPreference = 'Stop'
$allowDownload = $Action -in @('Start', 'Run')
$nodePath = & { param($entryPath, $download) . $entryPath; Get-FilterNode -NoDownload:(-not $download) } (Join-Path $PSScriptRoot 'start.ps1') $allowDownload
if ($Action -eq 'Test') {
    & $nodePath --test (Join-Path $PSScriptRoot 'filter.test.cjs') (Join-Path $PSScriptRoot 'legacy-model-alias.test.cjs') (Join-Path $PSScriptRoot 'management.test.cjs')
} else {
    $operation = $Action.ToLowerInvariant()
    if ($Action -eq 'Run') { $operation = 'serve' }
    $filterArguments = @((Join-Path $PSScriptRoot 'filter.cjs'), $operation, '--port', $Port.ToString())
    if ($Upstream) { $filterArguments += @('--upstream', $Upstream) }
    if ($Config) { $filterArguments += @('--config', $Config) }
    if ($Runtime) { $filterArguments += @('--runtime', $Runtime) }
    if ($CcDb) { $filterArguments += @('--cc-db', $CcDb) }
    & $nodePath @filterArguments
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
