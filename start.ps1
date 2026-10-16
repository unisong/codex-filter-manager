[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
    [switch]$CheckOnly,
    [switch]$NoShortcut,
    [switch]$Console,
    [ValidateRange(1024, 65535)][int]$Port = 18181,
    [string]$Config,
    [string]$Runtime,
    [string]$CcDb,
    [string]$Upstream,
    [ValidateSet('auto', 'ccswitch', 'magpie')][string]$Backend = 'auto',
    [string]$MagpieDir
)
$ErrorActionPreference = 'Stop'

function Test-FilterNode {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $version = (& $Path --version 2>$null | Out-String).Trim()
        return $LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24
    } catch { return $false }
}

function Get-FilterNode {
    param([switch]$NoDownload)
    $version = '24.21.0'
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $distribution = "node-v$version-win-$architecture"
    $toolsDirectory = Join-Path $PSScriptRoot '.tools'
    $runtimeDirectory = Join-Path $toolsDirectory $distribution
    $privateNode = Join-Path $runtimeDirectory 'node.exe'
    if (Test-FilterNode $privateNode) { return $privateNode }
    # Search installed applications, never aliases or functions.
    $installedNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installedNode -and (Test-FilterNode $installedNode.Source)) { return $installedNode.Source }
    foreach ($candidate in @(
        (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'nodejs\node.exe'),
        (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\nodejs\node.exe')
    )) {
        if (Test-FilterNode $candidate) { return $candidate }
    }
    if ($NoDownload) { throw 'Node.js 24+ is unavailable. Run Start.bat once, or install Node.js 24+ from https://nodejs.org/.' }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'The one-click launcher requires 64-bit Windows (x64 or ARM64).' }
    # Pinned official v24.21.0 SHASUMS256.txt; do not execute an unverified download.
    $expectedHash = if ($architecture -eq 'arm64') { '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921' }
        else { '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' }
    New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
    $stagingDirectory = Join-Path $toolsDirectory ('.install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
    $archivePath = Join-Path $stagingDirectory 'node.zip'
    try {
        Write-Host 'Preparing official Node.js 24 (first launch only, no administrator rights needed)...'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $savedProgress = $ProgressPreference
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$distribution.zip" -OutFile $archivePath -TimeoutSec 180
        } finally { $ProgressPreference = $savedProgress }
        if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
            throw 'Node.js checksum mismatch. The downloaded file was not executed; please retry.'
        }
        # Only the runtime and license are needed; npm is not installed.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        $extractedDirectory = Join-Path $stagingDirectory 'runtime'
        New-Item -ItemType Directory -Path $extractedDirectory | Out-Null
        try {
            foreach ($fileName in @('node.exe', 'LICENSE')) {
                $entry = $archive.GetEntry("$distribution/$fileName")
                if (-not $entry) { throw ('Official archive is missing ' + $fileName) }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $extractedDirectory $fileName), $false)
            }
        } finally { $archive.Dispose() }
        if (-not (Test-FilterNode (Join-Path $extractedDirectory 'node.exe'))) { throw 'The verified Node.js runtime cannot run on this computer.' }
        if (Test-Path -LiteralPath $runtimeDirectory) {
            $resolvedRuntime = [IO.Path]::GetFullPath($runtimeDirectory)
            $resolvedTools = [IO.Path]::GetFullPath($toolsDirectory).TrimEnd('\') + '\'
            if (-not $resolvedRuntime.StartsWith($resolvedTools, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime destination.' }
            Move-Item -LiteralPath $runtimeDirectory -Destination ($runtimeDirectory + '.invalid-' + [Guid]::NewGuid().ToString('N'))
        }
        Move-Item -LiteralPath $extractedDirectory -Destination $runtimeDirectory
        return $privateNode
    } catch {
        throw ('Cannot prepare Node.js. Check the network and folder permissions, or install Node.js 24+ from https://nodejs.org/. ' + $_.Exception.Message)
    } finally {
        $resolvedStaging = [IO.Path]::GetFullPath($stagingDirectory)
        $resolvedTools = [IO.Path]::GetFullPath($toolsDirectory).TrimEnd('\') + '\'
        if ($resolvedStaging.StartsWith($resolvedTools, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedStaging).StartsWith('.install-') -and (Test-Path -LiteralPath $resolvedStaging)) {
            Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
        }
    }
}

function New-FilterDesktopShortcut {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $null
    try {
        $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex 过滤管理.lnk'
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $shortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'open-dashboard.vbs') + '"'
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.Description = 'Start Codex Filter Manager and open its local dashboard'
        $icon = Join-Path $PSScriptRoot 'assets\app.ico'
        if (Test-Path -LiteralPath $icon -PathType Leaf) { $shortcut.IconLocation = $icon }
        $shortcut.Save()
    } finally {
        if ($shortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
}

function Invoke-FilterCommand {
    param([string]$Node, [string]$Operation)
    $filterArguments = @((Join-Path $PSScriptRoot 'filter.cjs'), $Operation, '--port', $Port.ToString())
    if ($Config) { $filterArguments += @('--config', $Config) }
    if ($Runtime) { $filterArguments += @('--runtime', $Runtime) }
    if ($CcDb) { $filterArguments += @('--cc-db', $CcDb) }
    if ($Upstream) { $filterArguments += @('--upstream', $Upstream) }
    $filterArguments += @('--backend', $Backend)
    if ($MagpieDir) { $filterArguments += @('--magpie-dir', $MagpieDir) }
    $result = & $Node @filterArguments
    if ($LASTEXITCODE -ne 0) { throw ('Filter ' + $Operation + ' failed. See the message above and .runtime/filter.log. If the requested port is occupied, stop the other service first.') }
    return ($result -join "`n") | ConvertFrom-Json
}

function Test-FilterProcessInThisFolder {
    param([string]$RuntimePath)
    $statePath = Join-Path $RuntimePath 'service.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
    try {
        $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
        if (-not $state.pid -or $state.pid -lt 1) { return $false }
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$state.pid)
        $script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'filter.cjs'))
        return $process -and $process.CommandLine -match ('(?:^|["\s])' + [regex]::Escape($script) + '(?:["\s]|$)') -and $process.CommandLine -match '(?:^|\s)serve(?:\s|$)'
    } catch { return $false }
}

