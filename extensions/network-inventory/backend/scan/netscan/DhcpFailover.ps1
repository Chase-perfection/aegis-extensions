# Which DHCP server speaks for a scope that more than one server holds.
#
# Dot-sourced by shield/network_scan.ps1. Pure: it takes what the scan read
# off each server and returns a decision, so shield/tests/netscan.tests.ps1
# can walk every failover state without a DHCP server in sight.
#
# THE RULE
#
#   Hot standby   The server configured as primary (ServerRole Active) is the
#                 authority. The standby takes over only when BOTH hold: the
#                 primary is off (the scan could not reach it) AND the failover
#                 has engaged (the standby reports PartnerDown or
#                 CommunicationInterrupted, i.e. it is serving the scope).
#                 One without the other is not a takeover, it is an anomaly,
#                 and the report says which one.
#   Load balance  No server is the authority: both serve the scope, so both are
#                 named, "DHCP1 / DHCP2".
#   Split scope   The same scope on two servers with no failover relationship,
#                 the pre-2012 way of sharing one. Both named, like load balance.
#   Standalone    One server, nothing to decide.
#
# Before this, the second server read simply overwrote the first, so which one
# the dashboard named depended on the order Get-DhcpServerInDC listed them.
#
# Runs under Windows PowerShell 5.1, like the scan that loads it.

<#
.SYNOPSIS
    Failover states in which the standby is actually serving the scope.
.DESCRIPTION
    PartnerDown: the standby has declared the primary dead and owns the whole
    pool. CommunicationInterrupted: it has lost the primary and is serving new
    clients from its reserve. Both count as the failover being engaged. Every
    other state (Normal, Recover*, Init, Startup, Paused...) does not.
#>
function Get-DhcpTakeoverState {
    return @('PartnerDown', 'CommunicationInterrupted')
}

# Short, lowercase host name: failover relationships name the partner by FQDN,
# Get-DhcpServerInDC by FQDN too, and the dashboard shows the short form.
function ConvertTo-DhcpServerKey {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return "" }
    return ("$Name".Trim().Split('.')[0]).ToLowerInvariant()
}

<#
.SYNOPSIS
    Decides which server is the authority for one scope, and how to name it.
.PARAMETER Candidates
    One entry per server that returned this scope. Each carries:
      Server  short host name
      Mode    'HotStandby' | 'LoadBalance' | '' (no failover relationship read)
      Role    'Active' | 'Standby' | ''          (hot standby only)
      State   failover state as that server reports it
      Partner partner host name from the relationship, FQDN or short
.PARAMETER UnreachableServers
    Servers the scan listed but could not read at all. A partner absent from the
    candidates AND present here is "off"; a partner merely absent is unknown.
.OUTPUTS
    $null for no candidate, else an ordered hashtable:
      mode        standalone | hotstandby | loadbalance | split
      authority   server name that speaks for the scope, or '' when shared
      label       what the dashboard shows
      servers     every server involved, sorted
      dataFrom    reachable servers to take leases and reservations from
      takeover    $true when the standby has taken over
      state       failover state that drove the decision
      reason      one French sentence, shown in the dashboard
      issue       $null, or @{ status; message; hint } for the diagnostic report
