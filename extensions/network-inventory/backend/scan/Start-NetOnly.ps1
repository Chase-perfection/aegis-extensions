param(
    [string]$Domain,
    [switch]$ProbeOnly,
    [switch]$SelfTest
)

# Runs network_scan.ps1 with the scan account as its network identity, the way
# `runas /netonly` does: same local identity as the backend, every remote read
# (DHCP, AD, DNS) made as the account the operator chose. See NetOnlyProcess.cs.
#
# Inputs come from the environment that backend/scanAccount.js builds:
#   AEGIS_SCAN_NET_ACCOUNT  the account, DOMAIN\name or name@dns.domain
#   AEGIS_SCAN_NET_SECRET   its password, removed from this process at once
# The password never reaches a command line, a file or a log.
#
# Exit codes: the scan's own, or 3 when Windows refused to start it, with one
# NETONLY_ERROR:<win32>:<message> line on stderr for the backend to report.

$ErrorActionPreference = 'Stop'
$StartFailedExit = 3

# Windows writes its error text in the system language, and the backend reads
# stderr as UTF-8: without this, "privilege" in French arrives with its accents
# replaced. network_scan.ps1 sets the same for its own output.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$account = $env:AEGIS_SCAN_NET_ACCOUNT
$plain = $env:AEGIS_SCAN_NET_SECRET
Remove-Item Env:AEGIS_SCAN_NET_SECRET -ErrorAction SilentlyContinue

function Exit-Launcher {
    param([int]$Code, [string]$Message)
    [Console]::Error.WriteLine("NETONLY_ERROR:${Code}:$Message")
    exit $StartFailedExit
}

if (-not $account) { Exit-Launcher 0 'AEGIS_SCAN_NET_ACCOUNT is not set' }
if (-not $plain) { Exit-Launcher 0 'AEGIS_SCAN_NET_SECRET is not set' }

# The domain goes into a command line, so it is held to the characters a DNS or
# NetBIOS name can carry. scanAccount.js checks the same before calling.
if ($Domain -and $Domain -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$') {
    Exit-Launcher 0 'the domain name holds characters a domain name cannot carry'
}

if ($account -match '^([^\\]+)\\(.+)$') { $logonDomain = $Matches[1]; $logonUser = $Matches[2] }
else { $logonDomain = $null; $logonUser = $account }

$secure = ConvertTo-SecureString $plain -AsPlainText -Force
$plain = $null

$scan = Join-Path $PSScriptRoot 'network_scan.ps1'
$exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$commandLine = '"' + $exe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scan + '"'
if ($Domain) { $commandLine += ' -Domain ' + $Domain }
if ($ProbeOnly) { $commandLine += ' -ProbeOnly' }
if ($SelfTest) { $commandLine += ' -SelfTest' }

# The scan inherits this environment, the secret already gone from it. The
# account stays: network_scan.ps1 names it in its diagnostics.
$environment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $environment[[string]$entry.Key] = [string]$entry.Value
}
$environment.Remove('AEGIS_SCAN_NET_SECRET')

try {
    Add-Type -Path (Join-Path $PSScriptRoot 'NetOnlyProcess.cs')
    $code = [AegisNetOnly.NetOnlyProcess]::Run($logonUser, $logonDomain, $secure, $commandLine, $environment)
}
catch {
    $inner = $_.Exception
    while ($inner.InnerException -and -not ($inner -is [System.ComponentModel.Win32Exception])) { $inner = $inner.InnerException }
    if ($inner -is [System.ComponentModel.Win32Exception]) { Exit-Launcher $inner.NativeErrorCode $inner.Message.Trim() }
    Exit-Launcher 0 $_.Exception.Message.Trim()
}
exit $code
