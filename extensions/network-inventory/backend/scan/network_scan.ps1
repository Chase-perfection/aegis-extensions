param(
    [string]$Domain,
    # Emits one canned payload through the real encoding path and exits, without
    # touching the network, the directory or any DHCP server. It exists so
    # shield/tests/netscan.tests.ps1 can prove an accented scope name survives
    # the trip to the backend — the bug that shipped and had to be spotted by eye
    # in the dashboard. The backend never passes it.
    [switch]$SelfTest,
    # Runs the directory, DHCP and DNS reads only, skips the ping sweep, and
    # emits { account, diagnostics, context }: what the scan account can read,
    # in seconds rather than a full scan. Behind the page's "test access" button.
    [switch]$ProbeOnly,
    # DHCP servers the operator declared, comma separated, read in addition to
    # those the directory authorizes. A standalone server, or one whose
    # authorization was never recorded, is in no directory list.
    [string]$DhcpServer
)

# Aegis Network Inventory Scanner v4 - C# Engine
# Uses inline C# for high-performance parallel ping sweep & DNS resolution
# Sources: Local Interfaces, Gateway, ARP, C# Ping Sweep, AD, DNS, DHCP, C# Reverse DNS
# Outputs the subnet-explorer contract to stdout:
#   { ips: [...], subnets: [...], scannedAt, diagnostics: [...], context: {...} }
# ips[]     = { ip, network, status, hostname, mac, macCount, dns[], dnsRecords[],
#               dhcp{kind,detail,expiresAt}, anomalies[], lastSeen, source, type }
# subnets[] = { cidr, network, prefix, mask, label, vlan, dhcp{...}|null, dns{...}|null }
# diagnostics[] = { source, status, message, hint, command, detail, at }
# The backend (inventoryService.js) derives per-subnet counts and aggregates anomalies.
#
# A subnet is keyed by its REAL prefix, not by an assumed /24: a DHCP scope of
# 10.0.0.0/22 produces one subnet holding its 1022 addresses. Every IP is filed
# into the longest declared prefix that contains it (Resolve-CidrForIp), so a
# scope and its addresses can never end up in two different rows.

$ErrorActionPreference = "Continue"

# =============================================
# Output encoding
# =============================================
# Without this, a DHCP scope named "Plage Réseau DHCP" reached the dashboard as
# "Plage R?seau DHCP". backend/src/server.js launches this script with
# powershell.exe and reads its stdout as UTF-8, but Windows PowerShell 5.1
# writes stdout in the console code page — ibm850 on a French Windows, where
# "é" is the single byte 0x82. That is not valid UTF-8, so Node replaced it.
# Every accented name coming off a DHCP or DNS server was corrupted this way.
#
# UTF8Encoding($false), not [Text.Encoding]::UTF8: the latter carries a BOM
# preamble, and a BOM landing at the head of the JSON line would break the
# JSON.parse on the other side. Shield-Audit.ps1 does the same thing (its own
# output goes to a file, where a BOM is harmless).
#
# The other half of the fix is the UTF-8 BOM on this file itself: without it,
# 5.1 decodes the source as the ANSI code page and the accented string literals
# below ("Réservation (DHCP)") are mangled before they are ever printed.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

$IpInventory = @{} # IP -> PSCustomObject

# --- enrichment side-structures (preserve the structure the scan already gathers) ---
$MacsByIp = @{}        # IP -> HashSet[string] of observed MACs (conflict detection)
$DnsByIp = @{}         # IP -> ArrayList of @{ type; value; ttl }
$HasA = @{}            # IP -> $true when a forward A record exists
$HasPtr = @{}          # IP -> $true when a reverse PTR record exists
$IpByName = @{}        # lowercased FQDN -> IP (resolves CNAME targets to an IP)
$PendingCnames = New-Object System.Collections.ArrayList  # @{ alias; target; ttl }
$DhcpByIp = @{}        # IP -> @{ kind; detail; expiresAt }
$ResByIp = @{}         # IP -> $true when a DHCP reservation exists
$PingByIp = @{}        # IP -> roundtrip ms when the host answered a ping this scan
$ArpByIp = @{}         # IP -> @{ stale = $true/$false } when present in the neighbour table
$SubnetMeta = @{}      # cidr -> @{ cidr; network; prefix; mask; label; vlan; dhcp; dns }
$ScanTime = (Get-Date).ToString("o")

# Ping sweep and free-address enumeration stop at 1022 hosts (a /22). Past that
# a scope is inventoried from its DHCP leases, its reservations and DNS only,
# and the diagnostic report says so: a /16 swept host by host would outlast the
# request that asked for it.
$SweepMaxHosts = 1022

# =============================================
# Shared helpers
# =============================================
# Pure CIDR arithmetic and the diagnostic log live beside this file, in
# shield/netscan/, so shield/tests/netscan.tests.ps1 can exercise them without
# running a scan. They are NOT under shield/src/: build.ps1 concatenates
# everything there into Shield-Audit.ps1, and none of this is audit engine.
. (Join-Path $PSScriptRoot 'netscan/Cidr.ps1')
. (Join-Path $PSScriptRoot 'netscan/ScanDiagnostics.ps1')
# These two were missing for as long as the DHCP half has existed. The scan
# called Resolve-DhcpScopeAuthority and ConvertTo-DhcpServerKey without ever
# loading the file that defines them: each call failed as an unknown command,
# the decision stayed $null, and every scope the servers returned was dropped
# while the report said "1 étendue lue". tests/netscan.tests.ps1 now checks that
# every helper the scan calls comes from a file it loads.
. (Join-Path $PSScriptRoot 'netscan/DhcpFailover.ps1')
. (Join-Path $PSScriptRoot 'netscan/DhcpView.ps1')

# The scan never dies on a missing source: it records why and carries on. Each
# entry travels to the dashboard, which renders the lot as one copyable report
# an operator can hand to whoever administers the DHCP or DNS server.
$Diag = New-ScanDiagnosticLog

# Named in the diagnostics, not just in the report header: a refusal from a DHCP
# server is fixed by granting THIS account, and the person who reads the report
# is rarely the person who ran the scan.
#
# Started through Start-NetOnly.ps1, the scan keeps the service's local identity
# and reads the network as the tenant's scan account. $env:USERNAME would then
# name the service, which is the wrong account to grant, so the launcher passes
# the network one along.
$ScanAccount = if ($env:AEGIS_SCAN_NET_ACCOUNT) { "$env:AEGIS_SCAN_NET_ACCOUNT" } else { "$env:USERDOMAIN\$env:USERNAME" }