#>
function Resolve-DhcpScopeAuthority {
    param(
        [object[]]$Candidates = @(),
        [string[]]$UnreachableServers = @()
    )

    $cands = @($Candidates | Where-Object { $_ -and $_.Server })
    if ($cands.Count -eq 0) { return $null }

    $down = @($UnreachableServers | ForEach-Object { ConvertTo-DhcpServerKey $_ } | Where-Object { $_ })
    $reachable = @($cands | ForEach-Object { ConvertTo-DhcpServerKey $_.Server } | Sort-Object -Unique)
    $takeoverStates = Get-DhcpTakeoverState

    $withRel = @($cands | Where-Object { "$($_.Mode)" -in @('HotStandby', 'LoadBalance') })

    # ── No failover relationship on any server ──
    if ($withRel.Count -eq 0) {
        if ($reachable.Count -eq 1) {
            return [ordered]@{
                mode = 'standalone'; authority = $reachable[0]; label = $reachable[0]
                servers = @($reachable); dataFrom = @($reachable); takeover = $false; state = ''
                reason = ''; issue = $null
            }
        }
        return [ordered]@{
            mode = 'split'; authority = ''; label = ($reachable -join ' / ')
            servers = @($reachable); dataFrom = @($reachable); takeover = $false; state = ''
            reason = "Étendue partagée sans relation de basculement (split-scope) : chaque serveur distribue sa part."
            issue = $null
        }
    }

    $rel = $withRel[0]
    $partner = ConvertTo-DhcpServerKey $rel.Partner
    $servers = @(@($reachable) + @($partner) | Where-Object { $_ } | Sort-Object -Unique)

    # ── Load balance: both serve, both are named ──
    if ("$($rel.Mode)" -eq 'LoadBalance') {
        $missing = @($servers | Where-Object { $_ -notin $reachable })
        $engaged = @($withRel | Where-Object { "$($_.State)" -in $takeoverStates }).Count -gt 0
        $issue = $null
        $state = "$($rel.State)"
        if ($missing.Count -gt 0) {
            $alone = $reachable -join ', '
            $isDown = @($missing | Where-Object { $_ -in $down }).Count -gt 0
            $issue = @{
                status  = if ($isDown) { 'failed' } else { 'degraded' }
                message = "Répartition de charge : $($missing -join ', ') $(if ($isDown) { 'est injoignable' } else { "n'a pas été lu par le scan" }), $alone sert seul l'étendue (état $state)."
                hint    = "La redondance DHCP est perdue tant que le partenaire ne répond pas. Vérifier le service DHCP sur $($missing -join ', ') puis l'état de la relation avec Get-DhcpServerv4Failover."
            }
        }
        return [ordered]@{
            mode = 'loadbalance'; authority = ''; label = ($servers -join ' / ')
            servers = @($servers); dataFrom = @($reachable); takeover = $engaged; state = $state
            reason = "Répartition de charge : les deux serveurs distribuent l'étendue."
            issue = $issue
        }
    }

    # ── Hot standby ──
    $primary = ''; $standby = ''
    foreach ($c in $withRel) {
        $me = ConvertTo-DhcpServerKey $c.Server
        $other = ConvertTo-DhcpServerKey $c.Partner
        if ("$($c.Role)" -eq 'Active') { $primary = $me; $standby = $other; break }
        if ("$($c.Role)" -eq 'Standby') { $primary = $other; $standby = $me; break }
    }

    if (-not $primary) {
        # A hot-standby relationship whose role could not be read. Refuse to
        # guess a primary: name both, and say why.
        return [ordered]@{
            mode = 'hotstandby'; authority = ''; label = ($servers -join ' / ')
            servers = @($servers); dataFrom = @($reachable); takeover = $false; state = "$($rel.State)"
            reason = "Secours à chaud dont le rôle principal n'a pas pu être lu."
            issue = @{
                status  = 'degraded'
                message = "Relation de secours à chaud sans rôle lisible : impossible de dire lequel de $($servers -join ' et ') est le principal."
                hint    = "Lire la relation avec Get-DhcpServerv4Failover sur chacun des deux serveurs ; la propriété ServerRole doit valoir Active sur le principal."
            }
        }
    }

    $primaryUp = $primary -in $reachable
    $standbyUp = $standby -in $reachable
    $standbyCand = @($withRel | Where-Object { (ConvertTo-DhcpServerKey $_.Server) -eq $standby }) | Select-Object -First 1
    $primaryCand = @($withRel | Where-Object { (ConvertTo-DhcpServerKey $_.Server) -eq $primary }) | Select-Object -First 1
    $standbyState = if ($standbyCand) { "$($standbyCand.State)" } else { '' }
    $primaryState = if ($primaryCand) { "$($primaryCand.State)" } else { '' }
    $engaged = $standbyState -in $takeoverStates

    # Off AND failover engaged: the standby speaks for the scope.
    if (-not $primaryUp -and $engaged) {
        return [ordered]@{
            mode = 'hotstandby'; authority = $standby; label = $standby
            servers = @($servers); dataFrom = @($standby); takeover = $true; state = $standbyState
            reason = "Principal $primary hors ligne, bascule active : le secours $standby sert l'étendue."
            issue = @{
                status  = 'failed'
                message = "Le serveur DHCP principal $primary est hors ligne et le secours $standby a pris le relais (état $standbyState)."
                hint    = "Remettre en service le DHCP sur $primary. Une fois revenu, la relation repasse en Normal d'elle-même ; si elle reste en PartnerDown, la resynchroniser avec Invoke-DhcpServerv4FailoverReplication."
            }
        }
    }

    # Off but not engaged: the primary still speaks, its data comes from the standby.
    if (-not $primaryUp) {
        $isDown = $primary -in $down
        return [ordered]@{
            mode = 'hotstandby'; authority = $primary; label = $primary
            servers = @($servers); dataFrom = @($reachable); takeover = $false; state = $standbyState
            reason = "Principal $primary, lu via son secours $standby."
            issue = @{
                status  = 'degraded'
                message = "Le principal $primary $(if ($isDown) { 'ne répond pas au scan' } else { "n'a pas été lu" }), mais son secours $standby ne signale aucune bascule (état $(if ($standbyState) { $standbyState } else { 'inconnu' })). Les baux affichés viennent du secours, qui les réplique."
                hint    = "Le DHCP fonctionne pour les clients : c'est le chemin entre la machine du scan et $primary qui est en cause. Vérifier le pare-feu (RPC 135 et ports dynamiques) et les droits DHCP Users sur $primary."
            }
        }
    }

    # Primary up: it speaks, whatever the standby says.
    $issue = $null
    if ($engaged) {
        $issue = @{
            status  = 'degraded'
            message = "Le secours $standby se déclare en bascule (état $standbyState) alors que le principal $primary répond : la relation est désynchronisée."
            hint    = "Vérifier la communication entre $primary et $standby (port TCP 647). Si elle est rétablie, repasser la relation en Normal depuis la console DHCP."
        }
    }
    elseif (-not $standbyUp -and $standby) {
        $isDown = $standby -in $down
        $issue = @{
            status  = 'degraded'
            message = "Le secours $standby $(if ($isDown) { 'est injoignable' } else { "n'a pas été lu par le scan" }) : le principal $primary sert l'étendue sans redondance$(if ($primaryState) { " (état $primaryState)" })."
            hint    = "Tant que $standby ne répond pas, une panne de $primary coupe le DHCP sur cette étendue. Vérifier le service DHCP sur $standby."
        }
    }

    return [ordered]@{
        mode = 'hotstandby'; authority = $primary; label = $primary
        servers = @($servers); dataFrom = @($primary); takeover = $false
        state = if ($primaryState) { $primaryState } else { $standbyState }
        reason = "Secours à chaud : $primary est le principal, $standby le secours."
        issue = $issue
    }
}
