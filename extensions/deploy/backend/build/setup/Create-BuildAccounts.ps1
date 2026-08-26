<#
Install-time setup for the Deploy sandbox accounts. Run once, as an
administrator, on the Aegis host, and again with -AccountNames if the node
runtime is being enabled: a running application needs accounts of its own
(AEGIS_RUNTIME_ACCOUNTS), not the build pool's. Creates 3 restricted local accounts, each
scoped by NTFS ACL to its own workspace folder, and 2 outbound firewall
rules per account (deny the domain/RFC1918, allow only 443/80/53). Passwords
are generated here and handed to machineStore.js for encrypted storage --
run this from a shell where `node` can reach the Aegis backend's
node_modules, since it shells out to Node once per account to store the
secret.

Re-running is safe: an account or rule that already exists is left alone,
not recreated.

-WithPython additionally grants each account read+execute on a machine-wide
Python, so a project whose install/build/start command is Python can be
deployed. It is opt-in because widening what a sandbox account may execute is a
decision. It REFUSES rather than pretending when the only Python on the host is
a per-user one: see Find-MachinePython for why an ACL cannot fix that case.

Examples:
    .\Create-BuildAccounts.ps1 -DomainSubnets '10.0.0.0/8'
    .\Create-BuildAccounts.ps1 -DomainSubnets '10.0.0.0/8' -WithPython
    .\Create-BuildAccounts.ps1 -AccountNames aegis-run-01,aegis-run-02 -WithPython
#>
[CmdletBinding()]
param(
    [string[]]$AccountNames = @('aegis-build-01', 'aegis-build-02', 'aegis-build-03'),
    [string]$WorkspaceRoot = (Join-Path $env:ProgramData 'Aegis\deploy-build'),
    [string]$BackendDir = (Join-Path $PSScriptRoot '..\..\..\..\..\backend'),
    [string[]]$DomainSubnets = @(),  # e.g. '10.0.0.0/8' -- pass the AD subnet(s) explicitly, this script does not guess them

    # Grant the accounts read+execute on a machine-wide Python, so a project
    # whose install/build/start command is Python can be deployed. Opt-in:
    # widening what a sandbox account may execute is a decision, not a default.
    [switch]$WithPython,

    # Where that Python lives. Empty means "find it", which is the normal case.
    [string]$PythonRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node is not on PATH -- run this from a shell where the Aegis backend's Node is reachable"
}
if ($DomainSubnets.Count -eq 0) {
    Write-Warning "No -DomainSubnets given: the domain-controller deny rule will not be created. Pass -DomainSubnets '10.0.0.0/8' (or your AD subnet) before relying on this in production."
}

<#
Finds a Python these accounts can actually execute, or explains why there is
none.

The distinction that matters is per-user versus machine-wide, and it is not a
detail: the Microsoft Store build of Python installs under
%LOCALAPPDATA%\Programs and is reached through a per-user app-execution alias in
%LOCALAPPDATA%\Microsoft\WindowsApps. A restricted local account cannot traverse
another user's profile, and the alias does not exist in its own. Granting an ACL
on that path SUCCEEDS and changes nothing, which is the worst outcome available:
the operator sees no error here and a bare "command not found" two minutes into
a build, with nothing connecting the two.

