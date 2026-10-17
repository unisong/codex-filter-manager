[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status', 'Diagnose', 'Run', 'Test')]
    [string]$Action = 'Status',
    [ValidateRange(1024, 65535)]
    [int]$Port = 18181,
    [string]$Upstream,
    [string]$Config,
    [string]$Runtime,
    [string]$CcDb,
    [ValidateSet('auto', 'ccswitch', 'magpie')][string]$Backend = 'auto',
    [string]$MagpieDir
)
$ErrorActionPreference = 'Stop'
$allowDownload = $Action -in @('Start', 'Run')
$nodePath = & { param($entryPath, $download) . $entryPath; Get-FilterNode -NoDownload:(-not $download) } (Join-Path $PSScriptRoot 'start.ps1') $allowDownload
if ($Action -eq 'Test') {
    & $nodePath --test (Join-Path $PSScriptRoot 'tests\filter.test.cjs') (Join-Path $PSScriptRoot 'tests\legacy-model-alias.test.cjs') (Join-Path $PSScriptRoot 'tests\management.test.cjs')
} else {
    $operation = $Action.ToLowerInvariant()
    if ($Action -eq 'Run') { $operation = 'serve' }
    $filterArguments = @((Join-Path $PSScriptRoot 'filter.cjs'), $operation, '--port', $Port.ToString())
    if ($Upstream) { $filterArguments += @('--upstream', $Upstream) }
    if ($Config) { $filterArguments += @('--config', $Config) }
    if ($Runtime) { $filterArguments += @('--runtime', $Runtime) }
    if ($CcDb) { $filterArguments += @('--cc-db', $CcDb) }
    $filterArguments += @('--backend', $Backend)
    if ($MagpieDir) { $filterArguments += @('--magpie-dir', $MagpieDir) }
    & $nodePath @filterArguments
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
