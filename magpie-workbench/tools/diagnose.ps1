[CmdletBinding()]
param([string]$MagpieDir, [string]$Config, [string]$Model)
$ErrorActionPreference = 'Stop'
try {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $runtimeCommand = Get-Command node.exe,bun.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $runtimeCommand) { throw 'This optional diagnostic tool needs Node.js 18+ or Bun on PATH. The filter itself does not need Node.js. See README.' }
    $reportDirectory = Join-Path $projectRoot '.runtime\reports'
    [IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
    $reportPath = Join-Path $reportDirectory ('magpie-diagnostics-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '.json')
    $arguments = @((Join-Path $PSScriptRoot 'diagnose.mjs'), '--output', $reportPath)
    if ($MagpieDir) { $arguments += @('--magpie-dir', $MagpieDir) }
    if ($Config) { $arguments += @('--config', $Config) }
    if ($Model) { $arguments += @('--model', $Model) }
    & $runtimeCommand.Source @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Read-only diagnostic export failed. No configuration was changed.' }
    $report = [IO.File]::ReadAllText($reportPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Write-Output ('Report: ' + $reportPath)
    $report.checks | Format-Table -Property level,code,message -Wrap
} catch { Write-Error $_; exit 1 }
