<#
Deploy's setup step, run by the Aegis service rather than by a person.

Core runs this file twice, with a different phase each time, and the difference
between the two is the whole reason there are two:

  -Phase prepare   at every install and every update. Creates what the host
                   needs and leaves the runtime OFF.
  -Phase enable    when an administrator clicks "Finish setup on this host".
                   Prints the environment the runtime needs; core writes it.

A third phase, -Phase prerequisites, runs before prepare when the store
drawer asks for missing host tools (git, python, node). Prerequisites.ps1 holds
the pinned installers.

Why this file exists at all. Turning the application runtime on used to mean
opening PowerShell as an administrator, knowing the subnet of your own Active
Directory, and setting two machine environment variables by hand. Aegis ships to
customers who will do none of those three, so the feature was reachable only by
its author. Everything here is the same work, done by the service that already
has the rights to do it.

This script never turns the runtime on by itself. `prepare` creates accounts and
stops; `enable` is a separate sentence, spoken by an administrator, because what
it allows is application code running on a server that holds directory audit
data. That decision was not automated away, only its procedure.

Rerunnable, because it runs again on every update. Create-BuildAccounts.ps1
leaves an account or a rule that already exists alone, and the environment it
prints is compared before it is written.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prerequisites', 'prepare', 'enable', 'remove')]
    [string]$Phase,

    # One comma-joined string: powershell -File passes arguments as strings.
    [string]$Prerequisites = '',

    # The accounts a running application may run as. One project holds one for as
    # long as it exists, unlike a build which borrows a slot for two minutes, so
    # this count is the count of projects that can run a process.
    [string[]]$RuntimeAccounts = @('aegis-run-01', 'aegis-run-02'),

    # Empty means "work it out", which is the normal case and the reason this
    # file exists. Passing it explicitly is for a host where the guess is wrong.
    [string[]]$DomainSubnets = @()
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

<#
The subnets the sandbox accounts must not reach.

Create-BuildAccounts.ps1 refuses to guess, and it is right not to: it is a
setup script run by a person who knows their network. This one is run by a
service on a machine nobody is watching, so refusing to guess would mean
refusing to work.

What it uses, in order of how much it proves:

  The interfaces that actually carry the domain. On a domain member, the
  adapters whose DNS servers are the domain controllers are the ones facing the
  directory, and their own IPv4 prefixes are the subnets to deny.

  Failing that, every RFC1918 range. Wider than necessary and never wrong: a
  sandbox account has no business reaching a private address in the first place,
  and the rule that follows allows 443, 80 and 53 outbound regardless.

