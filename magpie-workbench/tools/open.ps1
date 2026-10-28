param()
$ErrorActionPreference = 'Stop'
try {
  $runFile = Join-Path $env:USERPROFILE '.config\magpie-model-workbench\runtime.json'
  if (-not (Test-Path -LiteralPath $runFile)) { throw 'Open Magpie and enable Model Workbench first.' }
  $info = Get-Content -Raw -LiteralPath $runFile | ConvertFrom-Json
  $origin = [Uri]$info.origin
  if ($origin.Scheme -ne 'http' -or $origin.Host -ne '127.0.0.1' -or $origin.AbsolutePath -ne '/' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment) { throw 'Invalid workbench runtime address.' }
  $result = Invoke-RestMethod -Method Post -Uri ($origin.AbsoluteUri.TrimEnd('/') + '/api/open') -Headers @{Authorization=('Bearer ' + $info.control)} -TimeoutSec 5
  $target = [Uri]$result.url
  if ($target.GetLeftPart([UriPartial]::Authority) -ne $origin.GetLeftPart([UriPartial]::Authority) -or $target.Fragment -notmatch '^#open=[a-f0-9]{64}$') { throw 'Invalid workbench console address.' }
  Start-Process -FilePath $target.AbsoluteUri -WindowStyle Hidden
} catch {
  Write-Host ('Cannot open workbench: ' + $_.Exception.Message)
  Write-Host 'Check that Magpie is running and the Model Workbench plugin is enabled.'
  exit 1
}
