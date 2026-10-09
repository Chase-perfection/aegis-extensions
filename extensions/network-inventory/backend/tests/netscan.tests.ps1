. "$PSScriptRoot/../scan/netscan/Cidr.ps1"
. "$PSScriptRoot/../scan/netscan/ScanDiagnostics.ps1"
. "$PSScriptRoot/../scan/netscan/DhcpFailover.ps1"

# Helpers of shield/network_scan.ps1. The scan itself cannot run here (it wants a
# domain, DHCP servers and a LAN to sweep), so what is covered is everything it
# decides: CIDR filing, the diagnostic log, which DHCP server speaks for a
# shared scope, and the one thing the scan must get right on the way out, its
# output encoding.
#
# The runner is pwsh 7.4, but the scan runs under Windows PowerShell 5.1 (the
# backend launches powershell.exe). Two bugs in this code existed only in 5.1,
# so the last cases below re-run the relevant pieces in powershell.exe itself.

# ── CIDR arithmetic ─────────────────────────────────────────────────────────

Test-Case 'ip numbers round-trip, and a malformed address is refused' {
    Assert-Equal '10.0.1.37' (ConvertFrom-IpNumber (ConvertTo-IpNumber '10.0.1.37'))
    Assert-Equal '255.255.255.255' (ConvertFrom-IpNumber (ConvertTo-IpNumber '255.255.255.255'))
    Assert-Equal $null (ConvertTo-IpNumber '10.0.1')
    Assert-Equal $null (ConvertTo-IpNumber '10.0.1.300')
    Assert-Equal $null (ConvertTo-IpNumber 'a.b.c.d')
}

Test-Case 'masks and prefix lengths convert both ways' {
    Assert-Equal 22 (ConvertTo-PrefixLength '255.255.252.0')
    Assert-Equal 25 (ConvertTo-PrefixLength '255.255.255.128')
    Assert-Equal '255.255.252.0' (ConvertTo-SubnetMask 22)
    Assert-Equal '255.255.255.252' (ConvertTo-SubnetMask 30)
    Assert-Equal '0.0.0.0' (ConvertTo-SubnetMask 0)
}

Test-Case 'network address and usable host count follow the real prefix' {
    Assert-Equal '10.0.0.0' (Get-NetworkAddress -Ip '10.0.1.37' -PrefixLength 22)
    Assert-Equal '10.0.4.0' (Get-NetworkAddress -Ip '10.0.5.9' -PrefixLength 22)
    Assert-Equal 254 (Get-UsableHostCount 24)
    Assert-Equal 1022 (Get-UsableHostCount 22)
    Assert-Equal 0 (Get-UsableHostCount 31)
}

Test-Case 'a /22 enumerates 1022 hosts, and a /16 past the ceiling enumerates none' {
    $h = Get-CidrHostList -Cidr '10.0.0.0/22' -MaxHosts 1022
    Assert-Equal 1022 $h.Count
    Assert-Equal '10.0.0.1' $h[0]
    Assert-Equal '10.0.3.254' $h[$h.Count - 1]
    # $null, not a truncated list: a short list would claim to be the whole subnet.
    Assert-Equal $null (Get-CidrHostList -Cidr '10.0.0.0/16' -MaxHosts 1022)
}

Test-Case 'a single-subnet index still comes back as a list' {
    # PowerShell unrolls a one-element collection on return; the comma in
    # New-CidrIndex is what stops it. Without it this is a bare row.
    $idx = New-CidrIndex -Cidr @('10.0.0.0/22')
    Assert-True ($idx -is [array]) 'the index must be an array'
    Assert-Equal 1 $idx.Count
}

Test-Case 'an address is filed into the longest declared prefix containing it' {
    $idx = New-CidrIndex -Cidr @('10.0.0.0/22', '10.0.2.0/25', '192.168.1.0/24')
    Assert-Equal '10.0.0.0/22'    (Resolve-CidrForIp -Ip '10.0.0.5' -Index $idx)
    Assert-Equal '10.0.0.0/22'    (Resolve-CidrForIp -Ip '10.0.3.254' -Index $idx)
    Assert-Equal '10.0.2.0/25'    (Resolve-CidrForIp -Ip '10.0.2.10' -Index $idx) 'the narrower prefix wins'
    Assert-Equal '10.0.0.0/22'    (Resolve-CidrForIp -Ip '10.0.2.200' -Index $idx) 'past the /25, back to the /22'
    Assert-Equal '10.0.4.0/24'    (Resolve-CidrForIp -Ip '10.0.4.1' -Index $idx) 'undeclared falls back to /24'
    Assert-Equal '192.168.1.0/24' (Resolve-CidrForIp -Ip '192.168.1.7' -Index $idx)
}

