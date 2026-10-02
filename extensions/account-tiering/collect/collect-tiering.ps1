<#
.SYNOPSIS
    Reads which accounts and groups of the domain reach Tier 0 or Tier 1, and
    writes those facts as JSON for backend/analyze.js.
.DESCRIPTION
    Read-only. The script runs LDAP searches over ADSI and reads files in
    SYSVOL; it never writes to the directory, to SYSVOL or to a machine. The
    one file it writes is -OutFile.

    Run by backend/runner.js in Windows PowerShell 5.1 under the Aegis
    service, so it authenticates as the server's machine account. The format
    of the facts is in docs/plans/2026-09-30-account-tiering-conception.md,
    section "Collecte"; backend/tests/fixtures/collector-sample.json is an
    example of what this script writes.

    The reading code follows shield/src in the Aegis tree: the DACL read of
    Get-ShieldDnsZoneAcl (a searcher with SecurityMasks Dacl, parsed by
    ActiveDirectorySecurity, rules projected to Sid/Rights/ObjectType) and the
    SYSVOL read of Find-ShieldReversiblePwdGpo (GptTmpl.inf through
    Get-Content, which honours the UTF-16 BOM secedit writes). It is copied,
    not dot-sourced: an extension ships alone, and Shield-Audit.ps1 needs
    PowerShell 7.

    Groups are named by SID, never by name: the hosts run French Windows.
    The SID lists, the ACE masks and the GPO file parsers are in
    tiering-rules.ps1, next to this file, which needs no directory.

    Exit codes: 0 facts written; 2 with "AT-ERROR domain_unreachable" on
    stdout when no domain controller answers; 1 anything else, message on
    stderr. Other stdout lines are progress.
#>
param(
    [ValidateRange(1, 5)][int]$Passes = 3,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Domain = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'tiering-rules.ps1')

$PrincipalProps = @('objectSid', 'distinguishedName', 'sAMAccountName', 'name', 'displayName', 'objectClass', 'userAccountControl', 'primaryGroupID')

# Everything the script has learnt, shared by the functions below.
$Server = ''
$DomainDn = ''
$DomainSid = ''
$Principals = [ordered]@{}
$NewPrincipals = New-Object System.Collections.Generic.List[string]
$Unresolved = New-Object System.Collections.Generic.HashSet[string]
$Expanded = New-Object System.Collections.Generic.HashSet[string]
$Memberships = New-Object System.Collections.Generic.List[object]
$MembershipKeys = New-Object System.Collections.Generic.HashSet[string]
$Aces = New-Object System.Collections.Generic.List[object]
$AceKeys = New-Object System.Collections.Generic.HashSet[string]
$Unreadable = New-Object System.Collections.Generic.List[object]
$ObjectCache = @{}
$NameCache = @{}
$Tier0 = New-Object System.Collections.Generic.HashSet[string]
$ComputerSids = New-Object System.Collections.Generic.List[string]
$BroadSids = @()

function Get-AtValue($Result, [string]$Name) {
    $Values = $Result.Properties[$Name]
    if ($null -ne $Values -and $Values.Count -gt 0) { return $Values[0] }
    return $null
}

function Add-AtUnreadable([string]$Dn, [string]$Reason) {
    $Unreadable.Add([ordered]@{ dn = $Dn; reason = $Reason })
}

function Find-AtEntries {
    param([string]$BaseDn, [string]$Filter, [string[]]$Props, [string]$Scope = 'Subtree', [switch]$Dacl)
    $Root = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$Server$BaseDn")
    $Searcher = New-Object System.DirectoryServices.DirectorySearcher($Root, $Filter, $Props)
    $Searcher.PageSize = 500
    $Searcher.SearchScope = [System.DirectoryServices.SearchScope]$Scope
    if ($Dacl) { $Searcher.SecurityMasks = [System.DirectoryServices.SecurityMasks]::Dacl }
    $Results = $Searcher.FindAll()
    try { foreach ($R in $Results) { $R } }
    finally { $Results.Dispose(); $Searcher.Dispose(); $Root.Dispose() }
}

