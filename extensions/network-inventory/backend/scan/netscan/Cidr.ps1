# IPv4 CIDR arithmetic for the network inventory scan.
#
# Dot-sourced by shield/network_scan.ps1. It lives beside it rather than under
# shield/src/ because build.ps1 concatenates everything in src/ into the single
# Shield-Audit.ps1 artefact, and none of this belongs to the audit engine.
#
# Every function here is pure: no script state, no $SubnetMeta, no I/O. That is
# what makes shield/tests/netscan.tests.ps1 able to exercise them, and the whole
# reason they were pulled out of the scan.
#
# WINDOWS POWERSHELL 5.1 IS THE TARGET RUNTIME. backend/src/server.js launches
# the scan with powershell.exe, not pwsh. Nothing here may assume 7.x, and the
# test file has to be run under 5.1 as well as under the 7.4 shield runner: the
# first bug this code ever had existed only in 5.1. See ConvertTo-SubnetMask.

# 0xFFFFFFFF is written as a decimal on purpose. Windows PowerShell 5.1 parses
# that hex literal as a signed [int] worth -1, so every mask derived from it
# threw "cannot convert -1 to System.UInt64" — and did, until a test caught it.
function Get-IPv4FullMask { return [uint64]4294967295 }

<#
.SYNOPSIS
    Dotted-quad to its 32-bit number. $null when the input is not four octets.
#>
function ConvertTo-IpNumber {
    param([string]$Ip)
    $o = "$Ip".Split('.')
    if ($o.Count -ne 4) { return $null }
    foreach ($part in $o) {
        if ($part -notmatch '^\d{1,3}$' -or [int]$part -gt 255) { return $null }
    }
    return ([uint32]$o[0] -shl 24) -bor ([uint32]$o[1] -shl 16) -bor ([uint32]$o[2] -shl 8) -bor [uint32]$o[3]
}

<#
.SYNOPSIS
    32-bit number back to a dotted quad.
#>
function ConvertFrom-IpNumber {
    param([uint32]$Number)
    return "$(($Number -shr 24) -band 255).$(($Number -shr 16) -band 255).$(($Number -shr 8) -band 255).$($Number -band 255)"
}

<#
.SYNOPSIS
    Subnet mask to prefix length. 255.255.252.0 -> 22.
#>
function ConvertTo-PrefixLength {
    param([string]$Mask)
    $bits = 0
    foreach ($o in "$Mask".Split('.')) {
        $b = [int]$o
        while ($b) { $bits += ($b -band 1); $b = $b -shr 1 }
    }
    return $bits
}

<#
.SYNOPSIS
    Prefix length to subnet mask. 22 -> 255.255.252.0.
#>
function ConvertTo-SubnetMask {
    param([int]$PrefixLength)
    if ($PrefixLength -le 0) { return "0.0.0.0" }
    if ($PrefixLength -ge 32) { return "255.255.255.255" }
    $all = Get-IPv4FullMask
    return (ConvertFrom-IpNumber ([uint32](($all -shl (32 - $PrefixLength)) -band $all)))
}

<#
.SYNOPSIS
    Network address of the prefix an address falls in. 10.0.1.37/22 -> 10.0.0.0.
#>
function Get-NetworkAddress {
    param([string]$Ip, [int]$PrefixLength)
    $num = ConvertTo-IpNumber $Ip
    if ($null -eq $num) { return $null }
    if ($PrefixLength -le 0) { return "0.0.0.0" }
    if ($PrefixLength -ge 32) { return $Ip }
    $all = Get-IPv4FullMask
    $mask = [uint32](($all -shl (32 - $PrefixLength)) -band $all)
    return (ConvertFrom-IpNumber ([uint32]($num -band $mask)))
}

<#
.SYNOPSIS
    Usable hosts in a prefix, network and broadcast excluded. /24 -> 254.
    0 for /31 and /32, which have no usable host range.
#>
function Get-UsableHostCount {
    param([int]$PrefixLength)
    if ($PrefixLength -lt 1 -or $PrefixLength -gt 30) { return 0 }
    return [int]([math]::Pow(2, 32 - $PrefixLength) - 2)
}

<#
.SYNOPSIS
    Every usable address of a CIDR, or $null when it holds more than -MaxHosts.
.DESCRIPTION
    The ceiling is the caller's: a /16 enumerated host by host is 65534 pings and
    outlives the request that asked for it, so the scan declares the etendue and
    inventories it from its DHCP leases instead. Returning $null rather than a
    truncated list is deliberate — a short list would read as "these are all the
    addresses", which is the lie the ceiling exists to avoid.
#>
function Get-CidrHostList {
    param([string]$Cidr, [int]$MaxHosts = 1022)
    $bits = "$Cidr".Split('/')
    if ($bits.Count -ne 2) { return $null }
    $prefix = 0
    if (-not [int]::TryParse($bits[1], [ref]$prefix)) { return $null }
    $count = Get-UsableHostCount $prefix
    if ($count -le 0 -or $count -gt $MaxHosts) { return $null }
    $base = ConvertTo-IpNumber $bits[0]
    if ($null -eq $base) { return $null }
    $out = New-Object System.Collections.ArrayList
    for ($i = 1; $i -le $count; $i++) { [void]$out.Add((ConvertFrom-IpNumber ([uint32]($base + $i)))) }
    # Unary comma: PowerShell enumerates a collection on the way out of a
    # function, so the caller would receive loose strings instead of one list.
    return , $out
}

<#
.SYNOPSIS
    Sorts declared CIDRs longest-prefix-first, ready for Resolve-CidrForIp.
.DESCRIPTION
    Built once per set of subnets rather than per address: the scan resolves one
    CIDR for every address it holds, which is thousands of lookups.
#>
function New-CidrIndex {
    param([string[]]$Cidr = @())
    $rows = New-Object System.Collections.ArrayList
    foreach ($c in $Cidr) {
        $bits = "$c".Split('/')
        if ($bits.Count -ne 2) { continue }
        $p = 0
        if (-not [int]::TryParse($bits[1], [ref]$p)) { continue }
        if ($p -lt 0 -or $p -gt 32) { continue }
        $b = ConvertTo-IpNumber $bits[0]
        if ($null -eq $b) { continue }
        [void]$rows.Add([PSCustomObject]@{
                cidr   = "$c"
                prefix = $p
                base   = $b
                size   = [uint64][math]::Pow(2, 32 - $p)
            })
    }
    # Comma for the same reason as Get-CidrHostList: one declared subnet must
    # still come back as a list, not as a bare row.
    return , @($rows | Sort-Object -Property prefix -Descending)
}

<#
.SYNOPSIS
    Files an address into the longest declared prefix containing it.
.DESCRIPTION
    Falls back to the address's /24 when no declared prefix contains it, which is
    what the scan did unconditionally before: a DHCP etendue of 10.0.0.0/22 then
    produced one subnet row holding none of its 1022 addresses, beside four
    anonymous /24 rows holding them without its label, VLAN or DHCP block.
#>
function Resolve-CidrForIp {
    param([string]$Ip, [object[]]$Index = @())
    $num = ConvertTo-IpNumber $Ip
    if ($null -ne $num) {
        foreach ($row in $Index) {
            if ($num -ge $row.base -and $num -lt ([uint64]$row.base + $row.size)) { return $row.cidr }
        }
    }
    $o = "$Ip".Split('.')
    if ($o.Count -ne 4) { return $null }
    return "$($o[0]).$($o[1]).$($o[2]).0/24"
}
