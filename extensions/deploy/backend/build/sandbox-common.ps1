<#
What run-sandboxed-build.ps1 and runtime/run-sandboxed-server.ps1 share, dot-
sourced by both: the environment block a sandboxed process starts with, and the
sentence behind a Windows error that refused the start.

One file so that the two cannot drift. They did: the build was moved to
SandboxProcess.cs and given this environment in 0.2.5, the server launcher was
not, and every node or Python project failed to start with "Accès refusé" while
static sites deployed fine.
#>

# The Windows error behind a refused start, as the sentence an operator can act
# on. The raw message names neither the account nor the fix.
function Get-StartFailureHint {
    param([int]$Code, [string]$AccountName, [string]$WorkspaceDir)
    switch ($Code) {
        5 { return "Windows refused $AccountName access to $WorkspaceDir or to cmd.exe. Aegis grants the account its folders before each start, so run the Deploy host setup again to repair the account." }
        267 { return "$WorkspaceDir is not a folder $AccountName can open. Run the Deploy host setup again." }
        1314 { return "the account the Aegis backend runs as lacks 'Impersonate a client after authentication'. LocalSystem and administrators hold it: run the Aegis service as one of them." }
        1326 { return "the password Aegis stored for $AccountName no longer matches the account. Run the Deploy host setup again: it resets both." }
        1327 { return "a policy on this host restricts how $AccountName may sign in (logon hours, workstations or blank password)." }
        1330 { return "the password of $AccountName has expired. Run the Deploy host setup again." }
        1331 { return "$AccountName is disabled. Enable it in Local Users and Groups, or run the Deploy host setup again." }
        1385 { return "$AccountName is not granted 'Log on as a batch job', or a policy denies it. Run the Deploy host setup again, which grants it; if a domain policy owns that right on this host, add the account there." }
        1909 { return "$AccountName is locked out. Unlock it in Local Users and Groups." }
        1792 { return "the Secondary Logon service (seclogon) is stopped or disabled. Set it to Manual and start it." }
        default { return "run the Deploy host setup again; if it persists, the Windows error code above names the cause." }
    }
}

<#
The environment block a sandboxed process starts with. Built, not inherited as
is: what this process holds is the launcher's short list plus what Node and
pwsh add on their own, and three of those broke real builds.

- PATHEXT. The launcher does not pass it and pwsh then sets it to ".CPL", so cmd
  resolved no .exe and no .cmd: npm, node, python and git were all "not
  recognized". The machine's own value, from the registry.
- USERNAME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP. Node's libuv copies the
  backend's in when they are missing, so the process read the backend account's
  profile, which it cannot write: npm's cache and Python's temp files live
  there. They name the sandbox account and point into -HomeDir instead.
- PSExecutionPolicyPreference. pwsh sets it for -ExecutionPolicy Bypass, and a
  child inherits it, so any PowerShell a project script started ran unrestricted.

The project's values come last so they win. A PowerShell hashtable matches
names case-insensitively, as Windows does, and keeps the case the project wrote.
The names Aegis refuses on the way in (PATH, ComSpec, the AEGIS_ prefix) are
exactly the ones that would matter here: see projectEnv.js.
#>
function Get-SandboxEnvironment {
    param([string]$AccountName, [string]$HomeDir, [hashtable]$ProjectEnv)
    $environment = @{}
    foreach ($item in Get-ChildItem Env:) { $environment[$item.Name] = $item.Value }
    $environment.Remove('PSExecutionPolicyPreference')

    $pathExt = [Environment]::GetEnvironmentVariable('PATHEXT', 'Machine')
    if (-not $pathExt) { $pathExt = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC' }
    $environment['PATHEXT'] = $pathExt

    $environment['USERNAME'] = $AccountName
    $environment['USERDOMAIN'] = [Environment]::MachineName
    $environment['LOGONSERVER'] = '\\' + [Environment]::MachineName
    if ($HomeDir) {
        $roaming = Join-Path $HomeDir 'AppData\Roaming'
        $local = Join-Path $HomeDir 'AppData\Local'
        $temp = Join-Path $HomeDir 'Temp'
        foreach ($dir in $roaming, $local, $temp) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $qualifier = Split-Path $HomeDir -Qualifier
        $environment['USERPROFILE'] = $HomeDir
        $environment['HOMEDRIVE'] = $qualifier
        $environment['HOMEPATH'] = $HomeDir.Substring($qualifier.Length)
        $environment['APPDATA'] = $roaming
        $environment['LOCALAPPDATA'] = $local
        $environment['TEMP'] = $temp
        $environment['TMP'] = $temp
    }

    if ($ProjectEnv) {
        foreach ($name in $ProjectEnv.Keys) { $environment[$name] = $ProjectEnv[$name] }
    }
    return $environment
}

# Reads the project's variables from AEGIS_BUILD_ENV_JSON, then removes it from
# this process. A malformed blob stops the start: the alternative is a process
# that runs against defaults and serves a site pointing at nothing.
function Read-ProjectEnv {
    $projectEnv = @{}
    if ($env:AEGIS_BUILD_ENV_JSON) {
        try {
            $parsed = $env:AEGIS_BUILD_ENV_JSON | ConvertFrom-Json
        } catch {
            throw "AEGIS_BUILD_ENV_JSON is not valid JSON"
        }
        foreach ($property in $parsed.PSObject.Properties) {
            $projectEnv[$property.Name] = [string]$property.Value
        }
        Remove-Item Env:AEGIS_BUILD_ENV_JSON -ErrorAction SilentlyContinue
    }
    return $projectEnv
}

# Reads the account password from AEGIS_BUILD_ACCOUNT_SECRET, then removes it
# from this process so no child inherits it.
function Read-AccountSecret {
    $plainPassword = $env:AEGIS_BUILD_ACCOUNT_SECRET
    if (-not $plainPassword) { throw "AEGIS_BUILD_ACCOUNT_SECRET is not set" }
    $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
    $plainPassword = $null
    Remove-Item Env:AEGIS_BUILD_ACCOUNT_SECRET -ErrorAction SilentlyContinue
    return $securePassword
}

# The Win32 error code inside whatever SandboxProcess.Start threw, or 0.
function Get-Win32Code {
    param($Exception)
    $inner = $Exception
    while ($inner.InnerException -and -not ($inner -is [System.ComponentModel.Win32Exception])) { $inner = $inner.InnerException }
    if ($inner -is [System.ComponentModel.Win32Exception]) { return @($inner.NativeErrorCode, $inner.Message.Trim()) }
    return @(0, $Exception.Message.Trim())
}