# --- Principals and memberships ---------------------------------------------

function Add-AtPrincipal($Result) {
    $Bytes = Get-AtValue $Result 'objectsid'
    if ($null -eq $Bytes) { return $null }
    $Sid = ConvertTo-AtSid $Bytes
    if ($Principals.Contains($Sid)) { return $Sid }
    $Classes = @($Result.Properties['objectclass'] | ForEach-Object { [string]$_ })
    # A foreign security principal stands for a SID of elsewhere (Authenticated
    # Users, another domain): the membership is kept, there is no record.
    if ($Classes -contains 'foreignSecurityPrincipal') { return $Sid }
    if ($Classes -contains 'msDS-GroupManagedServiceAccount' -or $Classes -contains 'msDS-ManagedServiceAccount') { $Kind = 'gmsa' }
    elseif ($Classes -contains 'computer') { $Kind = 'computer' }
    elseif ($Classes -contains 'group') { $Kind = 'group' }
    elseif ($Classes -contains 'user') { $Kind = 'user' }
    else { return $null }

    $Name = Get-AtValue $Result 'displayname'
    if (-not $Name) { $Name = Get-AtValue $Result 'name' }
    $Record = [ordered]@{
        sid = $Sid
        dn = [string](Get-AtValue $Result 'distinguishedname')
        sam = [string](Get-AtValue $Result 'samaccountname')
        name = [string]$Name
        kind = $Kind
        enabled = $true
    }
    if ($Kind -ne 'group') {
        $Uac = Get-AtValue $Result 'useraccountcontrol'
        if ($null -ne $Uac) { $Record.enabled = (([int]$Uac -band 2) -eq 0) }
        $Pgid = Get-AtValue $Result 'primarygroupid'
        if ($null -ne $Pgid) { $Record.primaryGroupRid = [int]$Pgid }
    }
    $Principals[$Sid] = $Record
    $NewPrincipals.Add($Sid)
    return $Sid
}

function Resolve-AtSid([string]$Sid) {
    if ($Principals.Contains($Sid)) { return $true }
    if ($Unresolved.Contains($Sid)) { return $false }
    # A SID of another domain or a deleted account resolves to nothing here.
    try { foreach ($Hit in @(Find-AtEntries $DomainDn "(objectSid=$Sid)" $PrincipalProps)) { [void](Add-AtPrincipal $Hit) } }
    catch { Add-AtUnreadable $Sid (Get-AtReason $_) }
    if ($Principals.Contains($Sid)) { return $true }
    [void]$Unresolved.Add($Sid)
    return $false
}

function Resolve-AtName([string]$Name) {
    # GPO files name a member as DOMAIN\sam when they were saved without a SID.
    $Sam = ($Name -split '\\')[-1].Trim()
    if (-not $Sam) { return $null }
    $Key = $Sam.ToLowerInvariant()
    if (-not $NameCache.ContainsKey($Key)) {
        $NameCache[$Key] = $null
        try {
            foreach ($Hit in @(Find-AtEntries $DomainDn "(sAMAccountName=$(ConvertTo-AtLdapValue $Sam))" $PrincipalProps)) {
                $NameCache[$Key] = Add-AtPrincipal $Hit
            }
        }
        catch { Add-AtUnreadable $Name (Get-AtReason $_) }
    }
    return $NameCache[$Key]
}

function Add-AtMembership([string]$Group, [string]$Member, [string]$Via) {
    if ($MembershipKeys.Add("$Group|$Member|$Via")) {
        $Memberships.Add([ordered]@{ group = $Group; member = $Member; via = $Via })
    }
}

