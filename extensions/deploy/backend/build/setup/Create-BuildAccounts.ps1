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
#>
[CmdletBinding()]
param(
    [string[]]$AccountNames = @('aegis-build-01', 'aegis-build-02', 'aegis-build-03'),
    [string]$WorkspaceRoot = (Join-Path $env:ProgramData 'Aegis\deploy-build'),
    [string]$BackendDir = (Join-Path $PSScriptRoot '..\..\..\..\..\backend'),
    [string[]]$DomainSubnets = @()   # e.g. '10.0.0.0/8' -- pass the AD subnet(s) explicitly, this script does not guess them
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node is not on PATH -- run this from a shell where the Aegis backend's Node is reachable"
}
if ($DomainSubnets.Count -eq 0) {
    Write-Warning "No -DomainSubnets given: the domain-controller deny rule will not be created. Pass -DomainSubnets '10.0.0.0/8' (or your AD subnet) before relying on this in production."
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

Write-Host "`nDone. Set AEGIS_BUILD_ACCOUNTS=$($AccountNames -join ',') for the backend if it differs from the default."
Write-Host "For the node runtime, run this again with its own names -- e.g. -AccountNames aegis-run-01,aegis-run-02 -- and set AEGIS_RUNTIME_ACCOUNTS to those. Separate accounts on purpose: a build borrows a slot for two minutes, a running application holds one until its project is deleted."