# Dot-sourcing exposes helpers to offline tests without starting anything.
if ($MyInvocation.InvocationName -eq '.') { return }
$mutex = $null
$ownsMutex = $false
try {
    $runtimePath = if ($Runtime) { [IO.Path]::GetFullPath($Runtime) } else { Join-Path $PSScriptRoot '.runtime' }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $mutexKey = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $hasher.Dispose() }
    $mutex = New-Object System.Threading.Mutex($false, ('Local\CodexFilterLauncher-' + $mutexKey))
    try { $ownsMutex = $mutex.WaitOne(240000) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another launch is still running. Wait for it to finish and retry.' }
    $nodePath = Get-FilterNode -NoDownload:($Action -ne 'Start')
    $operation = if ($Action -eq 'Start') { 'status' } else { $Action.ToLowerInvariant() }
    $service = Invoke-FilterCommand $nodePath $operation
    if ($Action -ne 'Start') { $service | ConvertTo-Json -Depth 10; return }
    $versionMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'proxy.cjs')), 'const FILTER_VERSION\s*=\s*(\d+)')
    if (-not $versionMatch.Success) { throw 'Cannot read the source version; please extract a complete release ZIP.' }
    $sourceVersion = [int]$versionMatch.Groups[1].Value
    if ($service.running -and $service.filterVersion -ne $sourceVersion) {
        if ($service.filterVersion -gt $sourceVersion) { throw 'A newer service is running. Open the newer installation, or stop it before downgrading.' }
        if (-not (Test-FilterProcessInThisFolder $runtimePath)) { throw 'An older service belongs to another or unverifiable installation. Stop it from that installation before starting this one.' }
        Invoke-FilterCommand $nodePath 'stop' | Out-Null
    }
    # Validate routing options after safely stopping an older owned service;
    # old versions cannot advertise the newly added backend options.
    $service = Invoke-FilterCommand $nodePath 'start'
    if (-not $service.running -or $service.filterVersion -ne $sourceVersion) { throw 'The service is not ready. Check .runtime/filter.log.' }
    if (-not $NoShortcut -and -not $CheckOnly) {
        try { New-FilterDesktopShortcut } catch { Write-Warning ('Service is running, but the desktop shortcut could not be created: ' + $_.Exception.Message) }
    }
    $dashboardUrl = $service.filterOrigin + '/__codex_filter__/ui'
    if ($CheckOnly) { Write-Output $dashboardUrl }
    else { Start-Process -FilePath $dashboardUrl }
} catch {
    if ($Console -or $CheckOnly -or $Action -ne 'Start') { Write-Error $_; exit 1 }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'Codex 过滤管理', 'OK', 'Error') | Out-Null
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