function Expand-AtGroup([string]$GroupSid) {
    # Members at every depth, each link kept so the tree shows the middle
    # groups. The Expanded set is what stops a membership cycle.
    $Queue = New-Object System.Collections.Generic.Queue[string]
    $Queue.Enqueue($GroupSid)
    while ($Queue.Count -gt 0) {
        $G = $Queue.Dequeue()
        if ($BroadSids -contains $G -or -not $Expanded.Add($G)) { continue }
        if (-not $Principals.Contains($G) -or $Principals[$G].kind -ne 'group') { continue }
        try {
            foreach ($Hit in @(Find-AtEntries $DomainDn "(memberOf=$(ConvertTo-AtLdapValue $Principals[$G].dn))" $PrincipalProps)) {
                $M = Add-AtPrincipal $Hit
                if (-not $M) { continue }
                Add-AtMembership $G $M 'member'
                if ($Principals.Contains($M) -and $Principals[$M].kind -eq 'group') { $Queue.Enqueue($M) }
            }
            # A primary group is not in `member`: it is the account's
            # primaryGroupID, the group's RID.
            if ($G.StartsWith("$DomainSid-")) {
                $Rid = $G.Substring($DomainSid.Length + 1)
                foreach ($Hit in @(Find-AtEntries $DomainDn "(primaryGroupID=$Rid)" $PrincipalProps)) {
                    $M = Add-AtPrincipal $Hit
                    if ($M) { Add-AtMembership $G $M 'primaryGroup' }
                }
            }
        }
        catch { Add-AtUnreadable $Principals[$G].dn (Get-AtReason $_) }
    }
}

function Add-AtTrustee([string]$Sid) {
    if ($IgnoredSids -contains $Sid -or $BroadSids -contains $Sid) { return }
    if ((Resolve-AtSid $Sid) -and $Principals[$Sid].kind -eq 'group') { Expand-AtGroup $Sid }
}

# --- Security descriptors ---------------------------------------------------

function Read-AtObjects([string[]]$Dns) {
    $Wanted = @($Dns | Where-Object { $_ -and -not $ObjectCache.ContainsKey($_.ToLowerInvariant()) } | Select-Object -Unique)
    for ($I = 0; $I -lt $Wanted.Count; $I += 40) {
        $Chunk = @($Wanted[$I..([Math]::Min($I + 39, $Wanted.Count - 1))])
        $Filter = '(|' + (($Chunk | ForEach-Object { "(distinguishedName=$(ConvertTo-AtLdapValue $_))" }) -join '') + ')'
        try {
            foreach ($Hit in @(Find-AtEntries $DomainDn $Filter @('distinguishedName', 'nTSecurityDescriptor') -Dacl)) {
                $Dn = [string](Get-AtValue $Hit 'distinguishedname')
                $Raw = Get-AtValue $Hit 'ntsecuritydescriptor'
                if ($null -eq $Raw) { $ObjectCache[$Dn.ToLowerInvariant()] = $null; Add-AtUnreadable $Dn 'access_denied'; continue }
                $Sd = New-Object System.DirectoryServices.ActiveDirectorySecurity
                $Sd.SetSecurityDescriptorBinaryForm([byte[]]$Raw)
                $Rules = foreach ($R in $Sd.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                    [pscustomobject]@{
                        Sid = $R.IdentityReference.Value
                        Rights = [int]$R.ActiveDirectoryRights
                        Allow = ([string]$R.AccessControlType -eq 'Allow')
                        ObjectType = ([string]$R.ObjectType).ToLowerInvariant()
                        InheritedObjectType = ([string]$R.InheritedObjectType).ToLowerInvariant()
                        InheritOnly = (([int]$R.PropagationFlags -band 2) -ne 0)
                        IsInherited = [bool]$R.IsInherited
                    }
                }
                $ObjectCache[$Dn.ToLowerInvariant()] = [pscustomobject]@{ Dn = $Dn; Rules = @($Rules) }
            }
        }
        catch { foreach ($Dn in $Chunk) { $ObjectCache[$Dn.ToLowerInvariant()] = $null; Add-AtUnreadable $Dn (Get-AtReason $_) } }
        foreach ($Dn in $Chunk) {
            if (-not $ObjectCache.ContainsKey($Dn.ToLowerInvariant())) { $ObjectCache[$Dn.ToLowerInvariant()] = $null; Add-AtUnreadable $Dn 'not_found' }
        }
    }
}