Returned as CIDR strings, deduplicated. An empty answer is not possible: the
fallback always has something to say.
#>
function Get-DomainSubnet {
    $found = New-Object System.Collections.Generic.HashSet[string]

    try {
        $domain = (Get-CimInstance Win32_ComputerSystem).Domain
        $partOfDomain = (Get-CimInstance Win32_ComputerSystem).PartOfDomain
        if ($partOfDomain -and $domain) {
            foreach ($cfg in Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop) {
                if (-not $cfg.ServerAddresses) { continue }
                # An adapter pointed at a resolver that answers for the domain is
                # an adapter on the directory's network.
                $answers = $false
                foreach ($server in $cfg.ServerAddresses) {
                    try {
                        if (Resolve-DnsName -Name $domain -Server $server -Type A -QuickTimeout -ErrorAction Stop) {
                            $answers = $true
                            break
                        }
                    } catch {
                        # This resolver does not answer for the domain. Not an
                        # error: a machine can have several, and most will not.
                        Write-Verbose "$server does not answer for $domain"
                    }
                }
                if (-not $answers) { continue }
                foreach ($addr in Get-NetIPAddress -InterfaceIndex $cfg.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue) {
                    if ($addr.IPAddress -like '169.254.*') { continue }
                    $network = Get-NetworkAddress -IPAddress $addr.IPAddress -PrefixLength $addr.PrefixLength
                    if ($network) { [void]$found.Add("$network/$($addr.PrefixLength)") }
                }
            }
        }
    } catch {
        Write-Output "Could not read the domain configuration ($($_.Exception.Message)); falling back to the private ranges."
    }

    if ($found.Count -eq 0) {
        foreach ($range in @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')) { [void]$found.Add($range) }
        Write-Output 'No domain-facing interface identified; denying every private range instead.'
    }

    return @($found)
}

<# The network address for an IPv4 address and prefix length, as a string. #>
function Get-NetworkAddress {
    param([string]$IPAddress, [int]$PrefixLength)
    try {
        $ip = [System.Net.IPAddress]::Parse($IPAddress).GetAddressBytes()
        [array]::Reverse($ip)
        $value = [System.BitConverter]::ToUInt32($ip, 0)
        # A /0 would shift by 32, which on a UInt32 is a no-op rather than zero.
        $mask = if ($PrefixLength -le 0) { [uint32]0 } else { [uint32]([uint32]::MaxValue -shl (32 - $PrefixLength)) }
        $network = [System.BitConverter]::GetBytes([uint32]($value -band $mask))
        [array]::Reverse($network)
        return ([System.Net.IPAddress]::new($network)).ToString()
    } catch {
        return $null
    }
}

$setup = Join-Path $PSScriptRoot 'Create-BuildAccounts.ps1'
if (-not (Test-Path $setup)) {
    Write-Output "Create-BuildAccounts.ps1 is missing from $PSScriptRoot."
    exit 1
}

function Invoke-Prepare {
    $subnets = if ($DomainSubnets.Count) { $DomainSubnets } else { Get-DomainSubnet }
    Write-Output ("Denying the sandbox accounts these subnets: " + ($subnets -join ', '))

    # The build pool first, with the names the backend expects by default. Both
    # calls leave what already exists alone, so an update re-runs them for free.
    Write-Output 'Preparing the build accounts.'
    & $setup -DomainSubnets $subnets

    Write-Output 'Preparing the runtime accounts.'
    & $setup -AccountNames $RuntimeAccounts -DomainSubnets $subnets
}

function Get-MissingRuntimeAccount {
    @($RuntimeAccounts | Where-Object { -not (Get-LocalUser -Name $_ -ErrorAction SilentlyContinue) })
}

if ($Phase -eq 'prepare') {
    Invoke-Prepare

    # Deliberately nothing printed for core to write. Preparing the host is not
    # the same sentence as allowing application processes on it.
    Write-Output 'Prepared. The application runtime stays off until an administrator finishes setup.'
    exit 0
}

if ($Phase -eq 'prerequisites') {
    . (Join-Path $PSScriptRoot 'Prerequisites.ps1')
    $ids = @($Prerequisites -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $cache = Join-Path $env:ProgramData 'Aegis\cache'
    $results = Invoke-Prerequisites -Ids $ids -Pins $PrerequisitePins -CacheDir $cache
    # The one line core reads. Everything above it is for the install log.
    Write-Output (ConvertTo-Json -Compress -Depth 4 -InputObject @{ prerequisites = @($results) })
    exit 0
}

<#
remove: an administrator deleted Deploy from this server. Core deletes the code
and each tenant's `data\extensions\deploy`; this undoes the rest, which only
Deploy knows about. Everything is found by what Deploy wrote on it rather than
by a name pattern, so nothing another tool created is touched:

  - the local accounts whose description Create-BuildAccounts.ps1 set, and the
    Windows profiles they left
  - the outbound rules named AegisBuild-<account>-*, and the inbound site rules
    in the 'Aegis Deploy' group (firewall.js)
  - its folders: ProgramData\Aegis\deploy-build (build workspaces), the data
    root's deploy (the encrypted machine store) and each tenant's deploy
    (projects, sites, run logs)

A site still running under one of those accounts is stopped first. One that
cannot be stopped is a refusal and nothing is deleted: removing an account
whose process is alive leaves an orphan nobody can sign in as to stop.
The rest is best effort and reported line by line, because a rule that is
already gone must not make Deploy impossible to delete.
#>
if ($Phase -eq 'remove') {
    $mark = 'Aegis Deploy build sandbox account*'
    $accounts = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Description -like $mark })
    $names = @($accounts | ForEach-Object { $_.Name })

    if ($names.Count) {
        $stuck = @()
        foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
            $owner = $null
            try { $owner = (Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop).User } catch { continue }
            if ($owner -and ($names -contains $owner)) {
                try {
                    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                    Write-Output "Stopped $($p.Name) (pid $($p.ProcessId)) running as $owner."
                } catch {
                    $stuck += "$($p.Name) (pid $($p.ProcessId), $owner)"
                }
            }
        }
        if ($stuck.Count) {
            Write-Output ("Could not stop: " + ($stuck -join ', ') + ". Nothing was deleted. Stop them, then delete Deploy again.")
            exit 1
        }
    }

    $warnings = 0
    foreach ($a in $accounts) {
        $sid = $a.SID.Value
        foreach ($rule in @(Get-NetFirewallRule -DisplayName "AegisBuild-$($a.Name)-*" -ErrorAction SilentlyContinue)) {
            try { Remove-NetFirewallRule -InputObject $rule -ErrorAction Stop } catch { $warnings++; Write-Output "Rule $($rule.DisplayName) stayed: $($_.Exception.Message)" }
        }
        try { Remove-LocalUser -SID $sid -ErrorAction Stop; Write-Output "Deleted account $($a.Name)." }
        catch { $warnings++; Write-Output "Account $($a.Name) stayed: $($_.Exception.Message)" }
        foreach ($userProfile in @(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue)) {
            try { Remove-CimInstance -InputObject $userProfile -ErrorAction Stop; Write-Output "Deleted the profile of $($a.Name)." }
            catch { $warnings++; Write-Output "Profile $($userProfile.LocalPath) stayed: $($_.Exception.Message)" }
        }
    }

    $siteRules = @(Get-NetFirewallRule -Group 'Aegis Deploy' -ErrorAction SilentlyContinue)
    if ($siteRules.Count) {
        try { $siteRules | Remove-NetFirewallRule -ErrorAction Stop; Write-Output "Deleted $($siteRules.Count) site firewall rule(s)." }
        catch { $warnings++; Write-Output "Site firewall rules stayed: $($_.Exception.Message)" }
    }

    $folders = @(Join-Path $env:ProgramData 'Aegis\deploy-build')
    if ($env:AEGIS_DATA_ROOT) {
        $folders += Join-Path $env:AEGIS_DATA_ROOT 'deploy'
        $tenantsRoot = Join-Path $env:AEGIS_DATA_ROOT 'tenants'
        foreach ($t in @(Get-ChildItem -LiteralPath $tenantsRoot -Directory -ErrorAction SilentlyContinue)) {
            if ($t.Name -match '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$') { $folders += Join-Path $t.FullName 'deploy' }
        }
    } else {
        Write-Output 'AEGIS_DATA_ROOT is not set, so the machine store and the tenant deploy folders were left.'
        $warnings++
    }
    foreach ($f in $folders) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        try {
            # A link is removed as a link: Remove-Item -Recurse on a junction
            # would empty what it points to.
            $item = Get-Item -LiteralPath $f -Force
            if ($item.LinkType) { $item.Delete() } else { Remove-Item -LiteralPath $f -Recurse -Force -ErrorAction Stop }
            Write-Output "Deleted $f."
        } catch {
            $warnings++; Write-Output "$f stayed: $($_.Exception.Message)"
        }
    }

    # Core clears these from the service environment; its own switch too.
    Write-Output (@{ env = @{ AEGIS_DEPLOY_RUNTIME = $null; AEGIS_RUNTIME_ACCOUNTS = $null; AEGIS_DEPLOY_FIREWALL = $null } } | ConvertTo-Json -Compress)
    if ($warnings) { Write-Output "Deploy removed from the host, with $warnings item(s) left as listed above." }
    else { Write-Output 'Deploy removed from the host.' }
    exit 0
}