# ── Diagnostic log ──────────────────────────────────────────────────────────

Test-Case 'a new log is a real, empty list and not $null' {
    # The bug this pins: an empty ArrayList returned without the comma unrolled
    # to $null, and every Add-ScanDiagnostic after it failed parameter binding.
    $log = New-ScanDiagnosticLog
    Assert-True ($null -ne $log) 'New-ScanDiagnosticLog returned $null'
    Assert-Equal 0 $log.Count
}

Test-Case 'a multi-line error lands on one line, with its command and error id' {
    $log = New-ScanDiagnosticLog
    try { throw "ligne un`r`nligne deux`nligne trois" } catch {
        Add-ScanDiagnostic -Log $log -Source 'DHCP - srv01' -Status 'failed' `
            -Message "Le serveur n'a pas répondu.`r`nSuite." -Hint 'Vérifier le pare-feu.' `
            -Command 'Get-DhcpServerv4Scope -ComputerName srv01' -ErrorRecord $_ 6>$null
    }
    Assert-Equal 1 $log.Count
    $d = $log[0]
    Assert-Equal 'failed' $d.status
    Assert-Equal 'Get-DhcpServerv4Scope -ComputerName srv01' $d.command
    Assert-True (-not $d.message.Contains("`n")) 'message must be single-line'
    Assert-True (-not $d.detail.Contains("`n")) 'detail must be single-line'
    Assert-True ($d.detail.Contains('ligne un')) 'the raw error must survive'
    $json = [ordered]@{ diagnostics = @($log) } | ConvertTo-Json -Depth 5 -Compress
    Assert-Equal 1 @($json -split "`n").Count 'the backend parses the last line starting with {'
}

Test-Case 'a refusal is told apart from a silence, by code and not by message' {
    # WIN32 5 is ERROR_ACCESS_DENIED. The real case: three DHCP servers all
    # answered and all refused, and the scan reported "n'a pas repondu" on each,
    # which points the operator at a firewall that was never the problem.
    $denied = [System.Management.Automation.ErrorRecord]::new(
        [System.Exception]::new("Echec de l'enumeration des etendues sur le serveur DHCP srv01."),
        'WIN32 5,Get-DhcpServerv4Scope', 'PermissionDenied', $null)
    Assert-True (Test-DhcpAccessDenied $denied) 'WIN32 5 must read as a refusal'

    # Same category, no id: some builds report it only one of the two ways.
    $byCategory = [System.Management.Automation.ErrorRecord]::new(
        [System.Exception]::new('refuse'), 'Whatever', 'PermissionDenied', $null)
    Assert-True (Test-DhcpAccessDenied $byCategory) 'the category alone must be enough'

    # A silence stays a silence, and so does a WIN32 code that is not 5.
    $silent = [System.Management.Automation.ErrorRecord]::new(
        [System.Exception]::new('serveur injoignable'), 'WIN32 1722,Get-DhcpServerv4Scope',
        'ConnectionError', $null)
    Assert-True (-not (Test-DhcpAccessDenied $silent)) 'an unreachable server is not a refusal'
    Assert-True (-not (Test-DhcpAccessDenied $null)) 'no error record is not a refusal'
}