function Get-AtObject([string]$Dn) {
    Read-AtObjects @($Dn)
    return $ObjectCache[$Dn.ToLowerInvariant()]
}

function Find-AtAceOrigin([string]$Dn, $Rule) {
    # An inherited ACE is shown where it was set: up the parents to the first
    # one that holds the same ACE uninherited.
    $Parent = Get-AtParentDn $Dn
    while ($Parent -and $Parent.Length -ge $DomainDn.Length) {
        $P = Get-AtObject $Parent
        if ($null -eq $P) { break }
        $Same = @($P.Rules | Where-Object {
            $_.Allow -and $_.Sid -eq $Rule.Sid -and $_.Rights -eq $Rule.Rights -and
            $_.ObjectType -eq $Rule.ObjectType -and $_.InheritedObjectType -eq $Rule.InheritedObjectType
        })
        if ($Same.Count -eq 0) { break }
        if (@($Same | Where-Object { -not $_.IsInherited }).Count -gt 0) { return $Parent }
        $Parent = Get-AtParentDn $Parent
    }
    return $Dn
}

function Add-AtObjectAces([string]$Dn, [string]$ObjectSid, [string]$Kind, [int]$Pass, [string[]]$Only = @()) {
    $Obj = Get-AtObject $Dn
    if ($null -eq $Obj) { return }
    foreach ($R in $Obj.Rules) {
        # Deny ACEs are not subtracted: an approximation the page states.
        if (-not $R.Allow -or $R.InheritOnly) { continue }
        if ($IgnoredSids -contains $R.Sid -or $Tier0.Contains($R.Sid)) { continue }
        $Rights = @(Get-AtAceRights $R.Rights $R.ObjectType $Kind)
        if ($Only.Count -gt 0) { $Rights = @($Rights | Where-Object { $Only -contains $_ }) }
        if ($Rights.Count -eq 0) { continue }
        $Origin = if ($R.IsInherited) { Find-AtAceOrigin $Obj.Dn $R } else { $Obj.Dn }
        foreach ($Right in $Rights) {
            if (-not $AceKeys.Add("$($Obj.Dn)|$($R.Sid)|$Right".ToLowerInvariant())) { continue }
            $Aces.Add([ordered]@{
                objectDn = $Obj.Dn; objectSid = $(if ($ObjectSid) { $ObjectSid } else { $null }); objectKind = $Kind
                originDn = $Origin; trustee = $R.Sid; right = $Right; inherited = $R.IsInherited; pass = $Pass
            })
        }
        Add-AtTrustee $R.Sid
    }
}

# --- Group Policy -----------------------------------------------------------

function ConvertTo-AtMemberSids($Values) {
    $Sids = New-Object System.Collections.Generic.List[string]
    foreach ($V in @($Values)) {
        $Sid = if ($V.StartsWith('*')) { $V.Substring(1) } else { Resolve-AtName $V }
        if ($Sid -and -not $Sids.Contains($Sid)) { $Sids.Add($Sid) }
    }
    return , $Sids.ToArray()
}

function Read-AtGpoLocalGroups([string]$Path) {
    $LocalGroups = New-Object System.Collections.Generic.List[object]
    if (-not $Path) { return , $LocalGroups }
    $Sources = @(
        @{ Source = 'GptTmpl'; File = Join-Path $Path 'Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf' },
        @{ Source = 'GroupsXml'; File = Join-Path $Path 'Machine\Preferences\Groups\Groups.xml' }
    )
    foreach ($S in $Sources) {
        try {
            if (-not (Test-Path -LiteralPath $S.File)) { continue }
            if ($S.Source -eq 'GptTmpl') { $Found = Read-AtGptTmpl ([string](Get-Content -LiteralPath $S.File -Raw)) }
            else {
                $Doc = New-Object System.Xml.XmlDocument
                $Doc.XmlResolver = $null
                $Doc.Load($S.File)
                $Found = Read-AtGroupsXml $Doc
            }
            foreach ($Group in $Found.Keys) {
                $Members = ConvertTo-AtMemberSids $Found[$Group]
                if ($Members.Count -gt 0) { $LocalGroups.Add([ordered]@{ localGroup = $Group; members = $Members; source = $S.Source }) }
            }
        }
        catch { Add-AtUnreadable $S.File (Get-AtReason $_) }
    }
    return , $LocalGroups
}