# =============================================
# Self-test
# =============================================
# Placed here deliberately: after the encoding setup and the helpers, before any
# network, directory or DHCP call. Everything an accented string passes through
# on its way to the backend is already in place, and nothing that needs a domain
# has run yet, so this works on a build agent.
if ($SelfTest) {
    Add-ScanDiagnostic -Log $Diag -Source 'Auto-test' -Status 'degraded' `
        -Message "Étendue DHCP « Plage Réseau » : accents, guillemets et caractères composés." `
        -Hint "Entrée fabriquée par -SelfTest. Aucun réseau n'a été interrogé." `
        -Command 'Get-DhcpServerv4Scope -ComputerName srv-dhcp'
    $probe = [ordered]@{
        ips         = @()
        subnets     = @(@{
                cidr = "10.0.0.0/22"; network = "10.0.0.0"; prefix = 22
                mask = (ConvertTo-SubnetMask 22); label = "Plage Réseau DHCP"; vlan = 20
                dhcp = $null; dns = $null
            })
        scannedAt   = $ScanTime
        diagnostics = @($Diag)
        context     = [ordered]@{ selfTest = $true; computerName = "$env:COMPUTERNAME"; userName = $ScanAccount }
    }
    # One server, one scope, one lease, one of everything: the case where 5.1
    # is most tempted to hand a list back as a bare object, and the deepest
    # path of the payload, built with the helpers the real scan uses.
    $stView = New-DhcpServerView -Name 'srv-dhcp-01' -Fqdn 'srv-dhcp-01.corp.local' -Origin 'declared'
    $stView.filters = [ordered]@{
        allowEnabled = $false; denyEnabled = $true
        allow = (New-Object System.Collections.ArrayList)
        deny = @([ordered]@{ mac = '02-00-00-AA-BB-CC'; description = 'Appareil refusé' })
    }
    [void]$stView.scopes.Add([ordered]@{
            scopeId = '10.0.0.0'; mask = (ConvertTo-SubnetMask 22); cidr = '10.0.0.0/22'
            name = 'Plage Réseau DHCP'; state = 'Active'
            rangeStart = '10.0.1.50'; rangeEnd = '10.0.3.200'
            leaseSeconds = (ConvertTo-LeaseDuration ([TimeSpan]::FromHours(8))); utilization = 40
            exclusions = @([ordered]@{ start = '10.0.1.50'; end = '10.0.1.59' })
            leases = @([ordered]@{ ip = '10.0.1.60'; mac = '02:00:00:AA:BB:01'; hostName = 'poste-a'; state = 'Active'; expiresAt = $ScanTime })
            reservations = @([ordered]@{ ip = '10.0.1.70'; mac = '00:11:22:33:44:55'; name = 'imprimante-étage' })
            failover = $null
        })
    $probe.dhcp = [ordered]@{ servers = @($stView) }
    $probe | ConvertTo-Json -Depth 10 -Compress
    exit 0
}

# =============================================
# Subnet registry
# =============================================
# The two helpers below are the only ones that stay here, because they are the
# only ones that touch scan state: $SubnetMeta, the set of declared subnets.

<#
.SYNOPSIS
    Declares a subnet, so the sweep, the free-address enumeration and the
    address filing all agree on it. Idempotent.
.DESCRIPTION
    Returns the normalised CIDR, or $null for a prefix outside /8../30 — wider
    than /8 is not a subnet, and /31 and /32 have no usable host range.
#>
function Register-Cidr {
    param([string]$Ip, [int]$Prefix)
    if ($Prefix -lt 8 -or $Prefix -gt 30) { return $null }
    $net = Get-NetworkAddress -Ip $Ip -PrefixLength $Prefix
    if (-not $net) { return $null }
    $cidr = "$net/$Prefix"
    if (-not $SubnetMeta.ContainsKey($cidr)) {
        $SubnetMeta[$cidr] = @{
            cidr = $cidr; network = $net; prefix = $Prefix
            mask = (ConvertTo-SubnetMask $Prefix); label = ""; vlan = $null
            dhcp = $null; dns = $null
        }
    }
    return $cidr
}

# The longest-prefix index, rebuilt only when $SubnetMeta gained a subnet.
# Resolve-CidrForIp is called once per address in the inventory, which is
# thousands of times; sorting the subnet list each time would show.
$CidrIndex = $null
$CidrIndexSize = -1
function Get-ScanCidrIndex {
    if ($script:CidrIndexSize -ne $SubnetMeta.Count) {
        $script:CidrIndex = New-CidrIndex -Cidr @($SubnetMeta.Keys)
        $script:CidrIndexSize = $SubnetMeta.Count
    }
    return $script:CidrIndex
}

# TimeSpan -> compact human string ("8j", "1h", "45min"); used for DNS TTL + lease duration.
function Format-Span {
    param([TimeSpan]$Span)
    if ($null -eq $Span) { return "" }
    if ($Span.TotalDays -ge 1) { return ([int]$Span.TotalDays).ToString() + "j" }
    if ($Span.TotalHours -ge 1) { return ([int]$Span.TotalHours).ToString() + "h" }
    return ([int]$Span.TotalMinutes).ToString() + "min"
}

# Future-relative "6j 4h" style expiry, from now to $When.
function Format-Until {
    param([datetime]$When)
    $delta = $When - (Get-Date)
    if ($delta.TotalSeconds -le 0) { return "" }
    $d = [int]$delta.TotalDays
    $h = $delta.Hours
    if ($d -ge 1) { return "$d" + "j " + "$h" + "h" }
    if ($delta.TotalHours -ge 1) { return "$([int]$delta.TotalHours)h" }
    return "$([int]$delta.TotalMinutes)min"
}

# Parse a "VLAN 20" hint out of a DHCP scope name; $null when absent.
function Get-VlanFromName {
    param([string]$Name)
    if ($Name -and $Name -match '(?i)vlan[\s_-]*(\d+)') { return [int]$Matches[1] }
    return $null
}

# =============================================
# C# ENGINE: High-Performance Network Scanner
# =============================================
$NetworkScannerCode = @"
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Threading.Tasks;
using System.Net.Sockets;
using System.Text;

public class NetworkScanner {

    public class PingResult {
        public string IP { get; set; }
        public bool Alive { get; set; }
        public long RoundtripMs { get; set; }
    }

    public class DnsResult {
        public string IP { get; set; }
        public string Hostname { get; set; }
    }

    public class NetBiosResult {
        public string IP { get; set; }
        public string Name { get; set; }
    }

    public static List<PingResult> PingSweepSubnets(string[] subnetPrefixes, int timeoutMs = 800) {
        var allIps = new List<string>();
        foreach (var prefix in subnetPrefixes) {
            for (int i = 1; i <= 254; i++) {
                allIps.Add(prefix + "." + i);
            }
        }
        return PingSweepIps(allIps.ToArray(), timeoutMs);
    }

    // Sweeps an explicit address list. The caller expands each CIDR, so a /22
    // scope is one sweep and a /25 never spills into the rest of its /24.
    public static List<PingResult> PingSweepIps(string[] allIps, int timeoutMs = 800) {
        var results = new ConcurrentBag<PingResult>();

        Parallel.ForEach(allIps, new ParallelOptions { MaxDegreeOfParallelism = 256 }, ip => {
            try {
                using (var ping = new Ping()) {
                    var reply = ping.Send(ip, timeoutMs);
                    if (reply.Status == IPStatus.Success) {
                        results.Add(new PingResult {
                            IP = ip,
                            Alive = true,
                            RoundtripMs = reply.RoundtripTime
                        });
                    }
                }
            } catch { }
        });

        return results.ToList();
    }

    public static List<DnsResult> BatchReverseDns(string[] ips) {
        var results = new ConcurrentBag<DnsResult>();
        Parallel.ForEach(ips, new ParallelOptions { MaxDegreeOfParallelism = 64 }, ip => {
            try {
                var entry = Dns.GetHostEntry(ip);
                if (!string.IsNullOrEmpty(entry.HostName) && entry.HostName != ip) {
                    results.Add(new DnsResult { IP = ip, Hostname = entry.HostName });
                }
            } catch { }
        });
        return results.ToList();
    }

    public static List<NetBiosResult> BatchNetBiosLookup(string[] ips) {
        var results = new ConcurrentBag<NetBiosResult>();
        Parallel.ForEach(ips, new ParallelOptions { MaxDegreeOfParallelism = 32 }, ip => {
            string name = GetNetBiosName(ip);
            if (!string.IsNullOrEmpty(name)) {
                results.Add(new NetBiosResult { IP = ip, Name = name });
            }
        });
        return results.ToList();
    }

    private static string GetNetBiosName(string ip) {
        try {
            byte[] query = new byte[] {
                0x80, 0x94, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x20, 0x43, 0x4b, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
                0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
                0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x00, 0x00, 0x21,
                0x00, 0x01
            };

            using (var client = new UdpClient()) {
                client.Client.SendTimeout = 500;
                client.Client.ReceiveTimeout = 500;
                client.Send(query, query.Length, ip, 137);
                IPEndPoint remote = new IPEndPoint(IPAddress.Any, 0);
                byte[] response = client.Receive(ref remote);

                if (response.Length > 56) {
                    int nameCount = response[56];
                    if (nameCount > 0) {
                        byte[] nameBytes = new byte[15];
                        Array.Copy(response, 57, nameBytes, 0, 15);
                        return Encoding.ASCII.GetString(nameBytes).Trim();
                    }
                }
            }
        } catch { }
        return null;
    }
}
"@

# Compile C# engine
$EngineReady = $false
try {
    $ExistingType = [System.Management.Automation.PSTypeName]'NetworkScanner'
    if ($null -ne $ExistingType.Type) {
        $EngineReady = $true
    }
    else {
        Write-Host "Compiling C# Network Scanner Engine (Ultra-Fast Parallel Edition)..."
        Add-Type -TypeDefinition $NetworkScannerCode -ReferencedAssemblies "System.Net.Primitives", "System.Threading.Tasks", "System.Core"
        $EngineReady = $true
        Write-Host "C# Engine compiled successfully."
    }
}
catch {
    Add-ScanDiagnostic -Log $Diag -Source 'Moteur C#' -Status 'degraded' `
        -Message "La compilation du moteur C# a échoué, le scan bascule sur PowerShell (nettement plus lent)." `
        -Hint "Vérifier que .NET est complet sur cette machine et qu'aucune stratégie n'interdit la compilation à la volée (répertoire TEMP non exécutable, AppLocker, antivirus)." `
        -Command 'Add-Type -TypeDefinition $NetworkScannerCode' -ErrorRecord $_
    Write-Host "Falling back to PowerShell methods."
}

# =============================================
# Helper functions
# =============================================
function Install-RSATModule {
    param([string]$ModuleName)
    if (Get-Module -ListAvailable -Name $ModuleName) { return $true }
    try {
        Install-WindowsFeature "RSAT-$ModuleName" -ErrorAction SilentlyContinue | Out-Null
        return $null -ne (Get-Module -ListAvailable -Name $ModuleName)
    }
    catch { return $false }
}

# Elevation drives half of what this scan can read (DHCP RPC, some WMI paths),
# so the report states it rather than leaving the operator to guess.
$IsElevated = $false
try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $IsElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
catch { $IsElevated = $false }

function Add-ToInventory {
    param([string]$Ip, [string]$Name, [string]$Type, [string]$Source, [string]$Mac = "-")
    if ([string]::IsNullOrWhiteSpace($Ip) -or $Ip -eq "0.0.0.0" -or $Ip -like "127.*" -or $Ip -like "169.254.*") { return }
    # Accumulate every distinct MAC seen for this IP (ARP, DHCP, …) — >1 signals a conflict.
    if ($Mac -and $Mac -ne "-") {
        $macUp = $Mac.ToUpper()
        if (-not $MacsByIp.ContainsKey($Ip)) { $MacsByIp[$Ip] = New-Object 'System.Collections.Generic.HashSet[string]' }
        [void]$MacsByIp[$Ip].Add($macUp)
    }
    if ($IpInventory.ContainsKey($Ip)) {
        if ($IpInventory[$Ip].Source -notlike "*$Source*") {
            $IpInventory[$Ip].Source += ", $Source"
        }
        if ($Name -and $Name -ne "-" -and ($IpInventory[$Ip].Name -eq "-" -or [string]::IsNullOrWhiteSpace($IpInventory[$Ip].Name))) {
            $IpInventory[$Ip].Name = $Name
        }
        if ($Mac -and $Mac -ne "-" -and $IpInventory[$Ip].Mac -eq "-") {
            $IpInventory[$Ip].Mac = $Mac
        }
    }
    else {
        $IpInventory[$Ip] = [PSCustomObject]@{
            IP = $Ip; Name = if ($Name) { $Name } else { "-" }
            Type = if ($Type) { $Type } else { "Equipement" }
            Source = $Source; Status = "taken"; Mac = if ($Mac) { $Mac } else { "-" }
        }
    }
}

