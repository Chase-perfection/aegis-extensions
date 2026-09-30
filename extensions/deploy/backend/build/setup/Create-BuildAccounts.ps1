<#
Install-time setup for the Deploy sandbox accounts. Run once, as an
administrator, on the Aegis host, and again with -AccountNames if the node
runtime is being enabled: a running application needs accounts of its own
(AEGIS_RUNTIME_ACCOUNTS), not the build pool's. Creates 3 restricted local accounts, each
scoped by NTFS ACL to its own workspace folder, and 2 outbound firewall
rules per account (deny the domain/RFC1918, allow only 443/80/53). Passwords
are generated here and handed to machineStore.js for encrypted storage. It
shells out to Node once per account to do that, and machineStore requires
nothing but Node built-ins, so `node` on PATH is the only requirement: no
node_modules, and no path into the Aegis install.

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

<#
Every principal below is named by SID, never by name. Names are localized:
'Administrators' is 'Administrateurs' on a French Windows, and a name that does not translate throws
IdentityNotMappedException at AddAccessRule, after the account exists.
#>
$SystemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$AdministratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

<#
Adds the account to the two deny-logon rights, keeping whoever is already
there. Run on every pass, not only when the account is created: a pass that
stopped between the two used to leave an account that could log on, for good.

And to SeBatchLogonRight, the one logon the sandbox uses: run-sandboxed-build.ps1
logs the account on as a batch job (SandboxProcess.cs). Without it every build
fails with 1385. A batch logon is not an interactive one, so the two denies
still hold: nobody signs in at the console or over RDP with these accounts.

Through LsaAddAccountRights, one right for one SID. This used secedit: export
every right on the machine, add the SID, /configure the whole area back. On a
domain member the export carries domain and GPO entries that /configure cannot
all re-apply, so it exited 1 after the account existed, and it rewrote every
holder of every right to add one. The LSA call touches nothing else and adding
a right the account already holds succeeds, so rerunning stays free.
#>
if (-not ('AegisLsaRights' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AegisLsaRights {
    [StructLayout(LayoutKind.Sequential)]
    struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

    [StructLayout(LayoutKind.Sequential)]
    struct LSA_OBJECT_ATTRIBUTES {
        public int Length; public IntPtr RootDirectory; public IntPtr ObjectName;
        public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
    }

    [DllImport("advapi32.dll")]
    static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES attributes, uint access, out IntPtr handle);
    [DllImport("advapi32.dll")]
    static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, LSA_UNICODE_STRING[] rights, uint count);
    [DllImport("advapi32.dll")]
    static extern uint LsaClose(IntPtr handle);
    [DllImport("advapi32.dll")]
    static extern int LsaNtStatusToWinError(uint status);

    const uint POLICY_CREATE_ACCOUNT = 0x10;
    const uint POLICY_LOOKUP_NAMES = 0x800;

    public static void Add(byte[] sid, string right) {
        LSA_OBJECT_ATTRIBUTES attributes = new LSA_OBJECT_ATTRIBUTES();
        attributes.Length = Marshal.SizeOf(attributes);
        IntPtr handle;
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, out handle);
        if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
        IntPtr buffer = Marshal.StringToHGlobalUni(right);
        try {
            LSA_UNICODE_STRING name = new LSA_UNICODE_STRING();
            name.Buffer = buffer;
            name.Length = (ushort)(right.Length * 2);
            name.MaximumLength = (ushort)(right.Length * 2 + 2);
            status = LsaAddAccountRights(handle, sid, new LSA_UNICODE_STRING[] { name }, 1);
            if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
        } finally {
            Marshal.FreeHGlobal(buffer);
            LsaClose(handle);
        }
    }
}
'@
}

function Set-DenyLogon {
    param([System.Security.Principal.SecurityIdentifier]$Sid)

    $bytes = New-Object byte[] ($Sid.BinaryLength)
    $Sid.GetBinaryForm($bytes, 0)
    foreach ($right in 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeBatchLogonRight') {
        try {
            [AegisLsaRights]::Add($bytes, $right)
        } catch {
            # A method call wraps the Win32Exception in a MethodInvocationException.
            $e = $_.Exception
            if ($e.InnerException) { $e = $e.InnerException }
            throw "could not grant $right to $($Sid.Value): $($e.Message)"
        }
    }
}

<#
32 characters with at least two of each class, from the OS random generator.

A domain workstation applies the domain's password policy to local accounts
too, and New-LocalUser answers a refusal with a bare InvalidPasswordException.
The old draw (24 characters, any class, Get-Random) could land without a digit
or a symbol, and Get-Random is not a cryptographic source for a password
nobody ever types. Two of each class clears any complexity rule, 32 clears
any minimum length a policy can set (14, or 20 with the relaxed limit).
#>
function New-RandomPassword {
    $classes = @('ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#$%*+-=?@_')
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $pick = {
            param([string]$set)
            $b = New-Object byte[] 4
            $rng.GetBytes($b)
            $set[[int]([System.BitConverter]::ToUInt32($b, 0) % [uint32]$set.Length)]
        }
        $chars = New-Object System.Collections.Generic.List[char]
        foreach ($set in $classes) { 1..2 | ForEach-Object { $chars.Add((& $pick $set)) } }
        $all = -join $classes
        while ($chars.Count -lt 32) { $chars.Add((& $pick $all)) }
        # Shuffle, so the guaranteed characters are not always the first eight.
        for ($i = $chars.Count - 1; $i -gt 0; $i--) {
            $b = New-Object byte[] 4; $rng.GetBytes($b)
            $j = [int]([System.BitConverter]::ToUInt32($b, 0) % [uint32]($i + 1))
            $tmp = $chars[$i]; $chars[$i] = $chars[$j]; $chars[$j] = $tmp
        }
        return -join $chars
    } finally {
        $rng.Dispose()
    }
}

