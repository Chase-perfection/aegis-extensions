# Per-source diagnostics for the network inventory scan.
#
# Dot-sourced by shield/network_scan.ps1, and kept out of shield/src/ for the
# same reason as Cidr.ps1: build.ps1 would assemble it into Shield-Audit.ps1.
#
# WHY THIS EXISTS
#
# The scan reaches half a dozen services it does not own — DHCP over RPC, DNS,
# the directory — and any of them can refuse. Every refusal used to be swallowed
# by an -ErrorAction SilentlyContinue, so the page showed an inventory missing
# its DHCP half and said nothing about why. What an operator needs is not a
# nicer error string: it is something they can paste into a message to whoever
# administers that server. Hence the failing command and the raw error on every
# entry, and hence the flattening below.
#
# Runs under Windows PowerShell 5.1, like the scan that loads it.

<#
.SYNOPSIS
    A fresh, empty diagnostic log.
.DESCRIPTION
    An ArrayList rather than @(): the scan appends to it a few dozen times and
    += on an array reallocates each time.

    The unary comma is load-bearing. PowerShell enumerates a collection on the
    way out of a function, and an EMPTY one enumerates to nothing: a plain
    `return $log` handed back $null, every Add-ScanDiagnostic call then failed
    parameter binding, and the scan lost the whole diagnostic channel. `,$log`
    wraps it in a one-element array, which the assignment unwraps back to the
    list itself.
#>
function New-ScanDiagnosticLog {
    $log = New-Object System.Collections.ArrayList
    return , $log
}

<#
.SYNOPSIS
    Collapses a string onto one line.
.DESCRIPTION
    Not cosmetic. backend/src/server.js recovers the scan's payload by walking
    stdout backwards for a line that starts with '{', so a newline anywhere in
    the JSON would cut the payload in half. RPC and WinRM messages routinely
    carry them, and so does a `throw "..."`, whose text becomes the record's own
    FullyQualifiedErrorId.
#>
function ConvertTo-SingleLine {
    param([string]$Text)
    if ($null -eq $Text) { return "" }
    return ((("$Text" -replace "`r`n", " ") -replace "`n", " ") -replace "`t", " ")
}

<#
.SYNOPSIS
    Renders an ErrorRecord as one line: type, message, inner, category, error id.
#>
function ConvertTo-ScanErrorDetail {
    param($ErrorRecord)
    if (-not $ErrorRecord) { return "" }
    $parts = New-Object System.Collections.ArrayList
    if ($ErrorRecord.Exception) {
        [void]$parts.Add("$($ErrorRecord.Exception.GetType().FullName): $(ConvertTo-SingleLine $ErrorRecord.Exception.Message)")
        if ($ErrorRecord.Exception.InnerException) {
            [void]$parts.Add("inner: $(ConvertTo-SingleLine $ErrorRecord.Exception.InnerException.Message)")
        }
    }
    if ($ErrorRecord.CategoryInfo) { [void]$parts.Add("category: $($ErrorRecord.CategoryInfo.Category)") }
    if ($ErrorRecord.FullyQualifiedErrorId) { [void]$parts.Add("errorId: $($ErrorRecord.FullyQualifiedErrorId)") }
    return (ConvertTo-SingleLine ($parts -join " | "))
}

<#
.SYNOPSIS
    Records what one source of the scan managed, or failed, to do.
.PARAMETER Log
    The log to append to, from New-ScanDiagnosticLog. Explicit rather than
    implicit script state so a test can hand in its own and read it back.
.PARAMETER Status
    ok | degraded | failed | skipped. 'degraded' is the common case: the scan
    produced an inventory, one source of it is incomplete.
.PARAMETER Hint
    What the person receiving the report should try. Written for whoever
    administers the failing server, not for whoever ran the scan.
.PARAMETER Command
    The command that failed, verbatim and runnable, so it can be reproduced.
#>
function Add-ScanDiagnostic {
    param(
        [Parameter(Mandatory = $true)]$Log,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][ValidateSet('ok', 'degraded', 'failed', 'skipped')][string]$Status,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Hint = "",
        [string]$Command = "",
        $ErrorRecord = $null
    )
    [void]$Log.Add([ordered]@{
            source  = ConvertTo-SingleLine $Source
            status  = $Status
            message = ConvertTo-SingleLine $Message
            hint    = ConvertTo-SingleLine $Hint
            command = ConvertTo-SingleLine $Command
            detail  = ConvertTo-ScanErrorDetail $ErrorRecord
            at      = (Get-Date).ToString("o")
        })

    # Also on the live log the dashboard streams, so a long scan says what went
    # wrong while it is still running rather than only in the final report.
    if ($Status -ne 'ok') { Write-Host "WARNING: [$Source] $(ConvertTo-SingleLine $Message)" }
}

<#
.SYNOPSIS
    True when a DHCP cmdlet failed because the server refused, not because it
    was silent.
.DESCRIPTION
    The DhcpServer cmdlets report every remote problem as one CimException, so
    the type says nothing. What separates a refusal from a silence is WIN32 5 —
    ERROR_ACCESS_DENIED — which surfaces two ways depending on the build: as the
    error id "WIN32 5,Get-DhcpServerv4Scope", and as the PermissionDenied error
    category. Either one is enough.

    The distinction is not cosmetic. A refusal is fixed by adding the scan's
    account to DHCP Users on that server; a silence is fixed on the firewall or
    the service. Reporting both as "n'a pas répondu" sends the operator to the
    wrong one.

    Matched on the id and the category, never on the message: that text is
    localised, and on a French server it arrives as "Échec de l'énumération des
    étendues" with no code in it at all.
#>
function Test-DhcpAccessDenied {
    param($ErrorRecord)
    if (-not $ErrorRecord) { return $false }
    $id = "$($ErrorRecord.FullyQualifiedErrorId)"
    if ($id -match '(^|\W)WIN32\s+5(\W|$)') { return $true }
    if ($ErrorRecord.CategoryInfo -and "$($ErrorRecord.CategoryInfo.Category)" -eq 'PermissionDenied') { return $true }
    return $false
}

<#
.SYNOPSIS
    True when a DHCP authorization in the directory no longer points at the
    server it names.
.DESCRIPTION
    A second reading of the same refusal. Get-DhcpServerInDC lists what the
    directory was told years ago, and nothing ever retracts an entry when a
    server is decommissioned: the name keeps an A record, the address gets
    reused, and the DHCP call lands on a machine that is not the one it asked
    for. That machine answers WIN32 5, which is indistinguishable from a real
    rights problem, so the report sent the operator to grant an account on a
    server that no longer exists.

    The tell is cheap and local: the address the directory recorded against the
    name, versus where that name resolves now. Unresolvable, or resolving
    somewhere else, means the authorization is stale, whatever the RPC said.

    Pure on purpose. The caller does the DNS lookup and hands the answers in, so
    shield/tests/netscan.tests.ps1 can walk every case without a resolver.
.PARAMETER DeclaredIp
    The IPAddress the directory holds for this authorization.
.PARAMETER ResolvedIps
    Every A record the name resolves to now. Empty means it resolves to nothing.
#>
function Test-DhcpAuthorizationStale {
    param(
        [string]$DeclaredIp,
        [string[]]$ResolvedIps = @()
    )
    # No recorded address: nothing to compare against, so this says nothing and
    # the caller falls back to reading the RPC error.
    if ([string]::IsNullOrWhiteSpace($DeclaredIp)) { return $false }
    $live = @($ResolvedIps | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($live.Count -eq 0) { return $true }
    return (-not ($live -contains $DeclaredIp))
}
