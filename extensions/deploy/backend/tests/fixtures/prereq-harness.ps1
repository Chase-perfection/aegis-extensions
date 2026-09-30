# Drives Prerequisites.ps1 with a fake machine: no network, no installer, no admin.
param([Parameter(Mandatory = $true)][string]$Case)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\build\setup\Prerequisites.ps1')

$cache = Join-Path ([IO.Path]::GetTempPath()) ('aegis-prq-' + [guid]::NewGuid().ToString('N'))
$state = @{ installed = @{}; installerRan = $false; downloaded = $false }
$pins = @{
    python = @{ Version = '3.13.1'; File = 'python-test.exe'; Url = 'https://www.python.org/ftp/python/3.13.1/python-test.exe'; Sha256 = ('A' * 64) }
    node   = @{ Version = '22.9.0'; File = 'node-test.msi'; Url = 'https://nodejs.org/dist/v22.9.0/node-test.msi'; Sha256 = ('B' * 64) }
}

$find = { param($Id) if ($state.installed[$Id]) { [pscustomobject]@{ Path = "C:\Fake\$Id.exe"; Version = $pins[$Id].Version } } else { $null } }
$download = { param($Uri, $OutFile) $state.downloaded = $true; [IO.File]::WriteAllText($OutFile, 'not the installer') }
$install = { param($Id, $Installer) $state.installerRan = $true; $state.installed[$Id] = $true; 0 }
$quiet = { param($Message) }

switch ($Case) {
    'mismatch' {
        $results = Invoke-Prerequisites -Ids @('python') -Pins $pins -CacheDir $cache -Find $find -Download $download -Install $install -Say $quiet
    }
    'present' {
        $state.installed['python'] = $true
        $results = Invoke-Prerequisites -Ids @('python') -Pins $pins -CacheDir $cache -Find $find -Download $download -Install $install -Say $quiet
    }
    'continues' {
        $good = [IO.File]::ReadAllBytes($PSCommandPath)
        $pins.python.Sha256 = Get-Sha256 $PSCommandPath
        $download = { param($Uri, $OutFile) if ($Uri -like '*python*') { [IO.File]::WriteAllBytes($OutFile, $good) } else { [IO.File]::WriteAllText($OutFile, 'tampered') } }
        $results = Invoke-Prerequisites -Ids @('node', 'python') -Pins $pins -CacheDir $cache -Find $find -Download $download -Install $install -Say $quiet
    }
    'python1638' {
        $good = [IO.File]::ReadAllBytes($PSCommandPath)
        $pins.python.Sha256 = Get-Sha256 $PSCommandPath
        $download = { param($Uri, $OutFile) [IO.File]::WriteAllBytes($OutFile, $good) }
        $install = { param($Id, $Installer) $state.installed[$Id] = $true; 1638 }
        $results = Invoke-Prerequisites -Ids @('python') -Pins $pins -CacheDir $cache -Find $find -Download $download -Install $install -Say $quiet
    }
    'nopin' {
        $results = Invoke-Prerequisites -Ids @('pwsh') -Pins $pins -CacheDir $cache -Find $find -Download $download -Install $install -Say $quiet
    }
}

$left = (Test-Path -LiteralPath $cache) -and @(Get-ChildItem -LiteralPath $cache -File).Count -gt 0
Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
Write-Output (ConvertTo-Json -Compress -Depth 5 -InputObject @{
    results = @($results); leftOnDisk = $left; installerRan = $state.installerRan; downloaded = $state.downloaded
})
