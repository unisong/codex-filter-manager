[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('codex-filter-launcher-' + [Guid]::NewGuid().ToString('N') + ' 中文 空格')
New-Item -ItemType Directory -Path $scratch | Out-Null
foreach ($name in @('start.ps1', 'open-dashboard.ps1', 'open-dashboard.vbs', 'ccswitch-filter.ps1', 'filter.cjs', 'package.json')) {
    Copy-Item -LiteralPath (Join-Path $repository $name) -Destination (Join-Path $scratch $name)
}
foreach ($name in @('src', 'web', 'vendor', 'magpie-plugin', 'assets')) {
    Copy-Item -LiteralPath (Join-Path $repository $name) -Destination (Join-Path $scratch $name) -Recurse
}
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$originalLocation = Get-Location
$checks = New-Object 'Collections.Generic.List[string]'
$serviceStarted = $false

function Read-SharedText {
    param([string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = New-Object IO.StreamReader($stream)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Invoke-LauncherFixture {
    param([string]$Operation = 'Start', [switch]$AllowFailure)
    $args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scratch 'start.ps1'),
        '-Action', $Operation, '-CheckOnly', '-NoShortcut', '-Console', '-Port', $fixturePort,
        '-Config', $fixtureConfig, '-Runtime', $fixtureRuntime, '-CcDb', $fixtureDatabase, '-Upstream', $fixtureUpstream)
    # Redirect to files, not a PowerShell pipeline: detached descendants can inherit the pipeline pipe.
    $stdoutPath = Join-Path $scratch ('stdout-' + [Guid]::NewGuid().ToString('N') + '.txt')
    $stderrPath = Join-Path $scratch ('stderr-' + [Guid]::NewGuid().ToString('N') + '.txt')
    $argumentText = ($args | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $process = Start-Process -FilePath $powershell -ArgumentList $argumentText -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $processHandle = $process.Handle
    if (-not $process.WaitForExit(45000)) { throw ('Launcher ' + $Operation + ' timed out.') }
    $process.Refresh()
    $errorText = Read-SharedText $stderrPath
    if (-not $AllowFailure -and $process.ExitCode -ne 0) { throw ('Launcher ' + $Operation + ' failed: ' + $errorText) }
    return (Read-SharedText $stdoutPath).Trim()
}

try {
    Set-Location -LiteralPath $scratch
    $entry = Join-Path $scratch 'start.ps1'
    . $entry
    $installedNode = Get-FilterNode -NoDownload
    $checks.Add('compatible installed Node discovery')

    # Offline rejection tests: never hit the network and never execute an unverified download.
    $savedNodeTest = ${function:Test-FilterNode}
    $savedWebRequest = if (Test-Path Function:Invoke-WebRequest) { ${function:Invoke-WebRequest} } else { $null }
    function Test-FilterNode { param([string]$Path) return $false }
    $script:downloadCalls = 0
    function Invoke-WebRequest {
        param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
        $script:downloadCalls++
        [IO.File]::WriteAllText($OutFile, 'intentionally invalid offline fixture')
    }
    try {
        $refusedMissing = $false
        try { Get-FilterNode -NoDownload | Out-Null } catch { $refusedMissing = $_.Exception.Message -match 'unavailable' }
        if (-not $refusedMissing -or $script:downloadCalls -ne 0) { throw 'NoDownload unexpectedly fetched a runtime.' }
        $checks.Add('Stop/Status missing runtime does not download')
        $refusedChecksum = $false
        try { Get-FilterNode | Out-Null } catch { $refusedChecksum = $_.Exception.Message -match 'checksum mismatch' }
        if (-not $refusedChecksum -or $script:downloadCalls -ne 1) { throw 'An invalid archive was not rejected.' }
        if (Get-ChildItem -LiteralPath (Join-Path $scratch '.tools') -Filter '.install-*') { throw 'Failed download staging was not cleaned.' }
        $checks.Add('bad checksum rejected before execution and staging cleaned')
    } finally {
        ${function:Test-FilterNode} = $savedNodeTest
        if ($savedWebRequest) { ${function:Invoke-WebRequest} = $savedWebRequest } else { Remove-Item Function:Invoke-WebRequest }
    }

    # Exercise successful staging offline with a known local runtime and controlled integrity stub.
    # The real published SHA-256 values are tested separately against nodejs.org at release time.
    $archiveSource = Join-Path $scratch 'archive-fixture'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $distribution = 'node-v24.21.0-win-' + $arch
    $distributionDir = Join-Path $archiveSource $distribution
    New-Item -ItemType Directory -Path $distributionDir -Force | Out-Null
    Copy-Item -LiteralPath $installedNode -Destination (Join-Path $distributionDir 'node.exe')
    [IO.File]::WriteAllText((Join-Path $distributionDir 'LICENSE'), 'Offline launcher fixture, not a redistributed runtime license.')
    $fixtureZip = Join-Path $scratch 'runtime-fixture.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $fixtureArchive = [IO.Compression.ZipFile]::Open($fixtureZip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in @('node.exe', 'LICENSE')) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($fixtureArchive, (Join-Path $distributionDir $name), ($distribution + '/' + $name)) | Out-Null }
    } finally { $fixtureArchive.Dispose() }
    function Test-FilterNode {
        param([string]$Path)
        if (-not $Path.StartsWith($scratch, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        return & $savedNodeTest $Path
    }
    function Invoke-WebRequest {
        param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
        $script:downloadCalls++
        Copy-Item -LiteralPath $fixtureZip -Destination $OutFile
    }
    function Get-FileHash {
        param($LiteralPath, $Algorithm)
        if ($Algorithm -ne 'SHA256') { throw 'Unexpected integrity algorithm.' }
        $hash = if ($arch -eq 'arm64') { '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921' }
            else { '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' }
        return @{Hash = $hash}
    }
    try {
        $downloadCountBefore = $script:downloadCalls
        $privateNode = Get-FilterNode
        if (-not $privateNode.StartsWith((Join-Path $scratch '.tools'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Successful install did not use private directory.' }
        if ((Get-FilterNode -NoDownload) -ne $privateNode -or $script:downloadCalls -ne $downloadCountBefore + 1) { throw 'Private runtime was not reused.' }
        if (Get-ChildItem -LiteralPath (Join-Path $scratch '.tools') -Filter '.install-*') { throw 'Successful staging was not cleaned.' }
        if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $privateNode -Parent) 'LICENSE'))) { throw 'Runtime license was not extracted.' }
        $checks.Add('offline staged install extracts runtime/license atomically and reuses without download')
    } finally {
        ${function:Test-FilterNode} = $savedNodeTest
        Remove-Item Function:Get-FileHash
        if ($savedWebRequest) { ${function:Invoke-WebRequest} = $savedWebRequest } else { Remove-Item Function:Invoke-WebRequest }
    }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $fixturePort = $listener.LocalEndpoint.Port
    $listener.Stop()
    $fixtureConfig = Join-Path $scratch 'fixture.toml'
    $fixtureRuntime = Join-Path $scratch 'runtime'
    $fixtureDatabase = Join-Path $scratch 'missing-fixture.db'
    $fixtureUpstream = 'http://127.0.0.1:19091'
    $originalConfig = "model_provider = `"fixture`"`n[model_providers.fixture]`nname = `"Fixture`"`nbase_url = `"$fixtureUpstream/v1`"`nwire_api = `"responses`"`n"
    [IO.File]::WriteAllText($fixtureConfig, $originalConfig, [Text.UTF8Encoding]::new($false))
    $serviceStarted = $true
    $url = Invoke-LauncherFixture
    if ($url -ne "http://127.0.0.1:$fixturePort/__codex_filter__/ui") { throw 'CheckOnly returned an unexpected URL.' }
    if (-not ([IO.File]::ReadAllText($fixtureConfig)).Contains('127.0.0.1:' + $fixturePort)) { throw 'Fixture configuration was not attached.' }
    $checks.Add('CheckOnly starts isolated service on Chinese/space path, no browser/shortcut')
    $status = Invoke-LauncherFixture 'Status' | ConvertFrom-Json
    if (-not $status.running -or $status.state -ne 'filtering') { throw 'Status did not report active isolated service.' }
    $checks.Add('Status returns live health')
    Invoke-LauncherFixture 'Diagnose' | Out-Null
    $reports = @(Get-ChildItem -LiteralPath (Join-Path $fixtureRuntime 'reports') -Filter '*.json')
    if ($reports.Count -ne 1) { throw 'Diagnostic launcher did not create one report.' }
    $diagnostic = [IO.File]::ReadAllText($reports[0].FullName) | ConvertFrom-Json
    if (-not $diagnostic.service.running -or $diagnostic.schemaVersion -ne 1) { throw 'Diagnostic launcher report is invalid.' }
    if (($diagnostic.checks | Where-Object { $_.code -eq 'service-ready' }).message -notmatch '\u7ba1\u7406\u670d\u52a1') { throw 'Diagnostic report text was corrupted by a legacy output encoding.' }
    $checks.Add('Diagnose exports a metadata-only report without changing routing')
    $firstPid = (Get-Content -LiteralPath (Join-Path $fixtureRuntime 'service.json') -Raw | ConvertFrom-Json).pid
    Invoke-LauncherFixture | Out-Null
    $secondPid = (Get-Content -LiteralPath (Join-Path $fixtureRuntime 'service.json') -Raw | ConvertFrom-Json).pid
    if ($firstPid -ne $secondPid) { throw 'Repeat start replaced the running service.' }
    $checks.Add('repeated launch reuses running service')

    $proxyPath = Join-Path $scratch 'src\proxy.cjs'
    $originalProxy = [IO.File]::ReadAllText($proxyPath)
    $currentVersion = [int][regex]::Match($originalProxy, 'const FILTER_VERSION\s*=\s*(\d+)').Groups[1].Value
    [IO.File]::WriteAllText($proxyPath, ($originalProxy -replace ('const FILTER_VERSION\s*=\s*' + $currentVersion), ('const FILTER_VERSION = ' + ($currentVersion + 1))), [Text.UTF8Encoding]::new($false))
    Invoke-LauncherFixture | Out-Null
    $status = Invoke-LauncherFixture 'Status' | ConvertFrom-Json
    if ($status.filterVersion -ne $currentVersion + 1) { throw 'Same-directory version upgrade did not restart.' }
    $checks.Add('same-install older version restarts safely')

    $stopped = Invoke-LauncherFixture 'Stop' | ConvertFrom-Json
    $serviceStarted = $false
    if ($stopped.running -or [IO.File]::ReadAllText($fixtureConfig) -ne $originalConfig) { throw 'Stop did not exactly restore fixture configuration.' }
    $checks.Add('Stop restores original config exactly')

    $foreignListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $fixturePort)
    $foreignListener.Start()
    try {
        $foreignRefused = $false
        try { Invoke-LauncherFixture | Out-Null } catch { $foreignRefused = $_.Exception.Message -match 'failed' }
        if (-not $foreignRefused) { throw 'An unrelated listener was not refused.' }
        if ([IO.File]::ReadAllText($fixtureConfig) -ne $originalConfig) { throw 'Foreign listener failure modified fixture configuration.' }
        if (-not $foreignListener.Server.IsBound) { throw 'Foreign listener was stopped.' }
        $checks.Add('unrelated occupied port refused without config change or terminating listener')
    } finally { $foreignListener.Stop() }

    $checks | ForEach-Object { Write-Host ('PASS ' + $_) }
    Write-Host ('All ' + $checks.Count + ' offline launcher checks passed. Fixture retained at: ' + $scratch)
} finally {
    if ($serviceStarted) { Invoke-LauncherFixture 'Stop' | Out-Null }
    Set-Location $originalLocation
}