# enable: every account must exist before the runtime is allowed to name it.
# Reporting names the backend would then fail to use would turn a refusal an
# operator can read into a runtime error nobody sees.
#
# Missing accounts are prepared here rather than refused. `prepare` runs at
# install, and a host can reach this click without it having run or finished:
# an extension linked in place for development, a prepare the install recorded
# as failed and nobody read, accounts deleted since. "Reinstall the extension"
# was the answer, and it sent an administrator through a download to redo the
# one step this click can do itself. The click is the stronger consent of the
# two, so preparing under it asks for nothing the install did not.
$missing = Get-MissingRuntimeAccount
if ($missing.Count) {
    Write-Output ("These runtime accounts do not exist yet: " + ($missing -join ', ') + ". Preparing them now.")
    try {
        Invoke-Prepare
    } catch {
        # Printed, not rethrown: core keeps stdout and drops stderr, so a throw
        # here reached the operator as "Command failed" and nothing else.
        Write-Output ("Preparing the accounts failed: " + $_.Exception.Message)
        exit 1
    }
    $missing = Get-MissingRuntimeAccount
    if ($missing.Count) {
        Write-Output ("Could not create these runtime accounts: " + ($missing -join ', ') + ". The Aegis service must run as an administrator or as SYSTEM to create local accounts.")
        exit 1
    }
}

# Opening the port a site already listens on rides along with this click, and
# does not get a second one.
#
# A site binds 0.0.0.0 whatever this says: the listener is the exposure, and the
# firewall rule only stops the packets from being dropped on the way to it. So
# this grants no reach that creating the project did not already ask for, and
# withholding it produces the worst failure in the product: a site that is up,
# correct, and reported by every browser as a timeout.
#
# What is worth a decision is *which* networks, and that is not settled here.
# It defaults to LocalSubnet, the machine's own networks, and moves from the
# Domains pane, where it can be read and changed without a service restart.
$vars = @{
    AEGIS_DEPLOY_RUNTIME   = '1'
    AEGIS_RUNTIME_ACCOUNTS = ($RuntimeAccounts -join ',')
    AEGIS_DEPLOY_FIREWALL  = '1'
}
Write-Output ("Allowing application processes under: " + ($RuntimeAccounts -join ', '))
Write-Output 'Sites may open their port on this host, scoped to this machine networks. Change that in the Domains pane.'
# The one line core reads. Everything else on stdout is for the install log.
Write-Output (@{ env = $vars } | ConvertTo-Json -Compress)
exit 0
