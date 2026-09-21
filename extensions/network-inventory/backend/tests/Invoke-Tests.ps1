#requires -Version 7.4
<#
.SYNOPSIS
    Run every *.tests.ps1 in this folder. No external module required.
.DESCRIPTION
    Pester 5 is not installed and shield/CLAUDE.md forbids installing modules
    without approval, so this is the whole framework: three assertions, a case
    registry, and an exit code. Tests dot-source shield/src/**, never the built
    artefact, so they run on a machine with no domain and no elevation.
.PARAMETER Filter
    Run only test files whose name matches this wildcard.
#>
param([string]$Filter = '*')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Passed = 0
$script:Failed = 0
$script:Current = ''

function Format-Value {
    param($Value)
    if ($null -eq $Value) { return '<null>' }
    if ($Value -is [string]) { return "'$Value'" }
    if ($Value -is [System.Collections.IEnumerable]) {
        return '@(' + (($Value | ForEach-Object { Format-Value $_ }) -join ', ') + ')'
    }
    return "$Value"
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Because = '')
    $Same = if (($Expected -is [System.Collections.IEnumerable]) -and ($Expected -isnot [string])) {
        $E = @($Expected); $A = @($Actual)
        if ($E.Count -ne $A.Count) { $false }
        # The empty case is separate on purpose: 0..(-1) yields @(0, -1) in
        # PowerShell, and indexing an empty array under StrictMode throws
        # "Index was outside the bounds of the array". Assert-Equal @() is the
        # most-used assertion in this suite, so that crash would surface as a
        # failing test with a meaningless message.
        elseif ($E.Count -eq 0)    { $true }
        else { @(0..($E.Count - 1) | Where-Object { $E[$_] -ne $A[$_] }).Count -eq 0 }
    } else { $Expected -eq $Actual }
    if (-not $Same) {
        throw "expected $(Format-Value $Expected), got $(Format-Value $Actual)$(if ($Because) { ", $Because" })"
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Because = '')
    if (-not $Condition) { throw "expected true$(if ($Because) { " — $Because" })" }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$MessageLike = '*')
    $Caught = $null
    try { & $Action } catch { $Caught = $_ }
    if ($null -eq $Caught) { throw 'expected an exception, none was thrown' }
    if ($Caught.Exception.Message -notlike "*$MessageLike*") {
        throw "expected message like '$MessageLike', got '$($Caught.Exception.Message)'"
    }
}

function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:Passed++
        Write-Host "  PASS $Name" -ForegroundColor Green
    }
    catch {
        $script:Failed++
        Write-Host "  FAIL $Name" -ForegroundColor Red
        Write-Host "       $($_.Exception.Message)" -ForegroundColor DarkRed
    }
}

$Here  = $PSScriptRoot
$Files = @(Get-ChildItem -Path $Here -Filter '*.tests.ps1' -File | Sort-Object Name |
    # A test file is called <topic>.tests.ps1, so its BaseName is "<topic>.tests".
    # -Filter evidence must find evidence.tests.ps1: match the topic too, not
    # only the whole BaseName.
    Where-Object { $_.BaseName -like $Filter -or ($_.BaseName -replace '\.tests$', '') -like $Filter })

if ($Files.Count -eq 0) { Write-Host "No test file matched '$Filter'." -ForegroundColor Yellow; exit 1 }

foreach ($File in $Files) {
    Write-Host $File.Name -ForegroundColor Cyan
    $script:Current = $File.Name
    . $File.FullName
}

Write-Host ''
Write-Host "$script:Passed passed, $script:Failed failed" -ForegroundColor $(if ($script:Failed) { 'Red' } else { 'Green' })
if ($script:Failed -gt 0) { exit 1 }
exit 0
