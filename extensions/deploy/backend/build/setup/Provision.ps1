<#
Deploy's setup step, run by the Aegis service rather than by a person.

Core runs this file twice, with a different phase each time, and the difference
between the two is the whole reason there are two:

  -Phase prepare   at every install and every update. Creates what the host
                   needs and leaves the runtime OFF.
  -Phase enable    when an administrator clicks "Finish setup on this host".
                   Prints the environment the runtime needs; core writes it.

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
    [ValidateSet('prepare', 'enable')]
    [string]$Phase,

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

if ($Phase -eq 'prepare') {
    $subnets = if ($DomainSubnets.Count) { $DomainSubnets } else { Get-DomainSubnet }
    Write-Output ("Denying the sandbox accounts these subnets: " + ($subnets -join ', '))

    # The build pool first, with the names the backend expects by default. Both
    # calls leave what already exists alone, so an update re-runs them for free.
    Write-Output 'Preparing the build accounts.'
    & $setup -DomainSubnets $subnets

    Write-Output 'Preparing the runtime accounts.'
    & $setup -AccountNames $RuntimeAccounts -DomainSubnets $subnets

    # Deliberately nothing printed for core to write. Preparing the host is not
    # the same sentence as allowing application processes on it.
    Write-Output 'Prepared. The application runtime stays off until an administrator finishes setup.'
    exit 0
}

# enable: every account must exist before the runtime is allowed to name it.
# Reporting names the backend would then fail to use would turn a refusal an
# operator can read into a runtime error nobody sees.
$missing = @($RuntimeAccounts | Where-Object { -not (Get-LocalUser -Name $_ -ErrorAction SilentlyContinue) })
if ($missing.Count) {
    Write-Output ("These runtime accounts do not exist: " + ($missing -join ', ') + ". Reinstall the extension to prepare them.")
    exit 1
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