function Get-AtComputerCounts {
    # Computers each link reaches, by class, per container: a non-enforced link
    # stops at an OU that blocks inheritance, an enforced one does not.
    # Security and WMI filters are not evaluated: this can only overstate.
    $Blocked = New-Object System.Collections.Generic.HashSet[string]
    foreach ($Hit in @(Find-AtEntries $DomainDn '(&(objectClass=organizationalUnit)(gPOptions=1))' @('distinguishedName'))) {
        [void]$Blocked.Add(([string](Get-AtValue $Hit 'distinguishedname')).ToLowerInvariant())
    }
    $Counts = @{}
    foreach ($Hit in @(Find-AtEntries $DomainDn '(objectCategory=computer)' @('distinguishedName', 'objectSid', 'operatingSystem', 'userAccountControl', 'primaryGroupID'))) {
        # Counted against the principals at the end, when every pass is done.
        $ComputerSids.Add((ConvertTo-AtSid (Get-AtValue $Hit 'objectsid')))
        $Uac = [int](Get-AtValue $Hit 'useraccountcontrol')
        $Pgid = [int](Get-AtValue $Hit 'primarygroupid')
        $Os = [string](Get-AtValue $Hit 'operatingsystem')
        $Class = if (($Uac -band 0x2000) -ne 0 -or $Pgid -eq 516 -or $Pgid -eq 521) { 0 } elseif ($Os -like '*Server*') { 1 } else { 2 }
        $BlockedBelow = $false
        $Container = Get-AtParentDn ([string](Get-AtValue $Hit 'distinguishedname'))
        while ($Container) {
            $Key = $Container.ToLowerInvariant()
            if (-not $Counts.ContainsKey($Key)) { $Counts[$Key] = @{ Normal = @(0, 0, 0); Enforced = @(0, 0, 0) } }
            $Counts[$Key].Enforced[$Class]++
            if (-not $BlockedBelow) { $Counts[$Key].Normal[$Class]++ }
            if ($Blocked.Contains($Key)) { $BlockedBelow = $true }
            if ($Key -eq $DomainDn.ToLowerInvariant()) { break }
            $Container = Get-AtParentDn $Container
        }
    }
    return $Counts
}