Test-Case 'a stale authorization is told apart from a refusal, by where the name points' {
    # The real case: the directory still authorized a DHCP server whose machine
    # was gone. The name kept an A record pointing at ANOTHER server, the call
    # landed there, and that server refused it with the same WIN32 5 as a real
    # rights problem. The report then asked for an account to be granted on a
    # host that no longer existed.
    Assert-True (Test-DhcpAuthorizationStale -DeclaredIp '192.168.1.3' -ResolvedIps @('192.168.1.97')) `
        'a name resolving elsewhere is a stale authorization'
    Assert-True (Test-DhcpAuthorizationStale -DeclaredIp '192.168.1.3' -ResolvedIps @()) `
        'a name resolving to nothing is a stale authorization'

    # A server that is really there, refusing for a real reason, must not be
    # explained away as decommissioned.
    Assert-True (-not (Test-DhcpAuthorizationStale -DeclaredIp '192.168.1.97' -ResolvedIps @('192.168.1.97'))) `
        'a name pointing where the directory says is not stale'
    Assert-True (-not (Test-DhcpAuthorizationStale -DeclaredIp '10.0.0.5' -ResolvedIps @('10.0.0.9', '10.0.0.5'))) `
        'one matching address among several is enough'

    # Nothing recorded to compare against: say nothing, let the RPC error speak.
    Assert-True (-not (Test-DhcpAuthorizationStale -DeclaredIp '' -ResolvedIps @())) `
        'no declared address cannot prove anything'
}

# ── DHCP failover authority ─────────────────────────────────────────────────

function New-Read {
    param([string]$Server, [string]$Mode = '', [string]$Role = '', [string]$State = '', [string]$Partner = '')
    return [PSCustomObject]@{ Server = $Server; Mode = $Mode; Role = $Role; State = $State; Partner = $Partner }
}

Test-Case 'a single server with no relationship is simply the authority' {
    $r = Resolve-DhcpScopeAuthority -Candidates @(New-Read 'dhcp1')
    Assert-Equal 'standalone' $r.mode
    Assert-Equal 'dhcp1' $r.label
    Assert-Equal $null $r.issue
}

Test-Case 'hot standby, both up: the primary speaks, whatever order they were read in' {
    $primary = New-Read 'dhcp1' 'HotStandby' 'Active' 'Normal' 'dhcp2.corp.local'
    $standby = New-Read 'dhcp2' 'HotStandby' 'Standby' 'Normal' 'dhcp1.corp.local'
    foreach ($order in @(@($primary, $standby), @($standby, $primary))) {
        $r = Resolve-DhcpScopeAuthority -Candidates $order
        Assert-Equal 'hotstandby' $r.mode
        Assert-Equal 'dhcp1' $r.authority
        Assert-Equal 'dhcp1' $r.label
        Assert-Equal @('dhcp1') $r.dataFrom
        Assert-Equal $false $r.takeover
        Assert-Equal $null $r.issue
    }
}

Test-Case 'hot standby, primary off and failover engaged: the standby speaks' {
    foreach ($state in @('PartnerDown', 'CommunicationInterrupted')) {
        $standby = New-Read 'dhcp2' 'HotStandby' 'Standby' $state 'dhcp1.corp.local'
        $r = Resolve-DhcpScopeAuthority -Candidates @($standby) -UnreachableServers @('dhcp1.corp.local')
        Assert-Equal 'dhcp2' $r.authority "state $state"
        Assert-Equal 'dhcp2' $r.label
        Assert-Equal $true $r.takeover
        Assert-Equal 'failed' $r.issue.status 'a primary DHCP down is an incident'
        Assert-True ($r.issue.message -like '*dhcp1*') 'the report names the dead primary'
    }
}

Test-Case 'hot standby, primary off but no failover engaged: the primary still speaks' {
    # The scan cannot reach the primary, but the standby sees it fine: the fault
    # is the path from the scan host, not the DHCP service. No takeover.
    $standby = New-Read 'dhcp2' 'HotStandby' 'Standby' 'Normal' 'dhcp1'
    $r = Resolve-DhcpScopeAuthority -Candidates @($standby) -UnreachableServers @('dhcp1')
    Assert-Equal 'dhcp1' $r.authority
    Assert-Equal 'dhcp1' $r.label
    Assert-Equal @('dhcp2') $r.dataFrom 'the only copy the scan could read'
    Assert-Equal $false $r.takeover
    Assert-Equal 'degraded' $r.issue.status
}

Test-Case 'hot standby, standby claims takeover while the primary answers: primary speaks, anomaly reported' {
    $primary = New-Read 'dhcp1' 'HotStandby' 'Active' 'CommunicationInterrupted' 'dhcp2'
    $standby = New-Read 'dhcp2' 'HotStandby' 'Standby' 'PartnerDown' 'dhcp1'
    $r = Resolve-DhcpScopeAuthority -Candidates @($standby, $primary)
    Assert-Equal 'dhcp1' $r.authority 'on AND engaged is required; engaged alone is not enough'
    Assert-Equal $false $r.takeover
    Assert-Equal 'degraded' $r.issue.status
}

Test-Case 'hot standby, standby unreachable: primary speaks, lost redundancy reported' {
    $primary = New-Read 'dhcp1' 'HotStandby' 'Active' 'CommunicationInterrupted' 'dhcp2'
    $r = Resolve-DhcpScopeAuthority -Candidates @($primary) -UnreachableServers @('dhcp2')
    Assert-Equal 'dhcp1' $r.authority
    Assert-Equal 'degraded' $r.issue.status
    Assert-True ($r.issue.message -like '*dhcp2*') 'the report names the missing standby'
}

Test-Case 'hot standby with no readable role refuses to guess a primary' {
    $a = New-Read 'dhcp1' 'HotStandby' '' 'Normal' 'dhcp2'
    $b = New-Read 'dhcp2' 'HotStandby' '' 'Normal' 'dhcp1'
    $r = Resolve-DhcpScopeAuthority -Candidates @($a, $b)
    Assert-Equal '' $r.authority
    Assert-Equal 'dhcp1 / dhcp2' $r.label
    Assert-Equal 'degraded' $r.issue.status
}

Test-Case 'load balance names both servers and elects neither' {
    $a = New-Read 'dhcp2' 'LoadBalance' '' 'Normal' 'dhcp1.corp.local'
    $b = New-Read 'dhcp1' 'LoadBalance' '' 'Normal' 'dhcp2.corp.local'
    $r = Resolve-DhcpScopeAuthority -Candidates @($a, $b)
    Assert-Equal 'loadbalance' $r.mode
    Assert-Equal 'dhcp1 / dhcp2' $r.label 'sorted, so the label is stable scan to scan'
    Assert-Equal '' $r.authority
    Assert-Equal @('dhcp1', 'dhcp2') $r.dataFrom
    Assert-Equal $null $r.issue
}

Test-Case 'load balance with a partner down still names both, and reports it' {
    $a = New-Read 'dhcp1' 'LoadBalance' '' 'PartnerDown' 'dhcp2'
    $r = Resolve-DhcpScopeAuthority -Candidates @($a) -UnreachableServers @('dhcp2')
    Assert-Equal 'dhcp1 / dhcp2' $r.label
    Assert-Equal @('dhcp1') $r.dataFrom
    Assert-Equal 'failed' $r.issue.status
}

Test-Case 'the same scope on two servers with no relationship is a split scope' {
    $r = Resolve-DhcpScopeAuthority -Candidates @((New-Read 'dhcp2'), (New-Read 'dhcp1'))
    Assert-Equal 'split' $r.mode
    Assert-Equal 'dhcp1 / dhcp2' $r.label
}

# ── Windows PowerShell 5.1, the runtime the backend actually uses ───────────

$Ps51 = Get-Command powershell.exe -ErrorAction SilentlyContinue

function Invoke-Ps51 {
    param([string[]]$Arguments)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Ps51.Source
    $psi.Arguments = ($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    # Decoded as UTF-8, exactly as Node's child_process does in server.js.
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return @{ Out = $out; Err = $err; Code = $p.ExitCode }
}

if ($Ps51) {
    Test-Case '5.1: masks compute (0xFFFFFFFF parses as -1 there)' {
        $cidr = (Resolve-Path "$PSScriptRoot/../scan/netscan/Cidr.ps1").Path
        $r = Invoke-Ps51 @('-NoProfile', '-Command', ". '$cidr'; ConvertTo-SubnetMask 22; Get-NetworkAddress -Ip 10.0.1.37 -PrefixLength 22")
        Assert-Equal '' $r.Err.Trim()
        Assert-Equal @('255.255.252.0', '10.0.0.0') @($r.Out.Trim() -split "`r?`n")
    }

    Test-Case '5.1: an accented scope name reaches a UTF-8 reader intact' {
        # The bug that shipped: "Plage Réseau DHCP" arrived as "Plage R?seau DHCP"
        # because 5.1 wrote stdout in the console code page (ibm850).
        $scan = (Resolve-Path "$PSScriptRoot/../scan/network_scan.ps1").Path
        $r = Invoke-Ps51 @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scan, '-SelfTest')
        Assert-Equal 0 $r.Code
        Assert-Equal '' $r.Err.Trim()
        $line = @($r.Out -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })[-1]
        Assert-True (-not $line.Contains([char]0xFFFD)) 'a replacement character means the encoding broke'
        $o = $line | ConvertFrom-Json
        Assert-Equal 'Plage Réseau DHCP' @($o.subnets)[0].label
        Assert-True (@($o.diagnostics)[0].message -like 'Étendue*') 'accented diagnostic text must survive too'
    }

    Test-Case '5.1: the scan names the account the launcher passed, not the local one' {
        # Started by Start-NetOnly.ps1, the scan is the service locally and the
        # scan account on the network. Its diagnostics must name the second.
        $scan = (Resolve-Path "$PSScriptRoot/../scan/network_scan.ps1").Path
        $env:AEGIS_SCAN_NET_ACCOUNT = 'CORP\svc-scan'
        try { $r = Invoke-Ps51 @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scan, '-SelfTest') }
        finally { Remove-Item Env:AEGIS_SCAN_NET_ACCOUNT -ErrorAction SilentlyContinue }
        Assert-Equal 0 $r.Code
        $line = @($r.Out -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })[-1]
        Assert-Equal 'CORP\svc-scan' ($line | ConvertFrom-Json).context.userName

        $r = Invoke-Ps51 @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scan, '-SelfTest')
        $line = @($r.Out -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })[-1]
        Assert-Equal "$env:USERDOMAIN\$env:USERNAME" ($line | ConvertFrom-Json).context.userName
    }
}
else {
    Write-Host '  SKIP 5.1 cases: powershell.exe not found on this machine' -ForegroundColor Yellow
}
