# Deploy's host tools: what it installs, from where, and how it checks them.
#
# Dot-sourced by Provision.ps1 for `-Phase prerequisites`. Functions only, so
# the test harness can drive Invoke-Prerequisites with a fake machine.
#
# Windows PowerShell 5.1: core runs provisioning with powershell.exe.
#
# Every installer is an official one, pinned by version and SHA-256, and
# refused on any mismatch. No winget: it is absent from Windows Server, and a
# package manager resolving "latest" is the opposite of a pin. The detection
# rules below repeat core's backend/src/lib/hostPrerequisites.js, because the
# host may have changed between the drawer and this run. Only an all-users copy
# counts; an existing install is never touched, moved or removed.
#
# Each SHA-256 was computed from the downloaded file and matched against the
# publisher's own list: the python.org release page, nodejs.org SHASUMS256.txt,
# the checksum table of the Git for Windows release. store.json repeats each
# version for the store drawer; a Deploy test fails when the two disagree.

$PrerequisitePins = @{
    python = @{ Version = '3.13.15'; File = 'python-3.13.15-amd64.exe'; Url = 'https://www.python.org/ftp/python/3.13.15/python-3.13.15-amd64.exe'; Sha256 = 'EDEC09C4853AEAE9AC36EFB8C9F95B6B8E2FEE65EEE56D9767A8B7C69C574403' }
    node   = @{ Version = '22.23.3'; File = 'node-v22.23.3-x64.msi'; Url = 'https://nodejs.org/dist/v22.23.3/node-v22.23.3-x64.msi'; Sha256 = '1C0EFC8449987E7DA5D184786A0A96DA83FFA11D334421201E5C09B93017CB8D' }
    git    = @{ Version = '2.56.0'; File = 'Git-2.56.0-64-bit.exe'; Url = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1/Git-2.56.0-64-bit.exe'; Sha256 = 'BFE94E7B419B16EEE9FECBD1253A98E3D4F49BA8F029630549052278FFE286A6' }
}

function Get-ToolVersion {
    param([string]$Exe)
    # A binary that never answers cannot hold the install: 5 seconds, then it is
    # killed. Not Start-Job: starting a job's own powershell.exe takes longer
    # than that on its own, so every probe timed out.
    $out = [IO.Path]::GetTempFileName()
    $err = [IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $Exe -ArgumentList '--version' -NoNewWindow -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err
        if (-not $p.WaitForExit(5000)) {
            try { $p.Kill() } catch { Write-Verbose "could not stop $Exe" }
            return $null
        }
        $text = [IO.File]::ReadAllText($out) + [IO.File]::ReadAllText($err)
        if ($text -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
        return $null
    } catch {
        return $null
    } finally {
        Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
    }
}

function Get-PythonRegistered {
    $out = @()
    foreach ($view in 'Registry64', 'Registry32') {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', $view)
        $core = $base.OpenSubKey('SOFTWARE\Python\PythonCore')
        if (-not $core) { continue }
        foreach ($name in $core.GetSubKeyNames()) {
            $key = $core.OpenSubKey("$name\InstallPath")
            if (-not $key) { continue }
            $exe = $key.GetValue('ExecutablePath')
            if (-not $exe -and $key.GetValue('')) { $exe = Join-Path $key.GetValue('') 'python.exe' }
            if ($exe) { $out += [string]$exe }
        }
    }
    return $out
}

function Find-MachineTool {
    param([string]$Id)
    $pf = $env:ProgramFiles
    $candidates = @()
    switch ($Id) {
        'git' {
            $k = Get-ItemProperty 'HKLM:\SOFTWARE\GitForWindows' -Name InstallPath -ErrorAction SilentlyContinue
            if ($k) { $candidates += (Join-Path $k.InstallPath 'cmd\git.exe') }
            $candidates += (Join-Path $pf 'Git\cmd\git.exe')
        }
        'python' {
            $candidates += Get-PythonRegistered
            $candidates += @(Get-ChildItem -LiteralPath $pf -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'python.exe' })
        }
        'node' {
            $k = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -Name InstallPath -ErrorAction SilentlyContinue
            if ($k) { $candidates += (Join-Path $k.InstallPath 'node.exe') }
            $candidates += (Join-Path $pf 'nodejs\node.exe')
        }
        'pwsh' { $candidates += (Join-Path $pf 'PowerShell\7\pwsh.exe') }
    }
    foreach ($exe in $candidates) {
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { continue }
        $v = Get-ToolVersion $exe
        if ($v) { return [pscustomobject]@{ Path = $exe; Version = $v } }
    }
    return $null
}

function Get-Sha256 {
    param([string]$Path)
    # .NET rather than Get-FileHash: that cmdlet is autoloaded from a module, and
    # powershell.exe started from a pwsh parent inherits pwsh's PSModulePath,
    # finds the PowerShell 7 copy first, and then has no Get-FileHash at all.
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '')
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Save-Download {
    param([string]$Uri, [string]$OutFile)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -TimeoutSec 600
}

function Install-Tool {
    param([string]$Id, [string]$Installer)
    switch ($Id) {
        'python' { $p = Start-Process -FilePath $Installer -ArgumentList '/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_launcher=1', 'Include_test=0' -Wait -PassThru -WindowStyle Hidden }
        'node'   { $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', ('"{0}"' -f $Installer), '/qn', 'ALLUSERS=1', '/norestart' -Wait -PassThru -WindowStyle Hidden }
        'git'    { $p = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES' -Wait -PassThru -WindowStyle Hidden }
        default  { throw "no installer recipe for $Id" }
    }
    return $p.ExitCode
}

function Invoke-Prerequisites {
    param(
        [string[]]$Ids,
        [hashtable]$Pins,
        [string]$CacheDir,
        [scriptblock]$Find = ${function:Find-MachineTool},
        [scriptblock]$Download = ${function:Save-Download},
        [scriptblock]$Install = ${function:Install-Tool},
        [scriptblock]$Say = { param($Message) Write-Host $Message }
    )
    $results = @()
    foreach ($id in $Ids) {
        $r = [ordered]@{ id = $id; status = $null; version = $null; path = $null; error = $null }
        $file = $null
        try {
            $found = & $Find $id
            if ($found) {
                $r.status = 'present'; $r.version = $found.Version; $r.path = $found.Path
                & $Say "${id}: already installed for all users, $($found.Version) at $($found.Path)."
                $results += [pscustomobject]$r
                continue
            }
            if (-not $Pins.ContainsKey($id)) { throw "no pinned installer for $id in this version of Deploy" }
            $pin = $Pins[$id]
            New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
            $file = Join-Path $CacheDir $pin.File
            & $Say "${id}: downloading $($pin.Url)"
            & $Download $pin.Url $file
            $hash = Get-Sha256 $file
            if ($hash -ne $pin.Sha256) { throw "fingerprint mismatch for $($pin.File): expected $($pin.Sha256), got $hash" }
            & $Say "${id}: fingerprint verified, installing $($pin.Version) for all users"
            $code = & $Install $id $file
            $after = & $Find $id
            if (-not $after) { throw "the installer exited $code and $id is still not found for all users" }
            $r.status = 'installed'; $r.version = $after.Version; $r.path = $after.Path
            if ($code -ne 0) { & $Say "${id}: the installer exited $code, and $id is there anyway." }
            & $Say "${id}: installed at $($after.Path)."
        } catch {
            $r.status = 'failed'; $r.error = [string]$_.Exception.Message
            & $Say "${id}: FAILED, $($r.error)"
        } finally {
            if ($file -and (Test-Path -LiteralPath $file)) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
        }
        $results += [pscustomobject]$r
    }
    return $results
}
