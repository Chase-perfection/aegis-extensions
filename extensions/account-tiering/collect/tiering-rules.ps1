# The rules of collect-tiering.ps1 that need no directory: which SIDs count,
# which ACE masks are a right of the "Droits" table, how a GPO file adds
# members to a local group, and the helpers that read nothing. Dot-sourced
# by collect-tiering.ps1; kept apart so it can be loaded and checked without
# a domain.

$TargetRids = @(512, 516, 518, 519, 520, 526, 527)
$BuiltinTargets = @('S-1-5-32-544', 'S-1-5-32-548', 'S-1-5-32-549', 'S-1-5-32-550', 'S-1-5-32-551')
$IgnoredSids = @('S-1-5-18', 'S-1-5-9', 'S-1-5-10', 'S-1-3-0')
$BroadWellKnown = @('S-1-1-0', 'S-1-5-11', 'S-1-5-7', 'S-1-5-32-554')
$LocalGroupSids = @('S-1-5-32-544', 'S-1-5-32-555', 'S-1-5-32-580')

$EmptyGuid = '00000000-0000-0000-0000-000000000000'
$GuidResetPassword = '00299570-246d-11d0-a768-00aa006e0529'
$GuidMember = 'bf9679c0-0de6-11d0-a285-00aa003049e2'
$GuidGetChanges = '1131f6aa-9c07-11d1-f79f-00c04fc2dcd2'
$GuidGetChangesAll = '1131f6ad-9c07-11d1-f79f-00c04fc2dcd2'

function Write-AtProgress([string]$Text) {
    # Not Write-Output: inside a function that would become a return value.
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

function ConvertTo-AtSid($Bytes) {
    (New-Object System.Security.Principal.SecurityIdentifier([byte[]]$Bytes, 0)).Value
}

function Get-AtReason($ErrorRecord) {
    $E = $ErrorRecord.Exception
    while ($null -ne $E.InnerException) { $E = $E.InnerException }
    if ($E -is [System.UnauthorizedAccessException] -or $E.HResult -eq -2147024891) { return 'access_denied' }
    return 'read_failed'
}

function ConvertTo-AtLdapValue([string]$Value) {
    $Value.Replace('\', '\5c').Replace('*', '\2a').Replace('(', '\28').Replace(')', '\29').Replace([string][char]0, '\00')
}

function Get-AtParentDn([string]$Dn) {
    # The first comma that is not escaped ends the first RDN.
    if ($Dn -match '^(?:[^,\\]|\\.)*,(.+)$') { return $Matches[1] }
    return ''
}

function Get-AtAceRights([int]$Mask, [string]$ObjectType, [string]$Kind) {
    # The rights of the "Droits" table that this ACE grants on an object of
    # this kind. An empty ObjectType means every property or extended right.
    # The rights go out one by one, so call it inside @(): a returned empty
    # array would come back from @() as one element in Windows PowerShell 5.1.
    $Any = (-not $ObjectType -or $ObjectType -eq $EmptyGuid)
    $Out = New-Object System.Collections.Generic.List[string]
    # 0x10000000 is GENERIC_ALL left unmapped, 0xF01FF the mapped form.
    if ($Any -and (($Mask -band 0x10000000) -ne 0 -or ($Mask -band 0xF01FF) -eq 0xF01FF)) { return 'GenericAll' }
    if ($Mask -band 0x40000) { $Out.Add('WriteDacl') }
    if ($Mask -band 0x80000) { $Out.Add('WriteOwner') }
    if ($Kind -eq 'domainRoot') {
        # DCSync is two extended rights, emitted apart so that analyze.js can
        # tell a complete pair from half of one.
        if ($Mask -band 0x100) {
            if ($Any -or $ObjectType -eq $GuidGetChanges) { $Out.Add('DCSyncGetChanges') }
            if ($Any -or $ObjectType -eq $GuidGetChangesAll) { $Out.Add('DCSyncGetChangesAll') }
        }
        return $Out.ToArray()
    }
    # WriteProperty on every attribute is what GenericWrite gives.
    if ($Any -and (($Mask -band 0x40000000) -ne 0 -or ($Mask -band 0x20) -ne 0)) { $Out.Add('GenericWrite') }
    elseif (($Mask -band 0x28) -ne 0 -and ($Any -or $ObjectType -eq $GuidMember) -and @('group', 'adminSdHolder', 'ou') -contains $Kind) { $Out.Add('WriteMember') }
    if (($Mask -band 0x100) -ne 0 -and ($Any -or $ObjectType -eq $GuidResetPassword) -and @('account', 'adminSdHolder', 'ou') -contains $Kind) { $Out.Add('ResetPassword') }
    return $Out.ToArray()
}

function Read-AtGptTmpl([string]$Text) {
    # [Group Membership] of a security template: "<group>__Members = *SID,..."
    # adds members to a group, "<principal>__Memberof = *SID,..." adds the
    # principal to groups. Returns local group SID -> member SIDs or names.
    $Out = @{}
    $Section = [regex]::Match($Text, '(?ms)^\s*\[Group Membership\]\s*$(.*?)(?=^\s*\[|\z)')
    if (-not $Section.Success) { return $Out }
    foreach ($Line in ($Section.Groups[1].Value -split '\r?\n')) {
        if ($Line -notmatch '^\s*(.+?)__(Members|Memberof)\s*=\s*(.*)$') { continue }
        $Subject = $Matches[1].Trim(); $Verb = $Matches[2]
        $Values = @($Matches[3].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($V in $Values) {
            if ($Verb -eq 'Members') { $Group = $Subject; $Member = $V } else { $Group = $V; $Member = $Subject }
            $Group = $Group.TrimStart('*')
            if ($LocalGroupSids -notcontains $Group) { continue }
            if (-not $Out.ContainsKey($Group)) { $Out[$Group] = New-Object System.Collections.Generic.List[string] }
            $Out[$Group].Add([string]$Member)
        }
    }
    return $Out
}

function Read-AtGroupsXml([xml]$Doc) {
    # Group Policy Preferences, Local Users and Groups. Item-level targeting
    # is not evaluated, like security filters: it can only overstate.
    $Out = @{}
    foreach ($G in @($Doc.SelectNodes('//Group'))) {
        if ($G.GetAttribute('disabled') -eq '1') { continue }
        $Props = $G.SelectSingleNode('Properties')
        if ($null -eq $Props -or $Props.GetAttribute('action') -eq 'D') { continue }
        $Group = $Props.GetAttribute('groupSid')
        if ($LocalGroupSids -notcontains $Group) { continue }
        foreach ($M in @($Props.SelectNodes('Members/Member'))) {
            if ($M.GetAttribute('action') -ne 'ADD') { continue }
            $Value = if ($M.GetAttribute('sid')) { '*' + $M.GetAttribute('sid') } else { $M.GetAttribute('name') }
            if (-not $Value) { continue }
            if (-not $Out.ContainsKey($Group)) { $Out[$Group] = New-Object System.Collections.Generic.List[string] }
            $Out[$Group].Add([string]$Value)
        }
    }
    return $Out
}