# --- Detect PDC ---
$Pdc = $null
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $Pdc = (Get-ADDomain).PDCEmulator
    Write-Host "Domain controller: $Pdc"
}
catch {
    Add-ScanDiagnostic -Log $Diag -Source 'Active Directory' -Status 'failed' `
        -Message "L'annuaire Active Directory est injoignable, le scan retombe sur la machine locale. Les objets ordinateur, les zones DNS et les serveurs DHCP autorisés ne seront pas lus." `
        -Hint "Exécuter le scan depuis une machine jointe au domaine, avec le module ActiveDirectory installé (RSAT) et un compte autorisé à lire l'annuaire." `
        -Command 'Import-Module ActiveDirectory; (Get-ADDomain).PDCEmulator' -ErrorRecord $_
    $Pdc = $env:COMPUTERNAME
}

# =============================================
# SOURCE 1: Local Network Interfaces
# =============================================
Write-Host "PROGRESS:5"
Write-Host "Scanning local network interfaces..."
try {
    $LocalIPs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" }
    foreach ($lip in $LocalIPs) {
        Add-ToInventory -Ip $lip.IPAddress -Name $env:COMPUTERNAME -Type "Local Machine" -Source "Interface"
        # The interface's own prefix, not an assumed /24: a machine on a /22 must
        # declare the /22 or its scope would arrive later and split in four.
        #
        # Capped, though, and only here. A DHCP scope wider than the sweep ceiling
        # is still a real etendue and earns its row; an interface mask is not. A
        # machine configured /16 would otherwise declare 65534 addresses, swallow
        # every DHCP scope and DNS zone underneath it into one unswept row, and
        # replace a usable inventory with a single line.
        $ifPrefix = [int]$lip.PrefixLength
        if ((Get-UsableHostCount $ifPrefix) -gt $SweepMaxHosts) {
            Add-ScanDiagnostic -Log $Diag -Source 'Interfaces locales' -Status 'degraded' `
                -Message "L'interface $($lip.IPAddress)/$ifPrefix couvre plus de $SweepMaxHosts adresses : seul son /24 est retenu comme point de départ." `
                -Hint "Les étendues DHCP déclarées sur ce segment restent lues telles quelles, avec leur masque réel. Ce repli ne concerne que le sous-réseau déduit de la carte réseau."
            $ifPrefix = 24
        }
        [void](Register-Cidr -Ip $lip.IPAddress -Prefix $ifPrefix)
    }
}
catch {
    Add-ScanDiagnostic -Log $Diag -Source 'Interfaces locales' -Status 'failed' `
        -Message "L'énumération des interfaces réseau locales a échoué : le scan ne connaît aucun sous-réseau de départ." `
        -Hint "Vérifier que le service Gestion des cartes réseau répond et que le compte du scan peut lire la configuration IP." `
        -Command 'Get-NetIPAddress -AddressFamily IPv4' -ErrorRecord $_
}

# =============================================
# SOURCE 2: Default Gateway
# =============================================
Write-Host "PROGRESS:10"
Write-Host "Detecting default gateway..."
try {
    $Gateways = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue
    foreach ($gw in $Gateways) {
        $gwIp = $gw.NextHop
        if ($gwIp -and $gwIp -ne "0.0.0.0") {
            $gwName = "-"
            try {
                $resolved = [System.Net.Dns]::GetHostEntry($gwIp)
                if ($resolved.HostName) { $gwName = $resolved.HostName }
            }
            catch {}
            Add-ToInventory -Ip $gwIp -Name $gwName -Type "Passerelle" -Source "Route Table"
        }
    }
}
catch {
    Add-ScanDiagnostic -Log $Diag -Source 'Passerelle' -Status 'degraded' `
        -Message "La table de routage n'a pas pu être lue : la passerelle par défaut n'apparaîtra pas dans l'inventaire." `
        -Hint "Sans conséquence sur le reste du scan. Vérifier Get-NetRoute si la passerelle doit figurer à l'inventaire." `
        -Command 'Get-NetRoute -DestinationPrefix 0.0.0.0/0' -ErrorRecord $_
}

# =============================================
# SOURCE 3: ARP Table
# =============================================
Write-Host "PROGRESS:15"
Write-Host "Scanning ARP table..."
try {
    $Neighbors = Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.State -ne "Unreachable" -and $_.IPAddress -notlike "224.*" -and $_.IPAddress -notlike "239.*" -and $_.IPAddress -notlike "255.*" -and $_.IPAddress -ne "0.0.0.0" -and $_.IPAddress -notlike "169.254.*" }
    foreach ($n in $Neighbors) {
        $nType = if ($n.State -eq "Reachable" -or $n.State -eq "Permanent") { "Equipement (Online)" } else { "Equipement" }
        $macAddr = if ($n.LinkLayerAddress) { ($n.LinkLayerAddress -replace '-', ':').ToUpper() } else { "-" }
        $ArpByIp[$n.IPAddress] = @{ stale = ($n.State -ne "Reachable" -and $n.State -ne "Permanent") }
        Add-ToInventory -Ip $n.IPAddress -Name "-" -Type $nType -Source "ARP" -Mac $macAddr
    }
}
catch {
    Add-ScanDiagnostic -Log $Diag -Source 'Table ARP' -Status 'degraded' `
        -Message "La table de voisinage ARP n'a pas pu être lue : les adresses MAC des équipements du même segment manqueront." `
        -Hint "Vérifier Get-NetNeighbor. Sur une machine virtuelle sans carte en mode pont, la table est normalement pauvre." `
        -Command 'Get-NetNeighbor -AddressFamily IPv4' -ErrorRecord $_
}

