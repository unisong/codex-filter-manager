[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = 'Stop'
# A Node/Bun parent may inherit PowerShell 7 module paths. Load this helper's
# Windows PowerShell modules instead of incompatible functions from that parent.
$env:PSModulePath = Join-Path $PSHOME 'Modules'

function Assert-ChildPath([string]$Parent, [string]$Child) {
    $base = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath($Child)
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path is outside the update directory.' }
    return $full
}
function Assert-NoLinks([string]$File) {
    $item = [IO.Path]::GetFullPath($File)
    while ($item) {
        if (Test-Path -LiteralPath $item) {
            if ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation paths are not supported.' }
        }
        $item = [IO.Path]::GetDirectoryName($item)
    }
}
function Write-Result([string]$Phase, [string]$Message, [string]$Target = '') {
    $data = @{phase=$Phase; message=$Message; tag=$updatePlan.tag; target=$Target; at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
    $tempResult = $updatePlan.resultFile + '.tmp'
    [IO.File]::WriteAllText($tempResult, $data, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $updatePlan.resultFile) {
        [IO.File]::Replace($tempResult, $updatePlan.resultFile, [System.Management.Automation.Language.NullString]::Value)
    } else { [IO.File]::Move($tempResult, $updatePlan.resultFile) }
}
function Invoke-Service([string]$Operation) {
    $arguments = @((Join-Path $installRoot 'filter.cjs'), $Operation) + @($updatePlan.restart)
    $output = & $updatePlan.node @arguments 2>> (Join-Path $jobRoot 'service-error.log')
    if ($LASTEXITCODE -ne 0) { throw ('Service ' + $Operation + ' failed; see update logs.') }
    $value = ($output -join "`n") | ConvertFrom-Json
    if ($Operation -eq 'start' -and -not $value.running) { throw 'The updated service did not become ready.' }
}

$updatePlan = $null
$stopped = $false
$backups = @()
$updateLock = $null
$launcherMutex = $null
$ownsMutex = $false
try {
    $updatePlan = [IO.File]::ReadAllText($Plan) | ConvertFrom-Json
    $jobRoot = [IO.Path]::GetFullPath($updatePlan.job)
    $installRoot = [IO.Path]::GetFullPath($updatePlan.root)
    if ($updatePlan.mode -notin @('ccswitch', 'magpie') -or $updatePlan.tag -notmatch '^v\d+\.\d+\.\d+$') { throw 'Invalid update plan.' }
    Assert-NoLinks $jobRoot
    Assert-NoLinks $installRoot
    $lockPath = Join-Path ([IO.Path]::GetDirectoryName($updatePlan.resultFile)) 'update.lock'
    Assert-NoLinks $lockPath
    $updateLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $archivePath = Assert-ChildPath $jobRoot $updatePlan.archive
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $updatePlan.sha256) { throw 'Archive checksum changed.' }
    $extractRoot = Assert-ChildPath $jobRoot (Join-Path $jobRoot 'unpacked')
    New-Item -ItemType Directory -Path $extractRoot | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    $prefix = 'codex-filter-manager-' + $updatePlan.tag + '-windows/'
    $files = New-Object 'System.Collections.Generic.List[string]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $allowedFiles = @('AGENTS.md','CONTRIBUTING.md','Diagnose.bat','LICENSE','README.md','SECURITY.md','Start.bat','Status.bat','Stop.bat','THIRD_PARTY_NOTICES.md','filter.cjs','package.json','.gitignore','.gitattributes')
    $allowedDirectories = @('.github','docs','src','web','scripts','tests','vendor','magpie-workbench')
    $totalSize = 0L
    try {
        foreach ($entry in $zip.Entries) {
            if (-not $entry.FullName.StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'Unexpected archive root.' }
            $relative = $entry.FullName.Substring($prefix.Length)
            if (-not $relative) { continue }
            # Reject traversal, alternate streams, Windows aliases and duplicate paths before extraction.
            if ($relative.Contains('\') -or $relative -match '[:*?"<>|\x00-\x1f]' -or $relative.StartsWith('/')) { throw 'Unsafe archive path.' }
            $parts = $relative.TrimEnd('/').Split('/')
            foreach ($part in $parts) {
                if (-not $part -or $part -in @('.', '..', '.runtime', '.tools', '.git', 'node_modules') -or $part -match '[. ]$|^(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)') { throw 'Reserved archive path.' }
            }
            if (($parts.Count -eq 1 -and $parts[0] -notin $allowedFiles) -or ($parts.Count -gt 1 -and $parts[0] -notin $allowedDirectories)) { throw 'Unexpected release file.' }
            if (-not $seen.Add($relative.TrimEnd('/'))) { throw 'Duplicate archive path.' }
            if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive symlinks are not supported.' }
            $totalSize += $entry.Length
            if ($totalSize -gt 536870912 -or $zip.Entries.Count -gt 10000) { throw 'Expanded archive exceeds size limit.' }
            $destination = Assert-ChildPath $extractRoot (Join-Path $extractRoot $relative)
            if ($relative.EndsWith('/')) { [IO.Directory]::CreateDirectory($destination) | Out-Null; continue }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
            $files.Add($relative)
        }
    } finally { $zip.Dispose() }
    foreach ($required in @('package.json','filter.cjs','src/filter.cjs','scripts/windows/start.ps1','web/dashboard.html','magpie-workbench/package.json','magpie-workbench/plugin/index.mjs','magpie-workbench/workbench.middleware.js')) {
        if (-not $files.Contains($required)) { throw ('Incomplete release: ' + $required) }
    }
    foreach ($metadata in @('package.json', 'magpie-workbench/package.json')) {
        $package = [IO.File]::ReadAllText((Join-Path $extractRoot $metadata)) | ConvertFrom-Json
        if ('v' + $package.version -ne $updatePlan.tag) { throw 'Package version mismatch.' }
    }
    if ($updatePlan.mode -eq 'magpie') {
        Write-Result 'ready' 'New plugin is ready. Change its directory in Magpie, then reload Magpie. Local settings remain in the Magpie data directory.' (Join-Path $extractRoot 'magpie-workbench')
        exit 0
    }
    if (Test-Path -LiteralPath (Join-Path $installRoot '.git')) { throw 'Refusing to overwrite a Git checkout.' }
    # Coordinate with Start.bat so a double-click cannot start half-written code.
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $mutexKey = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($installRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $hasher.Dispose() }
    $launcherMutex = New-Object System.Threading.Mutex($false, ('Local\CodexFilterLauncher-' + $mutexKey))
    try { $ownsMutex = $launcherMutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another launcher is still running. Retry after it finishes.' }
    # An installation used by a live Magpie workbench must be updated through Magpie instead.
    $runtimeFile = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config\magpie-model-workbench\runtime.json'
    if (Test-Path -LiteralPath $runtimeFile) {
        $magpieRun = [IO.File]::ReadAllText($runtimeFile) | ConvertFrom-Json
        if ($magpieRun.packageRoot -and [IO.Path]::GetFullPath($magpieRun.packageRoot).TrimEnd('\') -eq (Join-Path $installRoot 'magpie-workbench')) {
            if (Get-Process -Id $magpieRun.pid -ErrorAction SilentlyContinue) { throw 'This installation is loaded by Magpie. Update it through Magpie.' }
        }
    }
    foreach ($file in $files) { Assert-NoLinks (Assert-ChildPath $installRoot (Join-Path $installRoot $file)) }
    Invoke-Service 'stop'
    $stopped = $true
    Write-Result 'installing' 'Service stopped. Backing up and installing verified files.'
    $backupRoot = Assert-ChildPath $jobRoot (Join-Path $jobRoot 'backup')
    foreach ($file in $files) {
        $destination = Assert-ChildPath $installRoot (Join-Path $installRoot $file)
        $backupFile = Assert-ChildPath $backupRoot (Join-Path $backupRoot $file)
        $existed = Test-Path -LiteralPath $destination -PathType Leaf
        if ($existed) {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backupFile)) | Out-Null
            Copy-Item -LiteralPath $destination -Destination $backupFile
        }
        $backups += @{destination=$destination; backup=$backupFile; existed=$existed}
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $extractRoot $file) -Destination $destination -Force
    }
    Invoke-Service 'start'
    Write-Result 'installed' 'Update installed and service restarted. Local rules and records were preserved.' $installRoot
} catch {
    $message = $_.Exception.Message
    if ($stopped) {
        try {
            # A failed start can still leave a listening service. Stop it before restoring code.
            Invoke-Service 'stop'
            foreach ($item in $backups) {
                if ($item.existed) { Copy-Item -LiteralPath $item.backup -Destination $item.destination -Force }
                elseif (Test-Path -LiteralPath $item.destination -PathType Leaf) {
                    $checked = Assert-ChildPath $installRoot $item.destination
                    Remove-Item -LiteralPath $checked -Force
                }
            }
            Invoke-Service 'start'
            $message += ' Previous files restored and service restarted.'
        } catch { $message += ' Recovery needs attention: ' + $_.Exception.Message }
    }
    if ($updatePlan) { Write-Result 'failed' $message }
    exit 1
} finally {
    if ($ownsMutex) { $launcherMutex.ReleaseMutex() }
    if ($launcherMutex) { $launcherMutex.Dispose() }
    if ($updateLock) { $updateLock.Dispose() }
}