function Read-AtGpos {
    $Gpos = [ordered]@{}
    $PoliciesDn = "CN=Policies,CN=System,$DomainDn"
    foreach ($Hit in @(Find-AtEntries $PoliciesDn '(objectClass=groupPolicyContainer)' @('cn', 'displayName', 'gPCFileSysPath', 'distinguishedName') -Scope OneLevel)) {
        $Guid = ([string](Get-AtValue $Hit 'cn')).ToLowerInvariant()
        $Gpos[$Guid] = [ordered]@{
            guid = $Guid
            name = [string](Get-AtValue $Hit 'displayname')
            editors = @()
            links = New-Object System.Collections.Generic.List[object]
            localGroups = Read-AtGpoLocalGroups ([string](Get-AtValue $Hit 'gpcfilesyspath'))
            Dn = [string](Get-AtValue $Hit 'distinguishedname')
        }
    }

    # Links: gPLink holds "[LDAP://cn={GUID},cn=policies,...;<options>]" per
    # GPO; option bit 1 disables the link, bit 2 enforces it. Links on sites
    # (configuration partition) are not read.
    $Counts = Get-AtComputerCounts
    foreach ($Hit in @(Find-AtEntries $DomainDn '(gPLink=*)' @('distinguishedName', 'gPLink'))) {
        $Som = [string](Get-AtValue $Hit 'distinguishedname')
        foreach ($M in [regex]::Matches([string](Get-AtValue $Hit 'gplink'), '\[LDAP://cn=(\{[0-9a-f-]{36}\}),[^;\]]*;(\d+)\]', 'IgnoreCase')) {
            $Guid = $M.Groups[1].Value.ToLowerInvariant()
            $Options = [int]$M.Groups[2].Value
            if (($Options -band 1) -ne 0 -or -not $Gpos.Contains($Guid)) { continue }
            $Enforced = (($Options -band 2) -ne 0)
            $C = $Counts[$Som.ToLowerInvariant()]
            $N = if ($null -eq $C) { @(0, 0, 0) } elseif ($Enforced) { $C.Enforced } else { $C.Normal }
            $Gpos[$Guid].links.Add([ordered]@{ somDn = $Som; enforced = $Enforced; computers = [ordered]@{ dc = $N[0]; server = $N[1]; workstation = $N[2] } })
        }
    }

    # Editors: who may change the GPO object. The ones of a GPO that reaches a
    # DC or a server, and the members it puts in local groups there, are
    # followed like any other trustee.
    Read-AtObjects @($Gpos.Values | ForEach-Object { $_.Dn })
    $Top = @($DomainDn.ToLowerInvariant(), "ou=domain controllers,$DomainDn".ToLowerInvariant())
    foreach ($Gpo in $Gpos.Values) {
        $Obj = $ObjectCache[$Gpo.Dn.ToLowerInvariant()]
        $Editors = New-Object System.Collections.Generic.List[string]
        if ($null -ne $Obj) {
            foreach ($R in $Obj.Rules) {
                if (-not $R.Allow -or $R.InheritOnly -or $IgnoredSids -contains $R.Sid -or $Tier0.Contains($R.Sid)) { continue }
                if (@(Get-AtAceRights $R.Rights $R.ObjectType 'gpo').Count -gt 0 -and -not $Editors.Contains($R.Sid)) { $Editors.Add($R.Sid) }
            }
        }
        $Gpo.editors = $Editors.ToArray()
        $Reaches = @($Gpo.links | Where-Object { $Top -contains $_.somDn.ToLowerInvariant() -or $_.computers.dc -gt 0 -or $_.computers.server -gt 0 }).Count -gt 0
        if (-not $Reaches) { continue }
        foreach ($E in $Gpo.editors) { Add-AtTrustee $E }
        foreach ($LG in $Gpo.localGroups) { foreach ($M in $LG.members) { Add-AtTrustee $M } }
    }
    return $Gpos
}

# --- Main -------------------------------------------------------------------