# =============================================
# SOURCE 4: AD Computers
# =============================================
Write-Host "PROGRESS:25"
Write-Host "Scanning AD computer objects..."
try {
    $Computers = @(Get-ADComputer -Filter * -Properties IPv4Address, DNSHostName -ErrorAction Stop)
    foreach ($c in $Computers) {
        if ($c.IPv4Address) {
            Add-ToInventory -Ip $c.IPv4Address -Name $c.DNSHostName -Type "AD Computer" -Source "AD"
        }
    }
}
catch {
    Add-ScanDiagnostic -Log $Diag -Source 'Objets ordinateur AD' -Status 'degraded' `
        -Message "La lecture des objets ordinateur de l'annuaire a échoué : les postes connus de l'AD mais éteints n'apparaîtront pas." `
        -Hint "Vérifier que le module ActiveDirectory est installé et que le compte du scan peut lire les objets ordinateur du domaine." `
        -Command 'Get-ADComputer -Filter * -Properties IPv4Address, DNSHostName' -ErrorRecord $_
}

# =============================================
# SOURCE 5: DHCP scopes, leases and reservations
# =============================================
# Runs ahead of DNS on purpose. A DHCP scope carries the authoritative geometry
# of a subnet (its real mask, its name, its VLAN), so declaring the scopes first
# means the reverse DNS zones that follow attach to the scope instead of minting
# a /24 inside one that is wider than that.
#
# Two passes. READ collects what every server says about every scope, touching
# nothing. APPLY then groups the reads by subnet, lets Resolve-DhcpScopeAuthority
# (netscan/DhcpFailover.ps1) decide which server speaks for each one, and only
# then writes the inventory. A scope held by a failover pair used to be written
# once per server, the second overwriting the first, so the server the dashboard
# named depended on the order the directory listed them.
Write-Host "PROGRESS:30"
function ConvertTo-Mac {
    param([string]$ClientId)
    if ([string]::IsNullOrWhiteSpace($ClientId)) { return "-" }
    return ($ClientId -replace '-', ':').ToUpper()
}

# Scope reads, keyed by the subnet each scope declares: one entry per distinct
# etendue however many servers answered for it. Declared here, above the module
# check, so the report can count them whether or not the DHCP half ran at all.
$ScopeReads = @{}            # cidr -> ArrayList of per-server reads
# One entry per server the scan tried, read or not, each with its scopes as that
# server holds them. The page's DHCP view is this list; the subnet cards above
# are the same reads merged by network. Declared here for the same reason.
$DhcpView = New-Object System.Collections.ArrayList
$DhcpModuleOk = $false
try { $DhcpModuleOk = Install-RSATModule "DhcpServer" } catch { $DhcpModuleOk = $false }

if (-not $DhcpModuleOk) {
    Add-ScanDiagnostic -Log $Diag -Source 'DHCP' -Status 'failed' `
        -Message "Le module PowerShell DhcpServer est absent de cette machine et n'a pas pu être installé : aucune étendue DHCP ne peut être lue." `
        -Hint "Installer les outils d'administration DHCP. Sur un serveur : Install-WindowsFeature RSAT-DHCP. Sur un poste de travail : Add-WindowsCapability -Online -Name Rsat.DHCP.Tools~~~~0.0.1.0. Puis relancer le scan." `
        -Command 'Get-Module -ListAvailable -Name DhcpServer'
}
else {
    Write-Host "Extracting DHCP scopes, leases and reservations..."
    $DhcpServers = @()
    $DhcpEnumFailed = $false
    try {
        $DhcpServers = @(Get-DhcpServerInDC -ErrorAction Stop)
    }
    catch {
        $DhcpEnumFailed = $true
        Add-ScanDiagnostic -Log $Diag -Source 'DHCP' -Status 'failed' `
            -Message "La liste des serveurs DHCP autorisés dans l'Active Directory n'a pas pu être lue : aucune étendue ne sera inventoriée." `
            -Hint "Cette requête lit le conteneur NetServices de la partition de configuration du domaine. Vérifier que la machine est jointe au domaine, que l'annuaire répond, et que le compte du scan est autorisé à le lire." `
            -Command 'Get-DhcpServerInDC' -ErrorRecord $_
    }

    # Servers the operator declared join the list whatever the directory said,
    # including when it could not be read: they are the way to reach a server
    # the directory does not know.
    $declared = ConvertTo-DhcpServerNameList $DhcpServer
    foreach ($bad in $declared.rejected) {
        Add-ScanDiagnostic -Log $Diag -Source 'DHCP' -Status 'degraded' `
            -Message "Le serveur DHCP déclaré « $bad » n'est pas un nom d'hôte valide et n'a pas été lu." `
            -Hint "Corriger ce nom dans la liste des serveurs DHCP de la page : lettres, chiffres, points et tirets uniquement."
    }
    $DhcpServers = Merge-DhcpServerList -Authorized $DhcpServers -Declared $declared.names

    if (-not $DhcpEnumFailed -and $DhcpServers.Count -eq 0) {
        Add-ScanDiagnostic -Log $Diag -Source 'DHCP' -Status 'degraded' `
            -Message "Aucun serveur DHCP n'est autorisé dans l'Active Directory : l'inventaire se limitera aux adresses vues par ping, ARP et DNS." `
            -Hint "Si un serveur DHCP Windows existe sans être autorisé dans l'annuaire, le déclarer dans la vue DHCP de la page, ou l'autoriser avec Add-DhcpServerInDC. Un serveur DHCP tiers, sur un pare-feu ou un routeur par exemple, n'apparaît jamais ici : ses baux resteront invisibles." `
            -Command 'Get-DhcpServerInDC'
    }

    # ───────────────────────── READ ─────────────────────────
    $UnreachableDhcp = New-Object System.Collections.ArrayList
    $FailoverReadErrors = @{}    # server key -> ErrorRecord, reported only if it matters

    foreach ($Srv in $DhcpServers) {
        $srvName = "$($Srv.DnsName)"
        $srvShort = $srvName.Split('.')[0]
        $srvKey = ConvertTo-DhcpServerKey $srvName
        $srvSource = "DHCP - $srvShort"
        $srvView = New-DhcpServerView -Name $srvKey -Fqdn $srvName -Origin "$($Srv.Origin)"
        [void]$DhcpView.Add($srvView)

        $Scopes = @()
        try {
            $Scopes = @(Get-DhcpServerv4Scope -ComputerName $srvName -ErrorAction Stop)
        }
        catch {
            [void]$UnreachableDhcp.Add($srvKey)
            # Three different problems arrive here as one CimException, and they
            # have three different fixes. Ordered from most specific:
            #
            #   stale         the directory still authorizes a server that is
            #                 gone. The name resolves elsewhere, or nowhere, and
            #                 the call lands on a machine that is not the one it
            #                 asked for, which refuses it. Looks exactly like a
            #                 rights problem and is not one.
            #   access denied WIN32 5. The server answered and said no.
            #   silence       everything else: service down, RPC filtered.
            #
            # Reporting all three as "n'a pas répondu", as this did, sends the
            # operator to a firewall in two cases out of three.
            $declaredIp = "$($Srv.IPAddress)"
            $resolved = @()
            try {
                $resolved = @(Resolve-DnsName -Name $srvName -Type A -ErrorAction Stop |
                    Where-Object { $_.IPAddress } | ForEach-Object { "$($_.IPAddress)" })
            }
            catch { $resolved = @() }

            if (Test-DhcpAuthorizationStale -DeclaredIp $declaredIp -ResolvedIps $resolved) {
                $where = if ($resolved.Count) { "répond aujourd'hui sur $($resolved -join ', ')" } else { "ne résout plus" }
                $srvView.status = 'stale'
                # Two situations give this exact picture and the scan cannot
                # tell them apart from here: the server was retired, or it was
                # given a new address and still serves. The hint used to assert
                # the first, and sent the operator to delete the authorization
                # of a server that may be the one handing out the addresses.
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'failed' `
                    -Message "L'annuaire autorise un serveur DHCP $srvName sur $declaredIp, mais ce nom $where : l'autorisation ne correspond plus au serveur, et sa lecture a échoué." `
                    -Hint "Deux cas possibles. Si $srvName sert toujours le DHCP à sa nouvelle adresse : réenregistrer son autorisation (Remove-DhcpServerInDC -DnsName $srvName -IPAddress $declaredIp, puis Add-DhcpServerInDC avec l'adresse actuelle, depuis un compte Enterprise Admins) et vérifier que $ScanAccount est membre de DHCP Users sur ce serveur. Si $srvName a été retiré : supprimer l'autorisation avec la même commande Remove-DhcpServerInDC, ainsi que l'enregistrement A résiduel du nom ; aucun droit n'est alors à accorder. Pour trancher : la ligne « Serveur DHCP » de ipconfig /all sur un poste du réseau concerné." `
                    -Command "Get-DhcpServerv4Scope -ComputerName $srvName" -ErrorRecord $_
            }
            elseif (Test-DhcpAccessDenied $_) {
                $srvView.status = 'refused'
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'failed' `
                    -Message "Le serveur DHCP $srvName a refusé la lecture de ses étendues au compte $ScanAccount : accès refusé." `
                    -Hint "Ajouter $ScanAccount au groupe local DHCP Users de $srvName (lecture seule) ou DHCP Administrators, puis relancer le scan. Le même refus apparaît quand le rôle DHCP n'est plus installé sur ce serveur alors qu'il reste autorisé dans l'annuaire : dans ce cas le retirer avec Remove-DhcpServerInDC." `
                    -Command "Get-DhcpServerv4Scope -ComputerName $srvName" -ErrorRecord $_
            }
            else {
                $srvView.status = 'unreachable'
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'failed' `
                    -Message "Le serveur DHCP $srvName n'a pas répondu : ses étendues et ses baux sont absents de l'inventaire." `
                    -Hint "Vérifier que le service DHCP tourne sur $srvName, que le port RPC 135 et les ports dynamiques sont ouverts depuis cette machine, et que le compte du scan est membre de DHCP Users ou DHCP Administrators sur ce serveur. S'il appartient à une paire de basculement, son partenaire continue normalement de servir les clients." `
                    -Command "Get-DhcpServerv4Scope -ComputerName $srvName" -ErrorRecord $_
            }
            continue
        }

        # MAC filters are a property of the server, not of a scope: one Allow
        # list and one Deny list, each switched on or off as a whole.
        try {
            $fl = Get-DhcpServerv4FilterList -ComputerName $srvName -ErrorAction Stop
            $allow = New-Object System.Collections.ArrayList
            $deny = New-Object System.Collections.ArrayList
            foreach ($f in @(Get-DhcpServerv4Filter -ComputerName $srvName -ErrorAction Stop)) {
                if (-not $f) { continue }
                $entry = [ordered]@{ mac = "$($f.MacAddress)".ToUpper(); description = "$($f.Description)" }
                if ("$($f.List)" -eq 'Allow') { [void]$allow.Add($entry) } else { [void]$deny.Add($entry) }
            }
            $srvView.filters = [ordered]@{
                allowEnabled = [bool]$fl.Allow; denyEnabled = [bool]$fl.Deny
                allow = $allow; deny = $deny
            }
        }
        catch {
            Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'degraded' `
                -Message "Les filtres d'adresses MAC de $srvName n'ont pas pu être lus : les listes Autoriser et Refuser sont absentes de la vue DHCP." `
                -Hint "Sans conséquence sur l'inventaire des adresses. Vérifier que $ScanAccount est membre de DHCP Users sur $srvName." `
                -Command "Get-DhcpServerv4Filter -ComputerName $srvName" -ErrorRecord $_
        }

        if ($Scopes.Count -eq 0) {
            Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'degraded' `
                -Message "Le serveur DHCP $srvName répond mais ne déclare aucune étendue IPv4." `
                -Hint "Normal pour un serveur en attente de configuration ou dédié à l'IPv6. Sinon, vérifier les étendues dans la console DHCP." `
                -Command "Get-DhcpServerv4Scope -ComputerName $srvName"
            continue
        }

        # Failover relationships, indexed by scope. A server with none returns
        # nothing on most builds and an error on some, which is why the error is
        # parked here and only reported when a shared scope actually needs it.
        $RelByScope = @{}
        try {
            foreach ($rel in @(Get-DhcpServerv4Failover -ComputerName $srvName -ErrorAction Stop)) {
                if (-not $rel) { continue }
                foreach ($sid in @($rel.ScopeId)) {
                    if ($sid) { $RelByScope["$($sid.IPAddressToString)"] = $rel }
                }
            }
        }
        catch { $FailoverReadErrors[$srvKey] = $_ }

        foreach ($Scope in $Scopes) {
            $scopeId = "$($Scope.ScopeId.IPAddressToString)"
            $maskStr = "$($Scope.SubnetMask.IPAddressToString)"
            $scopeName = "$($Scope.Name)"

            # The real prefix of the scope, read from its mask: a /22 scope stays
            # one subnet of 1022 addresses instead of the /24 its ScopeId starts in.
            $prefix = 0
            try { $prefix = ConvertTo-PrefixLength $maskStr } catch { $prefix = 0 }
            if ($prefix -lt 8 -or $prefix -gt 30) {
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'degraded' `
                    -Message "L'étendue $scopeId (masque $maskStr) sort de la plage exploitable /8 à /30 et a été ignorée." `
                    -Hint "Vérifier le masque de cette étendue dans la console DHCP de $srvName." `
                    -Command "Get-DhcpServerv4Scope -ComputerName $srvName -ScopeId $scopeId"
                continue
            }
            $cidr = Register-Cidr -Ip $scopeId -Prefix $prefix
            if (-not $cidr) { continue }

            if ("$($Scope.State)" -and "$($Scope.State)" -notlike "*Active*") {
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'degraded' `
                    -Message "L'étendue $cidr ($scopeName) est inactive sur $srvName : elle ne distribue aucun bail." `
                    -Hint "Activer l'étendue depuis la console DHCP si elle doit servir, ou la supprimer si elle est obsolète." `
                    -Command "Get-DhcpServerv4Scope -ComputerName $srvName -ScopeId $scopeId"
            }

            # --- leases ---
            $leases = New-Object System.Collections.ArrayList
            try {
                foreach ($Lease in @(Get-DhcpServerv4Lease -ComputerName $srvName -ScopeId $Scope.ScopeId -ErrorAction Stop)) {
                    $expIso = $null; $detail = "Bail DHCP"
                    if ($Lease.LeaseExpiryTime) {
                        try {
                            $expIso = ([datetime]$Lease.LeaseExpiryTime).ToString("o")
                            $until = Format-Until ([datetime]$Lease.LeaseExpiryTime)
                            if ($until) { $detail = "Bail · expire $until" }
                        }
                        catch {}
                    }
                    [void]$leases.Add(@{
                            ip = "$($Lease.IPAddress.IPAddressToString)"; name = "$($Lease.HostName)"
                            mac = (ConvertTo-Mac $Lease.ClientId); expiresAt = $expIso; detail = $detail
                            active = ("$($Lease.AddressState)" -like "*Active*")
                            state = "$($Lease.AddressState)"
                        })
                }
            }
            catch {
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'degraded' `
                    -Message "Les baux de l'étendue $cidr n'ont pas pu être lus sur $srvName." `
                    -Hint "La lecture des baux demande davantage de droits que celle des étendues. Ajouter le compte du scan au groupe DHCP Users sur $srvName." `
                    -Command "Get-DhcpServerv4Lease -ComputerName $srvName -ScopeId $scopeId" -ErrorRecord $_
            }

            # --- reservations ---
            $resList = New-Object System.Collections.ArrayList
            try {
                foreach ($Res in @(Get-DhcpServerv4Reservation -ComputerName $srvName -ScopeId $Scope.ScopeId -ErrorAction Stop)) {
                    [void]$resList.Add(@{
                            ip = "$($Res.IPAddress.IPAddressToString)"; name = "$($Res.Name)"
                            mac = (ConvertTo-Mac $Res.ClientId)
                        })
                }
            }
            catch {
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'degraded' `
                    -Message "Les réservations de l'étendue $cidr n'ont pas pu être lues sur $srvName : leurs adresses apparaîtront comme de simples baux." `
                    -Hint "Mêmes droits que pour les baux : le compte du scan doit être membre de DHCP Users sur $srvName." `
                    -Command "Get-DhcpServerv4Reservation -ComputerName $srvName -ScopeId $scopeId" -ErrorRecord $_
            }

            # --- exclusions ---
            # Cosmetic: they refine the occupancy reading, they gate nothing. A scope
            # with none makes this cmdlet error on some builds, so it stays silent.
            $exclusions = 0
            $excludedAddresses = 0
            $exclusionRanges = New-Object System.Collections.ArrayList
            try {
                foreach ($x in @(Get-DhcpServerv4ExclusionRange -ComputerName $srvName -ScopeId $Scope.ScopeId -ErrorAction Stop)) {
                    if (-not $x) { continue }
                    [void]$exclusionRanges.Add([ordered]@{
                            start = "$($x.StartRange.IPAddressToString)"; end = "$($x.EndRange.IPAddressToString)"
                        })
                    $a = ConvertTo-IpNumber "$($x.StartRange.IPAddressToString)"
                    $b = ConvertTo-IpNumber "$($x.EndRange.IPAddressToString)"
                    if ($null -ne $a -and $null -ne $b -and $b -ge $a) {
                        $excludedAddresses += [int]([uint64]$b - [uint64]$a + 1)
                    }
                    $exclusions++
                }
            }
            catch {}

            # --- the server's own occupancy figure ---
            $util = $null
            try {
                $stats = Get-DhcpServerv4ScopeStatistics -ComputerName $srvName -ScopeId $Scope.ScopeId -ErrorAction Stop
                if ($stats -and $null -ne $stats.PercentageInUse) { $util = [int][math]::Round($stats.PercentageInUse) }
            }
            catch {
                Add-ScanDiagnostic -Log $Diag -Source $srvSource -Status 'degraded' `
                    -Message "Les statistiques de l'étendue $cidr sont indisponibles sur $srvName : le taux d'occupation est recalculé à partir des baux actifs." `
                    -Hint "Valeur approchée, sans conséquence sur l'inventaire des adresses." `
                    -Command "Get-DhcpServerv4ScopeStatistics -ComputerName $srvName -ScopeId $scopeId" -ErrorRecord $_
            }

            $rel = $RelByScope[$scopeId]
            $read = @{
                Server  = $srvKey; Fqdn = $srvName
                Mode    = if ($rel) { "$($rel.Mode)" } else { '' }
                Role    = if ($rel) { "$($rel.ServerRole)" } else { '' }
                State   = if ($rel) { "$($rel.State)" } else { '' }
                Partner = if ($rel) { "$($rel.PartnerServer)" } else { '' }
                Relationship = if ($rel) { "$($rel.Name)" } else { '' }
                ScopeId = $scopeId; Mask = $maskStr; Name = $scopeName; ScopeState = "$($Scope.State)"
                StartRange = "$($Scope.StartRange.IPAddressToString)"
                EndRange = "$($Scope.EndRange.IPAddressToString)"
                LeaseDays = $Scope.LeaseDuration.Days
                Leases = $leases; Reservations = $resList
                Exclusions = $exclusions; ExcludedAddresses = $excludedAddresses; Utilization = $util
            }
            if (-not $ScopeReads.ContainsKey($cidr)) { $ScopeReads[$cidr] = New-Object System.Collections.ArrayList }
            [void]$ScopeReads[$cidr].Add($read)

            # The same read, as this server holds it, for the DHCP view. Nothing
            # is merged here: a scope shared by two servers appears under each.
            $viewLeases = New-Object System.Collections.ArrayList
            foreach ($l in $leases) {
                [void]$viewLeases.Add([ordered]@{
                        ip = $l.ip; mac = $l.mac; hostName = $l.name; state = $l.state; expiresAt = $l.expiresAt
                    })
            }
            $viewReservations = New-Object System.Collections.ArrayList
            foreach ($x in $resList) {
                [void]$viewReservations.Add([ordered]@{ ip = $x.ip; mac = $x.mac; name = $x.name })
            }
            [void]$srvView.scopes.Add([ordered]@{
                    scopeId      = $scopeId
                    mask         = $maskStr
                    cidr         = $cidr
                    name         = $scopeName
                    state        = "$($Scope.State)"
                    rangeStart   = $read.StartRange
                    rangeEnd     = $read.EndRange
                    leaseSeconds = (ConvertTo-LeaseDuration $Scope.LeaseDuration)
                    utilization  = $util
                    exclusions   = $exclusionRanges
                    leases       = $viewLeases
                    reservations = $viewReservations
                    failover     = if ($rel) {
                        [ordered]@{
                            mode = "$($rel.Mode)"; role = "$($rel.ServerRole)"; state = "$($rel.State)"
                            partner = "$($rel.PartnerServer)"; relationship = "$($rel.Name)"
                        }
                    } else { $null }
                })
        }
    }

    # ───────────────────────── APPLY ─────────────────────────
    foreach ($cidr in @($ScopeReads.Keys)) {
        $reads = @($ScopeReads[$cidr])
        $decision = Resolve-DhcpScopeAuthority -Candidates $reads -UnreachableServers @($UnreachableDhcp)
        if (-not $decision) {
            # Never silent again: this branch is where every scope vanished for
            # as long as the helper above was not loaded.
            Add-ScanDiagnostic -Log $Diag -Source 'DHCP' -Status 'failed' `
                -Message "L'étendue $cidr a été lue mais n'a pas pu être rattachée à un serveur : elle est absente de la carte de son réseau." `
                -Hint "Défaut du scan, pas du serveur DHCP. Joindre ce rapport à un signalement."
            continue
        }

        # A failover read that failed only matters when the scope is shared, or
        # when its partner may be the server the scan could not reach at all.
        $relMissing = @($reads | Where-Object { -not $_.Mode -and $FailoverReadErrors.ContainsKey($_.Server) })
        if ($relMissing.Count -gt 0 -and ($reads.Count -gt 1 -or $UnreachableDhcp.Count -gt 0)) {
            $who = $relMissing[0]
            Add-ScanDiagnostic -Log $Diag -Source "DHCP - $($who.Server)" -Status 'degraded' `
                -Message "La relation de basculement de l'étendue $cidr n'a pas pu être lue sur $($who.Fqdn) : le serveur qui fait foi n'a pas pu être déterminé." `
                -Hint "Ajouter le compte du scan au groupe DHCP Users sur $($who.Fqdn) et vérifier Get-DhcpServerv4Failover." `
                -Command "Get-DhcpServerv4Failover -ComputerName $($who.Fqdn)" -ErrorRecord $FailoverReadErrors[$who.Server]
        }

        if ($decision.issue) {
            Add-ScanDiagnostic -Log $Diag -Source "DHCP - basculement $cidr" -Status $decision.issue.status `
                -Message $decision.issue.message -Hint $decision.issue.hint `
                -Command "Get-DhcpServerv4Failover -ComputerName $($decision.servers[0])"
        }

        # Leases and reservations come only from the servers the decision names.
        # For a failover pair both servers hold the same replicated database, so
        # this is about which copy is authoritative, not about losing addresses;
        # for load balance and split scope the reads are merged.
        $sources = @($reads | Where-Object { $_.Server -in @($decision.dataFrom) })
        if ($sources.Count -eq 0) { $sources = $reads }
        $head = $sources[0]

        $SubnetMeta[$cidr].mask = $head.Mask
        if ($head.Name) { $SubnetMeta[$cidr].label = $head.Name }
        $vlan = Get-VlanFromName $head.Name
        if ($null -ne $vlan) { $SubnetMeta[$cidr].vlan = $vlan }

        $leaseByIp = @{}
        foreach ($r in $sources) { foreach ($l in $r.Leases) { $leaseByIp[$l.ip] = $l } }
        $resByIpHere = @{}
        foreach ($r in $sources) { foreach ($x in $r.Reservations) { $resByIpHere[$x.ip] = $x } }

        $activeLeases = 0
        foreach ($l in $leaseByIp.Values) {
            Add-ToInventory -Ip $l.ip -Name $l.name -Type "Client (DHCP)" -Source "DHCP" -Mac $l.mac
            $DhcpByIp[$l.ip] = @{ kind = "lease"; detail = $l.detail; expiresAt = $l.expiresAt }
            if ($l.active) { $activeLeases++ }
        }
        foreach ($x in $resByIpHere.Values) {
            Add-ToInventory -Ip $x.ip -Name $x.name -Type "Réservation (DHCP)" -Source "DHCP (réservation)" -Mac $x.mac
            $ResByIp[$x.ip] = $true
            $DhcpByIp[$x.ip] = @{ kind = "reservation"; detail = "Réservation MAC"; expiresAt = $null }
        }

        # Distribution range, in full addresses: a range crossing a /24 boundary
        # (10.0.1.50 to 10.0.3.200) read as ".50 — .200" when only the last octet
        # was kept.
        $rangeSize = 0
        $startNum = ConvertTo-IpNumber $head.StartRange
        $endNum = ConvertTo-IpNumber $head.EndRange
        if ($null -ne $startNum -and $null -ne $endNum -and $endNum -ge $startNum) {
            $rangeSize = [int]([uint64]$endNum - [uint64]$startNum + 1)
        }

        # Occupancy: the authoritative server's own figure. For a shared scope
        # each server only counts its own share, so the merged active leases are
        # the honest number there.
        $util = $null
        if ($decision.mode -in @('standalone', 'hotstandby')) { $util = $head.Utilization }
        if ($null -eq $util) {
            $usable = $rangeSize - $head.ExcludedAddresses
            if ($usable -gt 0) { $util = [int][math]::Round(($activeLeases / $usable) * 100) } else { $util = 0 }
        }
        if ($util -lt 0) { $util = 0 }
        if ($util -gt 100) { $util = 100 }

        $SubnetMeta[$cidr].dhcp = @{
            server            = $decision.label
            serverFqdn        = (@($sources | ForEach-Object { $_.Fqdn }) -join ', ')
            scopeId           = $head.ScopeId
            scopeName         = $head.Name
            state             = $head.ScopeState
            rangeStart        = $head.StartRange
            rangeEnd          = $head.EndRange
            rangeSize         = $rangeSize
            utilization       = $util
            activeLeases      = $activeLeases
            leases            = $leaseByIp.Count
            reservations      = $resByIpHere.Count
            exclusions        = $head.Exclusions
            excludedAddresses = $head.ExcludedAddresses
            leaseDays         = $head.LeaseDays
            failover          = if ($decision.mode -eq 'standalone') { $null } else {
                @{
                    mode         = $decision.mode
                    authority    = $decision.authority
                    servers      = @($decision.servers)
                    state        = $decision.state
                    takeover     = [bool]$decision.takeover
                    relationship = "$($head.Relationship)"
                    reason       = $decision.reason
                }
            }
        }
    }

    if ($ScopeReads.Count -gt 0) {
        Add-ScanDiagnostic -Log $Diag -Source 'DHCP' -Status 'ok' `
            -Message "$($ScopeReads.Count) étendue(s) lue(s) sur $($DhcpServers.Count - $UnreachableDhcp.Count) serveur(s) DHCP joignable(s) sur $($DhcpServers.Count)."
    }
}

# =============================================
# SOURCE 6: DNS Records (A + PTR)
# =============================================
Write-Host "PROGRESS:45"
$DomainDnsRoot = if ($Pdc -match '\.') { $Pdc.Substring($Pdc.IndexOf('.') + 1) } else { "" }
if (-not (Install-RSATModule "DnsServer")) {
    Add-ScanDiagnostic -Log $Diag -Source 'DNS' -Status 'failed' `
        -Message "Le module PowerShell DnsServer est absent de cette machine et n'a pas pu être installé : aucun enregistrement A, PTR ou CNAME ne sera lu." `
        -Hint "Installer les outils d'administration DNS. Sur un serveur : Install-WindowsFeature RSAT-DNS-Server. Sur un poste de travail : Add-WindowsCapability -Online -Name Rsat.Dns.Tools~~~~0.0.1.0. Puis relancer le scan." `
        -Command 'Get-Module -ListAvailable -Name DnsServer'
}
else {
    Write-Host "Extracting DNS Records..."
    $DnsZones = @()
    try {
        $DnsZones = @(Get-DnsServerZone -ComputerName $Pdc -ErrorAction Stop)
    }
    catch {
        Add-ScanDiagnostic -Log $Diag -Source 'DNS' -Status 'failed' `
            -Message "Les zones DNS de $Pdc n'ont pas pu être listées : les noms d'hôte et les anomalies A sans PTR seront absents." `
            -Hint "Vérifier que le service DNS tourne sur $Pdc, qu'il est joignable depuis cette machine, et que le compte du scan peut lire les zones (groupe DNSAdmins ou lecture déléguée)." `
            -Command "Get-DnsServerZone -ComputerName $Pdc" -ErrorRecord $_
    }

    $ZoneFailures = 0
    foreach ($Zone in $DnsZones) {
        try {
            if ($Zone.IsReverseLookupZone) {
                $Records = @(Get-DnsServerResourceRecord -ZoneName $Zone.ZoneName -ComputerName $Pdc -ErrorAction Stop | Where-Object { $_.RecordType -eq "PTR" })
                foreach ($Rec in $Records) {
                    $IpPart = $Rec.HostName
                    if ($Rec.RecordData.PtrDomainName -and $IpPart -match "^(\d+)$") {
                        if ($Zone.ZoneName -match "(\d+)\.(\d+)\.(\d+)\.in-addr\.arpa") {
                            $Ip = "$($Matches[3]).$($Matches[2]).$($Matches[1]).$IpPart"
                            $zoneNet = "$($Matches[3]).$($Matches[2]).$($Matches[1]).0"
                            $ptrName = "$($Rec.RecordData.PtrDomainName)".TrimEnd('.')
                            Add-ToInventory -Ip $Ip -Name $ptrName -Type "Serveur / Fixe" -Source "DNS (PTR)"
                            $HasPtr[$Ip] = $true
                            if (-not $DnsByIp.ContainsKey($Ip)) { $DnsByIp[$Ip] = New-Object System.Collections.ArrayList }
                            [void]$DnsByIp[$Ip].Add(@{ type = "PTR"; value = "$Ip → $ptrName"; ttl = (Format-Span $Rec.TimeToLive) })

                            # A reverse zone is always a /24, but the addresses behind it
                            # may already belong to a wider declared etendue. Attach the
                            # zone meta to that prefix rather than carving a /24 out of it.
                            $cidr = Resolve-CidrForIp -Ip $zoneNet -Index (Get-ScanCidrIndex)
                            if (-not $SubnetMeta.ContainsKey($cidr)) { $cidr = Register-Cidr -Ip $zoneNet -Prefix 24 }
                            if ($cidr -and -not $SubnetMeta[$cidr].dns) {
                                $SubnetMeta[$cidr].dns = @{ zone = $DomainDnsRoot; reverseZone = $Zone.ZoneName; recordCount = 0 }
                            }
                        }
                    }
                }
            }
            else {
                $Records = @(Get-DnsServerResourceRecord -ZoneName $Zone.ZoneName -ComputerName $Pdc -ErrorAction Stop | Where-Object { $_.RecordType -eq "A" -or $_.RecordType -eq "CNAME" })
                foreach ($Rec in $Records) {
                    if ($Rec.RecordType -eq "A") {
                        $Ip = $Rec.RecordData.IPv4Address.IPAddressToString
                        $Name = if ($Rec.HostName -eq "@") { $Zone.ZoneName } else { "$($Rec.HostName).$($Zone.ZoneName)" }
                        Add-ToInventory -Ip $Ip -Name $Name -Type "Serveur / Fixe" -Source "DNS (A)"
                        $HasA[$Ip] = $true
                        $IpByName[$Name.ToLower()] = $Ip
                        if (-not $DnsByIp.ContainsKey($Ip)) { $DnsByIp[$Ip] = New-Object System.Collections.ArrayList }
                        [void]$DnsByIp[$Ip].Add(@{ type = "A"; value = "$Name → $Ip"; ttl = (Format-Span $Rec.TimeToLive) })
                    }
                    else {
                        # CNAME: resolved to an IP in a second pass, once every A is known.
                        $alias = if ($Rec.HostName -eq "@") { $Zone.ZoneName } else { "$($Rec.HostName).$($Zone.ZoneName)" }
                        $target = "$($Rec.RecordData.HostNameAlias)".TrimEnd('.')
                        [void]$PendingCnames.Add(@{ alias = $alias; target = $target; ttl = (Format-Span $Rec.TimeToLive) })
                    }
                }
            }
        }
        catch {
            $ZoneFailures++
            Add-ScanDiagnostic -Log $Diag -Source 'DNS' -Status 'degraded' `
                -Message "Les enregistrements de la zone $($Zone.ZoneName) n'ont pas pu être lus." `
                -Hint "Zone peut-être déléguée, en cours de transfert, ou hors de portée du compte du scan. Les autres zones ont été traitées normalement." `
                -Command "Get-DnsServerResourceRecord -ZoneName $($Zone.ZoneName) -ComputerName $Pdc" -ErrorRecord $_
        }
    }

    if ($DnsZones.Count -gt 0 -and $ZoneFailures -eq 0) {
        Add-ScanDiagnostic -Log $Diag -Source 'DNS' -Status 'ok' -Message "$($DnsZones.Count) zone(s) DNS lue(s) sur $Pdc."
    }
}

# =============================================
# Probe: stop here
# =============================================
# Every read that needs the scan account has run: directory, DHCP, DNS. What
# follows is the ping sweep and the assembly of the inventory, which only the
# local machine takes part in, so the probe answers now with what it learned.
if ($ProbeOnly) {
    $probe = [ordered]@{
        account     = $ScanAccount
        diagnostics = @($Diag)
        context     = [ordered]@{
            scannedAt    = $ScanTime
            computerName = "$env:COMPUTERNAME"
            userName     = $ScanAccount
            elevated     = $IsElevated
            domain       = if ($Domain) { "$Domain" } else { "" }
            pdc          = "$Pdc"
            dhcpScopes   = $ScopeReads.Count
        }
    }
    $probe | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

# =============================================
# SOURCE 7: Ping sweep across every declared subnet
# =============================================
# Last of the discovery sources, and deliberately so: it sweeps what the local
# interfaces, the DHCP etendues and the reverse DNS zones have declared. Running
# it earlier — as it did — meant a DHCP scope discovered afterwards was never
# swept at all, and a scope wider than a /24 only ever saw its first 254 hosts.
Write-Host "PROGRESS:60"
$SweepIps = New-Object System.Collections.ArrayList
$SweptCidrs = New-Object System.Collections.ArrayList
$SkippedWide = New-Object System.Collections.ArrayList
foreach ($cidr in @($SubnetMeta.Keys)) {
    $hostList = Get-CidrHostList -Cidr $cidr -MaxHosts $SweepMaxHosts
    if ($null -eq $hostList) { [void]$SkippedWide.Add($cidr); continue }
    [void]$SweptCidrs.Add($cidr)
    foreach ($h in $hostList) { [void]$SweepIps.Add($h) }
}

if ($SkippedWide.Count -gt 0) {
    Add-ScanDiagnostic -Log $Diag -Source 'Balayage ping' -Status 'degraded' `
        -Message "$($SkippedWide.Count) étendue(s) dépassent $SweepMaxHosts adresses et ne sont pas balayées adresse par adresse : $($SkippedWide -join ', '). Elles restent inventoriées par leurs baux DHCP, leurs réservations et leurs enregistrements DNS." `
        -Hint "Un balayage complet d'un /16 dépasse 65000 requêtes et n'aboutirait pas dans le temps d'un scan. Découper ces étendues en préfixes plus courts côté DHCP si un balayage exhaustif est nécessaire."
}

if ($SweepIps.Count -eq 0) {
    Add-ScanDiagnostic -Log $Diag -Source 'Balayage ping' -Status 'degraded' `
        -Message "Aucun sous-réseau exploitable n'a été déclaré : le balayage ping n'a rien à parcourir." `
        -Hint "Conséquence d'un échec plus haut dans ce rapport, côté interfaces locales ou côté DHCP. Corriger celui-là d'abord."
}
elseif ($EngineReady) {
    Write-Host "C# Engine: Parallel ping sweep over $($SweepIps.Count) address(es) in $($SweptCidrs.Count) subnet(s)..."
    try {
        $alive = [NetworkScanner]::PingSweepIps(@($SweepIps), 800)
        Write-Host "  Found $($alive.Count) alive hosts across all subnets."
        foreach ($aliveHost in $alive) {
            $PingByIp[$aliveHost.IP] = [int64]$aliveHost.RoundtripMs
            Add-ToInventory -Ip $aliveHost.IP -Name "-" -Type "Equipement (Online)" -Source "Ping (C#)"
        }
    }
    catch {
        Add-ScanDiagnostic -Log $Diag -Source 'Balayage ping' -Status 'failed' `
            -Message "Le balayage ping a échoué : seules les adresses connues du DHCP, du DNS ou de la table ARP figurent à l'inventaire." `
            -Hint "Vérifier qu'aucune stratégie de pare-feu local ne bloque l'ICMP sortant depuis cette machine." `
            -Command '[NetworkScanner]::PingSweepIps(...)' -ErrorRecord $_
    }
}
else {
    # PowerShell fallback, in chunks: one job per address does not scale past a
    # few hundred, so the sweep is capped and the report says where it stopped.
    $fallbackCap = 1024
    $targets = @($SweepIps)
    if ($targets.Count -gt $fallbackCap) {
        Add-ScanDiagnostic -Log $Diag -Source 'Balayage ping' -Status 'degraded' `
            -Message "Sans le moteur C#, le balayage est limité aux $fallbackCap premières adresses sur $($targets.Count) déclarées." `
            -Hint "Corriger l'échec du moteur C# signalé plus haut dans ce rapport pour retrouver un balayage complet."
        $targets = $targets[0..($fallbackCap - 1)]
    }
    Write-Host "PS Fallback: ping sweep over $($targets.Count) address(es)..."
    $chunkSize = 128
    for ($offset = 0; $offset -lt $targets.Count; $offset += $chunkSize) {
        $end = [math]::Min($offset + $chunkSize, $targets.Count) - 1
        $PingJobs = @()
        foreach ($testIp in $targets[$offset..$end]) {
            $PingJobs += [PSCustomObject]@{
                IP  = $testIp
                Job = (Test-Connection -ComputerName $testIp -Count 1 -Quiet -AsJob -ErrorAction SilentlyContinue)
            }
        }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline) {
            $pending = @($PingJobs | Where-Object { $_.Job -and $_.Job.State -eq "Running" })
            if ($pending.Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
        foreach ($pj in $PingJobs) {
            if (-not $pj.Job) { continue }
            try {
                $result = Receive-Job -Job $pj.Job -ErrorAction SilentlyContinue
                if ($result -eq $true) {
                    $PingByIp[$pj.IP] = -1   # alive, RTT unknown in fallback mode
                    Add-ToInventory -Ip $pj.IP -Name "-" -Type "Equipement (Online)" -Source "Ping"
                }
                Remove-Job -Job $pj.Job -Force -ErrorAction SilentlyContinue
            }
            catch { Remove-Job -Job $pj.Job -Force -ErrorAction SilentlyContinue }
        }
    }
}

# =============================================
# ENRICHMENT: Batch Reverse DNS (C# or PS fallback)
# =============================================
Write-Host "PROGRESS:75"
$unknownIps = @($IpInventory.Keys | Where-Object { $IpInventory[$_].Name -eq "-" -and $IpInventory[$_].Status -eq "taken" })
$resolvedCount = 0

if ($EngineReady -and $unknownIps.Count -gt 0) {
    Write-Host "C# Engine: Batch reverse DNS for $($unknownIps.Count) IPs..."
    try {
        $dnsResults = [NetworkScanner]::BatchReverseDns($unknownIps)
        foreach ($dr in $dnsResults) {
            $IpInventory[$dr.IP].Name = $dr.Hostname
            $IpInventory[$dr.IP].Source += ", rDNS (C#)"
            $resolvedCount++
        }
    }
    catch {
        Add-ScanDiagnostic -Log $Diag -Source 'Resolution inverse' -Status 'degraded' `
            -Message "La résolution inverse par lot a échoué : des adresses actives resteront sans nom d'hôte." `
            -Hint "Vérifier que le résolveur DNS configuré sur cette machine répond aux requêtes PTR." `
            -Command '[NetworkScanner]::BatchReverseDns(...)' -ErrorRecord $_
    }
}
else {
    Write-Host "Resolving hostnames (PowerShell fallback)..."
    foreach ($ip in $unknownIps) {
        try {
            $resolved = [System.Net.Dns]::GetHostEntry($ip)
            if ($resolved.HostName -and $resolved.HostName -ne $ip) {
                $IpInventory[$ip].Name = $resolved.HostName
                $IpInventory[$ip].Source += ", rDNS"
                $resolvedCount++
            }
        }
        catch {}
    }
}
Write-Host "Resolved $resolvedCount additional hostnames via rDNS."

# NetBIOS fallback for remaining unknowns
Write-Host "PROGRESS:82"
$stillUnknown = @($IpInventory.Keys | Where-Object { $IpInventory[$_].Name -eq "-" -and $IpInventory[$_].Status -eq "taken" })
if ($stillUnknown.Count -gt 0) {
    if ($EngineReady) {
        Write-Host "C# Engine: Parallel NetBIOS resolution for $($stillUnknown.Count) IPs..."
        try {
            $nbtResults = [NetworkScanner]::BatchNetBiosLookup($stillUnknown)
            foreach ($nr in $nbtResults) {
                $IpInventory[$nr.IP].Name = $nr.Name
                $IpInventory[$nr.IP].Source += ", NetBIOS (C#)"
            }
            Write-Host "Resolved $($nbtResults.Count) additional hostnames via NetBIOS (C#)."
        }
        catch {
            Add-ScanDiagnostic -Log $Diag -Source 'Resolution NetBIOS' -Status 'degraded' `
                -Message "La résolution NetBIOS a échoué : les équipements sans enregistrement DNS resteront anonymes." `
                -Hint "NetBIOS circule en UDP 137 et est souvent filtré. Sans conséquence sur le reste de l'inventaire." `
                -Command '[NetworkScanner]::BatchNetBiosLookup(...)' -ErrorRecord $_
        }
    }
    else {
        Write-Host "NetBIOS resolution for $($stillUnknown.Count) remaining IPs (Fallback)..."
        $nbtResolved = 0
        foreach ($ip in $stillUnknown) {
            try {
                $nbt = nbtstat -A $ip 2>$null
                if ($nbt) {
                    $match = $nbt | Select-String "<00>\s+UNIQUE" | Select-Object -First 1
                    if ($match) {
                        $nbName = ($match.Line -split "\s+")[1]
                        if ($nbName -and $nbName.Length -gt 0) {
                            $IpInventory[$ip].Name = $nbName
                            $IpInventory[$ip].Source += ", NetBIOS"
                            $nbtResolved++
                        }
                    }
                }
            }
            catch {}
        }
        Write-Host "Resolved $nbtResolved additional hostnames via NetBIOS."
    }
}

# =============================================
# Categorize
# =============================================
Write-Host "PROGRESS:90"
foreach ($Ip in @($IpInventory.Keys)) {
    $Entry = $IpInventory[$Ip]
    if ($Ip -match "\.1$|\.254$") { $Entry.Type = "Passerelle" }
}

# =============================================
# Enumerate free IPs in discovered subnets
# =============================================
# Same set the sweep used, so "free" means "declared, swept, and nothing answered"
# rather than "inside some /24 we guessed at". An etendue past the sweep ceiling
# lists no free address — claiming 65000 of them would be a lie, not an inventory.
Write-Host "PROGRESS:95"
Write-Host "Enumerating free IPs across $($SweptCidrs.Count) subnet(s)..."
foreach ($cidr in @($SweptCidrs)) {
    $hostList = Get-CidrHostList -Cidr $cidr -MaxHosts $SweepMaxHosts
    if ($null -eq $hostList) { continue }
    foreach ($testIp in $hostList) {
        if (-not $IpInventory.ContainsKey($testIp)) {
            $IpInventory[$testIp] = [PSCustomObject]@{
                IP = $testIp; Name = "-"; Type = "-"; Source = "Subnet Enum"; Status = "free"; Mac = "-"
            }
        }
    }
}

# =============================================
# Resolve CNAME targets to IPs (needs the full A-record map)
# =============================================
foreach ($cn in $PendingCnames) {
    $t = $cn.target.ToLower()
    if ($IpByName.ContainsKey($t)) {
        $ip = $IpByName[$t]
        if (-not $DnsByIp.ContainsKey($ip)) { $DnsByIp[$ip] = New-Object System.Collections.ArrayList }
        [void]$DnsByIp[$ip].Add(@{ type = "CNAME"; value = "$($cn.alias) → $($cn.target)"; ttl = $cn.ttl })
    }
}

# =============================================
# Build enriched { ips, subnets } output
# =============================================
Write-Host "PROGRESS:97"
function Get-NetworkPriority {
    param([string]$Ip)
    $octets = $Ip.Split('.')
    $first = [int]$octets[0]
    if ($first -eq 10) { return 1 }
    if ($first -eq 192 -and [int]$octets[1] -eq 168) { return 2 }
    if ($first -eq 172 -and [int]$octets[1] -ge 16 -and [int]$octets[1] -le 31) { return 3 }
    return 4
}
function Get-IpNum {
    param([string]$Ip)
    $o = $Ip.Split('.')
    return ([int64]$o[0] * 16777216) + ([int64]$o[1] * 65536) + ([int64]$o[2] * 256) + [int64]$o[3]
}

$IpsOut = New-Object System.Collections.ArrayList
foreach ($Ip in $IpInventory.Keys) {
    $e = $IpInventory[$Ip]
    # Longest declared prefix containing the address, /24 only as a last resort.
    # This is what keeps a /22 etendue and its 1022 addresses in the same row.
    $cidr = Resolve-CidrForIp -Ip $Ip -Index (Get-ScanCidrIndex)

    $macSet = @()
    if ($MacsByIp.ContainsKey($Ip)) { $macSet = @($MacsByIp[$Ip]) }
    if ($macSet.Count -eq 0 -and $e.Mac -and $e.Mac -ne "-") { $macSet = @($e.Mac) }
    $macCount = $macSet.Count
    $macPrimary = if ($macSet.Count -gt 0) { "$($macSet[0])" } elseif ($e.Mac -ne "-") { "$($e.Mac)" } else { "" }

    $records = @()
    if ($DnsByIp.ContainsKey($Ip)) { $records = @($DnsByIp[$Ip]) }
    $badges = @($records | ForEach-Object { $_.type } | Select-Object -Unique)

    $anom = @()
    $aHere = $HasA.ContainsKey($Ip)
    $ptrHere = $HasPtr.ContainsKey($Ip)
    if ($aHere -and -not $ptrHere) { $anom += "a_without_ptr" }
    if ($ptrHere -and -not $aHere -and ($e.Name -eq "-" -or [string]::IsNullOrWhiteSpace($e.Name))) { $anom += "orphan_ptr" }
    if ($macCount -gt 1) { $anom += "conflict" }

    $status = "$($e.Status)"
    if ($status -ne "free") {
        if ($macCount -gt 1) { $status = "conflict" }
        elseif ($ResByIp.ContainsKey($Ip)) { $status = "reserved" }
    }

    $dhcp = if ($DhcpByIp.ContainsKey($Ip)) { $DhcpByIp[$Ip] } else { @{ kind = "none"; detail = ""; expiresAt = $null } }

    $ev = [ordered]@{
        pingAlive    = $PingByIp.ContainsKey($Ip)
        rttMs        = if ($PingByIp.ContainsKey($Ip)) { $PingByIp[$Ip] } else { $null }
        hasArp       = $ArpByIp.ContainsKey($Ip)
        arpStale     = if ($ArpByIp.ContainsKey($Ip)) { [bool]$ArpByIp[$Ip].stale } else { $false }
        hasDnsA      = $HasA.ContainsKey($Ip)
        hasDnsPtr    = $HasPtr.ContainsKey($Ip)
        hasDhcpLease = ($DhcpByIp.ContainsKey($Ip) -and "$($DhcpByIp[$Ip].kind)" -ne "none")
    }

    [void]$IpsOut.Add([ordered]@{
        ip         = $Ip
        network    = $cidr
        status     = $status
        hostname   = if ($e.Name -eq "-") { "" } else { "$($e.Name)" }
        mac        = $macPrimary
        macCount   = $macCount
        dns        = $badges
        dnsRecords = $records
        dhcp       = $dhcp
        anomalies  = $anom
        evidence   = $ev
        lastSeen   = if ($status -eq "free") { $null } else { $ScanTime }
        source     = "$($e.Source)"
        type       = "$($e.Type)"
    })
}

$IpsOut = @($IpsOut | Sort-Object @{ Expression = { Get-NetworkPriority $_.ip } }, @{ Expression = { Get-IpNum $_.ip } })

# fill per-subnet DNS record counts (A records within the subnet)
foreach ($cidr in @($SubnetMeta.Keys)) {
    if ($SubnetMeta[$cidr].dns) {
        $cnt = @($IpsOut | Where-Object { $_.network -eq $cidr -and ($_.dns -contains 'A') }).Count
        $SubnetMeta[$cidr].dns.recordCount = $cnt
    }
}

$SubnetsOut = @($SubnetMeta.Values)
$activeCount = @($IpsOut | Where-Object { $_.status -ne "free" }).Count
$freeCount = @($IpsOut | Where-Object { $_.status -eq "free" }).Count
$engineLabel = if ($EngineReady) { "C# Engine" } else { "PowerShell" }
Write-Host "=== Scan Complete ($engineLabel): $activeCount active, $freeCount free · $($SubnetsOut.Count) subnet meta ==="

# A scan that reached no source at all is a failure, not an empty network. Saying
# so here is what turns a silent blank page into a report someone can act on.
if ($SubnetsOut.Count -eq 0) {
    Add-ScanDiagnostic -Log $Diag -Source 'Scan' -Status 'failed' `
        -Message "Aucun sous-réseau n'a pu être déterminé : l'inventaire est vide." `
        -Hint "Les échecs listés plus haut dans ce rapport en donnent la cause. Sans interface locale exploitable ni serveur DHCP joignable, le scan n'a aucun point de départ."
}

# Everything the person receiving this report needs in order to place it: which
# machine ran the scan, with which rights, against which domain.
$Context = [ordered]@{
    scannedAt    = $ScanTime
    computerName = "$env:COMPUTERNAME"
    userName     = $ScanAccount
    elevated     = $IsElevated
    psVersion    = "$($PSVersionTable.PSVersion)"
    osVersion    = "$([System.Environment]::OSVersion.VersionString)"
    domain       = if ($Domain) { "$Domain" } else { "" }
    pdc          = "$Pdc"
    engine       = $engineLabel
    sweptSubnets = $SweptCidrs.Count
    sweptHosts   = $SweepIps.Count
    dhcpScopes   = $ScopeReads.Count
    subnets      = $SubnetsOut.Count
    activeIps    = $activeCount
    freeIps      = $freeCount
}

# Output the subnet-explorer contract. The backend tolerates PS single-element-array
# unwrapping (see inventoryService toArr()), so this stays robust on Windows PowerShell 5.1.
$result = [ordered]@{
    ips         = @($IpsOut)
    subnets     = $SubnetsOut
    scannedAt   = $ScanTime
    diagnostics = @($Diag)
    context     = $Context
    dhcp        = [ordered]@{ servers = @($DhcpView) }
}
# Depth 10: dhcp.servers[].scopes[].leases[] sits seven levels down, and a value
# cut off by the depth limit is serialized as its type name, not as an error.
$result | ConvertTo-Json -Depth 10 -Compress