# machineStore lives beside this script, inside the extension: setup -> build ->
# backend. Reached from here rather than through the Aegis install, which is what
# makes this work now that an extension is unpacked under ProgramData instead of
# sitting in the Aegis tree. The old path walked five levels up to a `backend`
# folder that existed only in the pre-move layout, so on any real install it
# resolved to nothing and the failure surfaced as a Node stack about a missing
# module, naming neither this script nor the move that broke it.
$machineStore = Join-Path $PSScriptRoot '..\..\machineStore.js'
if (-not (Test-Path $machineStore)) {
    throw "machineStore.js not found at $machineStore -- this script must stay inside the extension, two levels under its backend/."
}
$machineStore = (Resolve-Path $machineStore).Path -replace '\\', '/'

foreach ($name in $AccountNames) {
    $workspace = Join-Path $WorkspaceRoot $name

    if (-not (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) {
        $password = New-RandomPassword
        $secure = ConvertTo-SecureString $password -AsPlainText -Force
        # New-LocalUser caps -Description at 48 characters and refuses the
        # whole call past that, before the account exists. The description is
        # also the mark Provision.ps1 `remove` finds these accounts by: change
        # one, change the other.
        try {
            New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -UserMayNotChangePassword `
                -Description "Aegis Deploy build sandbox account" -ErrorAction Stop | Out-Null
        } catch [Microsoft.PowerShell.Commands.InvalidPasswordException] {
            throw "Windows refused the generated password for local account $name. The password policy this machine applies (a domain GPO on a domain member) is stricter than 32 characters with every class; 'net accounts' and the domain's Default Domain Policy show it."
        }

        # Through the environment, not on the command line. An argument to node
        # is readable by anyone who can list processes, and the restricted
        # accounts this script creates are exactly who must not read it.
        $env:AEGIS_ACCOUNT_NAME = $name
        $env:AEGIS_ACCOUNT_SECRET = $password
        try {
            node -e "require('$machineStore').saveBuildAccountSecret(process.env.AEGIS_ACCOUNT_NAME, process.env.AEGIS_ACCOUNT_SECRET);"
            if ($LASTEXITCODE -ne 0) { throw "storing the password for $name failed" }
        } finally {
            Remove-Item Env:AEGIS_ACCOUNT_NAME, Env:AEGIS_ACCOUNT_SECRET -ErrorAction SilentlyContinue
        }
        Write-Host "Created account $name and stored its password"
    } else {
        Write-Host "Account $name already exists, leaving it alone"
    }

    $sid = (Get-LocalUser -Name $name).SID

    # No interactive or remote logon, and a batch logon: this account only
    # ever runs what the backend starts as it, never logs in directly.
    Set-DenyLogon -Sid $sid

    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    $acl = Get-Acl $workspace
    $acl.SetAccessRuleProtection($true, $false)   # stop inheriting from ProgramData
    # Explicit rules only, read as SIDs: asking for names would translate each
    # one, and the inherited ones go with the protection flag above anyway.
    $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
        ForEach-Object { $acl.RemoveAccessRule($_) } | Out-Null
    foreach ($grantee in @($sid, $SystemSid, $AdministratorsSid)) {
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
        & icacls $pythonRootResolved /grant "*$($sid.Value):(OI)(CI)(RX)" /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not grant $name read+execute on $pythonRootResolved" }
        Write-Host "Granted $name read+execute on $pythonRootResolved"
    }

    $ruleBase = "AegisBuild-$name"
    if (-not (Get-NetFirewallRule -DisplayName "$ruleBase-AllowWeb" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "$ruleBase-AllowWeb" -Direction Outbound -Action Allow `
            -Protocol TCP -RemotePort 443, 80 -Package "*" -Owner $sid.Value | Out-Null
        New-NetFirewallRule -DisplayName "$ruleBase-AllowDns" -Direction Outbound -Action Allow `
            -Protocol UDP -RemotePort 53 -Owner $sid.Value | Out-Null
        Write-Host "Added outbound allow (443/80/53) scoped to $name"
    }
    foreach ($subnet in $DomainSubnets) {
        $denyName = "$ruleBase-DenyDomain-$($subnet -replace '[/.]', '_')"
        if (-not (Get-NetFirewallRule -DisplayName $denyName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $denyName -Direction Outbound -Action Block `
                -RemoteAddress $subnet -Owner $sid.Value | Out-Null
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
