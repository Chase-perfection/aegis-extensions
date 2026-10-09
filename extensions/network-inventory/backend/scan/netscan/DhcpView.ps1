# What the DHCP view of the page is built from: which servers the scan reads,
# and the shape each of them is reported in.
#
# Dot-sourced by network_scan.ps1. Pure, like its neighbours: the scan does the
# reads and hands the results in, so tests/netscan.tests.ps1 can walk every case
# without a DHCP server.
#
# WHY THIS EXISTS
#
# The scan used to fold everything a DHCP server said into the subnet rows: one
# card per network, leases flattened into addresses. Two things were lost on the
# way. A scope that no server returned left its network with a card reading
# "no scope", which states an absence nobody checked when a server had refused
# the read. And a server the directory does not list (a standalone one, or one
# whose authorization was never recorded) could not be read at all, because the
# directory was the only list.
#
# Runs under Windows PowerShell 5.1, like the scan that loads it.

<#
.SYNOPSIS
    True for a name that may be handed to -ComputerName and to a command line.
.DESCRIPTION
    The same characters Start-NetOnly.ps1 accepts for a domain: what a DNS or
    NetBIOS host name can carry, and nothing a shell would read as syntax.
#>
function Test-DhcpServerName {
    param([string]$Name)
    return ("$Name" -match '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$')
}

<#
.SYNOPSIS
    Splits the -DhcpServer argument into names, dropping what is not one.
.OUTPUTS
    @{ names = string[]; rejected = string[] }. The caller reports the rejected
    ones: a declared server silently ignored is the silence this file is against.
#>
function ConvertTo-DhcpServerNameList {
    param([string]$Raw)
    $names = New-Object System.Collections.ArrayList
    $rejected = New-Object System.Collections.ArrayList
    # -split, not String.Split: handed an array, the method picks a different
    # overload under 7.x than under 5.1 and returned nothing there.
    foreach ($part in ("$Raw" -split '[,;]')) {
        $n = $part.Trim()
        if (-not $n) { continue }
        if (Test-DhcpServerName $n) { [void]$names.Add($n) } else { [void]$rejected.Add($n) }
    }
    return @{ names = @($names); rejected = @($rejected) }
}

<#
.SYNOPSIS
    The servers to read: those the directory authorizes, then those the operator
    declared, each once.
.DESCRIPTION
    Keyed by short host name, the way failover relationships and the dashboard
    name a server. The directory entry wins a duplicate because it carries the
    address the authorization was recorded with, which the stale-authorization
    check needs.
.PARAMETER Authorized
    What Get-DhcpServerInDC returned: objects with DnsName and IPAddress.
.PARAMETER Declared
    Host names the operator added by hand.
.OUTPUTS
    Objects with DnsName, IPAddress and Origin ('directory' | 'declared').
#>
function Merge-DhcpServerList {
    param(
        [object[]]$Authorized = @(),
        [string[]]$Declared = @()
    )
    $seen = @{}
    $out = New-Object System.Collections.ArrayList
    foreach ($a in @($Authorized)) {
        if (-not $a) { continue }
        $name = "$($a.DnsName)"
        $key = ("$name".Trim().Split('.')[0]).ToLowerInvariant()
        if (-not $key -or $seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$out.Add([PSCustomObject]@{ DnsName = $name; IPAddress = "$($a.IPAddress)"; Origin = 'directory' })
    }
    foreach ($d in @($Declared)) {
        $name = "$d".Trim()
        $key = ($name.Split('.')[0]).ToLowerInvariant()
        if (-not $key -or $seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$out.Add([PSCustomObject]@{ DnsName = $name; IPAddress = ''; Origin = 'declared' })
    }
    # Unary comma: one server must still come back as a list.
    return , @($out)
}

<#
.SYNOPSIS
    One server of the DHCP view, before its scopes are read.
.PARAMETER Status
    read | refused | unreachable | stale. 'stale' is a directory authorization
    whose name no longer answers on the recorded address: the server may have
    been retired or merely re-addressed, and the diagnostic says both.
#>
function New-DhcpServerView {
    param(
        [string]$Name,
        [string]$Fqdn,
        [string]$Origin = 'directory',
        [ValidateSet('read', 'refused', 'unreachable', 'stale')][string]$Status = 'read'
    )
    return [ordered]@{
        name    = $Name
        fqdn    = $Fqdn
        origin  = $Origin
        status  = $Status
        filters = $null
        scopes  = (New-Object System.Collections.ArrayList)
    }
}

<#
.SYNOPSIS
    A lease duration in whole seconds, or $null when the scope has none.
.DESCRIPTION
    An unlimited lease is a TimeSpan too large for an [int], and a cast that
    throws would cost the whole scope its entry. $null reads as "unlimited".
#>
function ConvertTo-LeaseDuration {
    param($Duration)
    if ($null -eq $Duration) { return $null }
    try {
        $s = [double]$Duration.TotalSeconds
        if ($s -le 0 -or $s -gt 2147483647) { return $null }
        return [int]$s
    }
    catch { return $null }
}