try {
    try {
        if ($Domain) { $Server = "$Domain/" }
        $RootDse = New-Object System.DirectoryServices.DirectoryEntry("LDAP://${Server}RootDSE")
        $DomainDn = [string]$RootDse.Properties['defaultNamingContext'].Value
        $ConfigDn = [string]$RootDse.Properties['configurationNamingContext'].Value
        if (-not $DomainDn) { throw 'no naming context' }
        $Head = @(Find-AtEntries $DomainDn '(objectClass=*)' @('objectSid') -Scope Base)
        $DomainSid = ConvertTo-AtSid (Get-AtValue $Head[0] 'objectsid')
    }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        Write-AtProgress 'AT-ERROR domain_unreachable'
        exit 2
    }
    $DnsName = (($DomainDn -split ',') | Where-Object { $_ -match '^DC=' } | ForEach-Object { $_.Substring(3) }) -join '.'
    $BroadSids = @($BroadWellKnown) + @("$DomainSid-513", "$DomainSid-515")
    $NetBios = $null
    try {
        $Ref = @(Find-AtEntries "CN=Partitions,$ConfigDn" "(&(objectClass=crossRef)(nCName=$(ConvertTo-AtLdapValue $DomainDn)))" @('nETBIOSName') -Scope OneLevel)
        if ($Ref.Count -gt 0) { $NetBios = [string](Get-AtValue $Ref[0] 'netbiosname') }
    }
    catch { $NetBios = $null }

    # Pass 1: members of the Tier 0 groups, rights on the Tier 0 objects, GPOs.
    Write-AtProgress "pass 1/$Passes"
    $Targets = @($TargetRids | ForEach-Object { "$DomainSid-$_" }) + $BuiltinTargets
    foreach ($Hit in @(Find-AtEntries $DomainDn '(&(objectClass=group)(sAMAccountName=DnsAdmins))' $PrincipalProps)) {
        $Sid = Add-AtPrincipal $Hit
        if ($Sid) { $Targets += $Sid }
    }
    foreach ($T in $Targets) { if (Resolve-AtSid $T) { Expand-AtGroup $T } }
    foreach ($T in $Targets) { [void]$Tier0.Add($T) }
    foreach ($M in $Memberships) { [void]$Tier0.Add($M.member) }

    Add-AtObjectAces $DomainDn $null 'domainRoot' 1
    Add-AtObjectAces "CN=AdminSDHolder,CN=System,$DomainDn" $null 'adminSdHolder' 1
    Add-AtObjectAces "OU=Domain Controllers,$DomainDn" $null 'dcOu' 1
    try { $Gpos = Read-AtGpos }
    catch { Add-AtUnreadable "CN=Policies,CN=System,$DomainDn" (Get-AtReason $_); $Gpos = [ordered]@{} }

    # Pass n+1: rights on what pass n found, then members of new trustees.
    $Truncated = $false
    $SeenOus = New-Object System.Collections.Generic.HashSet[string]
    for ($Pass = 2; $Pass -le $Passes + 1; $Pass++) {
        $Frontier = @($NewPrincipals | Where-Object { $BroadSids -notcontains $_ })
        $NewPrincipals.Clear()
        if ($Frontier.Count -eq 0) { break }
        if ($Pass -gt $Passes) { $Truncated = $true; break }
        Write-AtProgress "pass $Pass/$Passes"
        Read-AtObjects @($Frontier | ForEach-Object { $Principals[$_].dn })
        foreach ($Sid in $Frontier) {
            $P = $Principals[$Sid]
            Add-AtObjectAces $P.dn $Sid $(if ($P.kind -eq 'group') { 'group' } else { 'account' }) $Pass
            # Full control of an OU above an object is control of the object.
            $Ou = Get-AtParentDn $P.dn
            while ($Ou -and $Ou.Length -gt $DomainDn.Length) {
                if ($Ou -match '^OU=' -and $Ou -ne "OU=Domain Controllers,$DomainDn" -and $SeenOus.Add($Ou.ToLowerInvariant())) {
                    Add-AtObjectAces $Ou $null 'ou' $Pass @('GenericAll', 'WriteDacl', 'WriteOwner')
                }
                $Ou = Get-AtParentDn $Ou
            }
        }
    }

    # Accounts the script did not read: analyze.js counts them as Tier 2.
    $Users = 0
    foreach ($Hit in @(Find-AtEntries $DomainDn '(&(objectCategory=person)(objectClass=user))' @('objectSid'))) {
        if (-not $Principals.Contains((ConvertTo-AtSid (Get-AtValue $Hit 'objectsid')))) { $Users++ }
    }
    $Computers = @($ComputerSids | Where-Object { -not $Principals.Contains($_) }).Count

    $Facts = [ordered]@{
        schema = 1
        domain = $DnsName
        domainSid = $DomainSid
        netbios = $NetBios
        collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        passes = $Passes
        truncated = $Truncated
        principals = @($Principals.Values)
        memberships = $Memberships.ToArray()
        aces = $Aces.ToArray()
        gpos = @($Gpos.Values | ForEach-Object { $_.Remove('Dn'); $_ })
        tier2Totals = [ordered]@{ users = $Users; computers = $Computers }
        unreadable = $Unreadable.ToArray()
    }
    if (-not $NetBios) { $Facts.Remove('netbios') }

    $Json = ConvertTo-Json -InputObject $Facts -Depth 10 -Compress
    [System.IO.File]::WriteAllText($OutFile, $Json, (New-Object System.Text.UTF8Encoding($true)))
    Write-AtProgress "done: $($Principals.Count) principals, $($Aces.Count) rights, $($Unreadable.Count) unreadable"
    exit 0
}
catch {
    [Console]::Error.WriteLine("$($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)")
    exit 1
}