So this refuses instead. `where.exe` is deliberately not consulted: it answers
for the administrator running this script, whose PATH is exactly the one the
sandbox does not have.
#>
function Find-MachinePython {
    param([string]$Explicit)

    if ($Explicit) {
        $exe = Join-Path $Explicit 'python.exe'
        if (-not (Test-Path $exe)) { throw "-PythonRoot '$Explicit' holds no python.exe" }
        # TrimEnd, because a trailing backslash survives Resolve-Path and then
        # escapes the closing quote of the icacls argument below. The grant
        # would fail on a path the operator typed correctly.
        return (Resolve-Path $Explicit).Path.TrimEnd('\')
    }

    # HKLM first: it is the registry key an all-users installer writes, so its
    # presence is the definition of "machine-wide" rather than a guess from a path.
    $roots = @()
    foreach ($hive in 'HKLM:\SOFTWARE\Python\PythonCore', 'HKLM:\SOFTWARE\WOW6432Node\Python\PythonCore') {
        if (-not (Test-Path $hive)) { continue }
        foreach ($ver in Get-ChildItem $hive -ErrorAction SilentlyContinue) {
            $ip = Join-Path $ver.PSPath 'InstallPath'
            if (-not (Test-Path $ip)) { continue }
            $path = (Get-ItemProperty $ip -ErrorAction SilentlyContinue).'(default)'
            if ($path -and (Test-Path (Join-Path $path 'python.exe'))) {
                $roots += [pscustomobject]@{ Version = $ver.PSChildName; Path = $path.TrimEnd('\') }
            }
        }
    }
    # Then the conventional all-users locations, for an install whose registry
    # entry was lost or never written.
    if ($roots.Count -eq 0) {
        foreach ($pattern in "$env:ProgramFiles\Python*", "${env:ProgramFiles(x86)}\Python*", 'C:\Python*') {
            foreach ($dir in (Get-Item $pattern -ErrorAction SilentlyContinue)) {
                if (Test-Path (Join-Path $dir.FullName 'python.exe')) {
                    $roots += [pscustomobject]@{ Version = $dir.Name; Path = $dir.FullName }
                }
            }
        }
    }

    if ($roots.Count -eq 0) {
        $storeHint = ''
        if (Test-Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\python.exe") {
            $storeHint = "`n`nThere IS a Python on this host, but it is the per-user Microsoft Store build " +
                         "under your own profile. No ACL can make that one usable by a service account: " +
                         "uninstall it or leave it, then install a machine-wide one."
        }
        throw ("No machine-wide Python found, so the sandbox accounts cannot be granted one." +
               $storeHint +
               "`n`nInstall it for all users, then re-run this script with -WithPython:" +
               "`n  winget install --id Python.Python.3.12 --scope machine --accept-package-agreements" +
               "`nor run the python.org installer with InstallAllUsers=1." +
               "`n`nVerify before re-running: Get-ChildItem 'HKLM:\SOFTWARE\Python\PythonCore' should list a version.")
    }

    # Highest version string wins. Two machine-wide Pythons is unusual and not
    # an error; picking the newer one is the same choice a person would make.
    return ($roots | Sort-Object { [version]($_.Version -replace '[^\d.]', '0.0') } -Descending |
            Select-Object -First 1).Path
}

$pythonRootResolved = ''
if ($WithPython) {
    $pythonRootResolved = Find-MachinePython -Explicit $PythonRoot
    Write-Host "Python for the sandbox: $pythonRootResolved"
}

function New-RandomPassword {
    -join ((1..24) | ForEach-Object { [char]((48..57) + (65..90) + (97..122) + (33, 35, 36, 37) | Get-Random) })
}

foreach ($name in $AccountNames) {
    $workspace = Join-Path $WorkspaceRoot $name

    if (-not (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) {
        $password = New-RandomPassword
        $secure = ConvertTo-SecureString $password -AsPlainText -Force
        New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -UserMayNotChangePassword `
            -Description "Aegis Deploy build sandbox account (managed by Create-BuildAccounts.ps1)" | Out-Null

        # No interactive or remote logon: this account only ever runs as the
        # target of Start-Process from the backend, never logs in directly.
        $sid = (Get-LocalUser -Name $name).SID.Value
        $sidObj = New-Object System.Security.Principal.SecurityIdentifier($sid)
        secedit /export /cfg "$env:TEMP\secpol.cfg" | Out-Null
        Add-Content "$env:TEMP\secpol.cfg" "`nSeDenyInteractiveLogonRight = $sid`nSeDenyRemoteInteractiveLogonRight = $sid`n"
        secedit /configure /db secedit.sdb /cfg "$env:TEMP\secpol.cfg" /areas USER_RIGHTS | Out-Null

        node -e "
            const ms = require('$($BackendDir -replace '\\', '/')/../extensions/deploy/backend/machineStore');
            ms.saveBuildAccountSecret('$name', '$password');
        "
        Write-Host "Created account $name and stored its password"
    } else {
        Write-Host "Account $name already exists, leaving it alone"
    }

    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    $acl = Get-Acl $workspace
    $acl.SetAccessRuleProtection($true, $false)   # stop inheriting from ProgramData
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) } | Out-Null
    foreach ($grantee in @($name, 'SYSTEM', 'Administrators')) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $grantee, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl $workspace $acl
    Write-Host "Scoped $workspace to $name (+ SYSTEM, Administrators) only"

    # Read and execute on the interpreter, never write. A sandbox account that
    # can write into the Python tree can drop a .pth or a sitecustomize.py that
    # every later build imports, which turns one compromised branch into a
    # foothold that outlives it.
    #
    # icacls and not Set-Acl here: this grant ADDS one entry to an inherited
    # tree that Windows owns, where the workspace above is a tree we own and
    # reset outright. Rebuilding Python's ACL from scratch would be a good way
    # to break Python for everyone.
    if ($WithPython) {
        & icacls $pythonRootResolved /grant "${name}:(OI)(CI)(RX)" /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not grant $name read+execute on $pythonRootResolved" }
        Write-Host "Granted $name read+execute on $pythonRootResolved"
    }

    $ruleBase = "AegisBuild-$name"
    if (-not (Get-NetFirewallRule -DisplayName "$ruleBase-AllowWeb" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "$ruleBase-AllowWeb" -Direction Outbound -Action Allow `
            -Protocol TCP -RemotePort 443, 80 -Package "*" -Owner (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value | Out-Null
        New-NetFirewallRule -DisplayName "$ruleBase-AllowDns" -Direction Outbound -Action Allow `
            -Protocol UDP -RemotePort 53 -Owner (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value | Out-Null
        Write-Host "Added outbound allow (443/80/53) scoped to $name"
    }
    foreach ($subnet in $DomainSubnets) {
        $denyName = "$ruleBase-DenyDomain-$($subnet -replace '[/.]', '_')"
        if (-not (Get-NetFirewallRule -DisplayName $denyName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $denyName -Direction Outbound -Action Block `
                -RemoteAddress $subnet -Owner (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value | Out-Null
            Write-Host "Added outbound deny to $subnet scoped to $name"
        }
    }
}

if ($WithPython) {
    Write-Host "`n--- Python: two things this script cannot do for you ---"
    Write-Host "1. The sandbox reaches `python` through the PATH it inherits from the Aegis"
    Write-Host "   service, which reads the MACHINE PATH at start. If you installed Python"
    Write-Host "   just now, restart the Aegis service or it will not see it."
    Write-Host "   Check from the service's own shell, not yours: (Get-Command python).Source"
    Write-Host "2. pip's cache lands under a profile these accounts do not have, since they"
    Write-Host "   never log on. Use --no-cache-dir in the project's install command:"
    Write-Host "     pip install --no-cache-dir -r requirements.txt --target ."
    Write-Host "   The download runs once per build, which is the right trade for a build"
    Write-Host "   that runs on a push rather than in a loop."
}

Write-Host "`nDone. Set AEGIS_BUILD_ACCOUNTS=$($AccountNames -join ',') for the backend if it differs from the default."
Write-Host "For the node runtime, run this again with its own names -- e.g. -AccountNames aegis-run-01,aegis-run-02 -- and set AEGIS_RUNTIME_ACCOUNTS to those. Separate accounts on purpose: a build borrows a slot for two minutes, a running application holds one until its project is deleted."
