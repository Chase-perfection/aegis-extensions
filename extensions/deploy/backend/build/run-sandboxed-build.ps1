<#
Runs an install command then a build command as a restricted local account,
inside a Win32 Job Object that caps active process count and memory and is
killed outright on timeout. No Docker, no WSL2 -- see
docs/superpowers/specs/2026-08-18-deploy-build-sandbox-design.md.

The account's password arrives via the AEGIS_BUILD_ACCOUNT_SECRET
environment variable, never as a command-line argument (which would land in
a process listing) and never written to disk.

The project's own build variables arrive the same way, as a JSON object in
AEGIS_BUILD_ENV_JSON. Both variables are removed from this process before any
child starts, so the environment block a child inherits carries the project's
values and neither of the two Aegis used to deliver them.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorkspaceDir,
    [Parameter(Mandatory)][string]$AccountName,
    [string]$InstallCmd = '',
    # Optional: a project served by a process may need `npm ci` and no build at
    # all. Invoke-Capped skips an empty command.
    [string]$BuildCmd = '',
    [Parameter(Mandatory)][int]$TimeoutMs,
    # The build account's profile for this build: npm's cache, temp files.
    # Beside the workspace and never inside it, so a site served from `.` does
    # not publish it. Empty for the probe, which runs `exit 0` and needs none.
    [string]$HomeDir = ''
)

$ErrorActionPreference = 'Stop'
# What this script prints is read by Node as UTF-8 and shown in the build
# console. Without these two lines an error arrives wrapped in ANSI colour codes
# and in the console code page, so "Accès refusé" reads "Acc�s refus�".
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }

$plainPassword = $env:AEGIS_BUILD_ACCOUNT_SECRET
if (-not $plainPassword) { throw "AEGIS_BUILD_ACCOUNT_SECRET is not set" }
$securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
$plainPassword = $null
Remove-Item Env:AEGIS_BUILD_ACCOUNT_SECRET -ErrorAction SilentlyContinue

# The project's variables, read once and then removed from this process. A
# malformed blob stops the build: the alternative is a build that succeeds
# against defaults and publishes a site pointing at nothing.
$buildEnv = @{}
if ($env:AEGIS_BUILD_ENV_JSON) {
    try {
        $parsed = $env:AEGIS_BUILD_ENV_JSON | ConvertFrom-Json
    } catch {
        throw "AEGIS_BUILD_ENV_JSON is not valid JSON"
    }
    foreach ($property in $parsed.PSObject.Properties) {
        $buildEnv[$property.Name] = [string]$property.Value
    }
    Remove-Item Env:AEGIS_BUILD_ENV_JSON -ErrorAction SilentlyContinue
}

# --- Job Object wrapper: verified standalone before being embedded here. ---
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AegisBuild {
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public static class JobObject {
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
        public const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        public static IntPtr CreateCappedJob(int activeProcessLimit, ulong memoryLimitBytes) {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            info.BasicLimitInformation.ActiveProcessLimit = (uint)activeProcessLimit;
            info.ProcessMemoryLimit = (UIntPtr)memoryLimitBytes;

            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, size))
                throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());

            return job;
        }
    }
}
'@

# 64 processes (a package manager's install tree can fork many), 2 GiB -- both
# generous but real caps, so a runaway build cannot take the host down.
$job = [AegisBuild.JobObject]::CreateCappedJob(64, 2GB)

# Logon as a batch job, a suspended start and the Job Object before the first
# instruction: see SandboxProcess.cs for why Process.Start could not do this.
Add-Type -Path (Join-Path $PSScriptRoot 'SandboxProcess.cs')

# The Windows error behind a refused start, as the sentence an operator can act
# on. The raw message names neither the account nor the fix.
function Get-StartFailureHint {
    param([int]$Code)
    switch ($Code) {
        5 { return "Windows refused $AccountName access to $WorkspaceDir or to cmd.exe. Aegis resets the workspace permissions before each build, so run the Deploy host setup again to repair the account." }
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

function Start-AsBuildAccount {
    param([string]$CommandLine, [System.Collections.IDictionary]$Environment, [string]$LogFile)
    try {
        return [AegisSandbox.SandboxProcess]::Start($AccountName, $securePassword, $CommandLine, $WorkspaceDir, $Environment, $job, $LogFile)
    } catch {
        $inner = $_.Exception
        while ($inner.InnerException -and -not ($inner -is [System.ComponentModel.Win32Exception])) { $inner = $inner.InnerException }
        $code = if ($inner -is [System.ComponentModel.Win32Exception]) { $inner.NativeErrorCode } else { 0 }
        $hint = Get-StartFailureHint -Code $code
        # Exit 3, not a throw (which exits 1): the launcher reads 3 as "the
        # sandbox is broken, nothing of the project ran", which is what lets the
        # backend take this account out of the pool and retry on another.
        [Console]::Error.WriteLine("could not start the build as $AccountName (Windows error $code, $($inner.Message.Trim())): $hint")
        exit 3
    }
}

<#
The environment block the build starts with. Built, not inherited as is: what
this process holds is the launcher's short list plus what Node and pwsh add on
their own, and three of those broke real builds.

- PATHEXT. The launcher does not pass it and pwsh then sets it to ".CPL", so cmd
  resolved no .exe and no .cmd: npm, node and git were all "not recognized".
  The machine's own value, from the registry.
- USERNAME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP. Node's libuv copies the
  backend's in when they are missing, so the build read the backend account's
  profile, which it cannot write: npm's cache lives there. They name the build
  account and point into -HomeDir instead.
- PSExecutionPolicyPreference. pwsh sets it for -ExecutionPolicy Bypass, and a
  child inherits it, so any PowerShell a build script started ran unrestricted.

The project's values come last so they win. A PowerShell hashtable matches
names case-insensitively, as Windows does, and keeps the case the project wrote.
The names Aegis refuses on the way in (PATH, ComSpec, the AEGIS_ prefix) are
exactly the ones that would matter here: see projectEnv.js.
#>
function Get-BuildEnvironment {
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

    foreach ($name in $buildEnv.Keys) { $environment[$name] = $buildEnv[$name] }
    return $environment
}

function Invoke-Capped {
    param([string]$Command, [string]$LogFile)
    if (-not $Command) { return }

    # /s: cmd strips exactly the outer pair of quotes and runs what is inside
    # as typed, so `npm ci && npm run build` stays one command line. The output
    # goes to $LogFile as the process's own handle, not through a redirect.
    $cmdExe = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    $commandLine = "`"$cmdExe`" /d /s /c `"$Command`""

    $environment = Get-BuildEnvironment

    $proc = Start-AsBuildAccount -CommandLine $commandLine -Environment $environment -LogFile $LogFile
    try {
        if (-not $proc.Wait($TimeoutMs)) {
            [AegisBuild.JobObject]::TerminateJobObject($job, 1) | Out-Null
            throw "command timed out after ${TimeoutMs}ms: $Command"
        }
        if ($proc.ExitCode -ne 0) {
            throw "command exited $($proc.ExitCode): $Command (see $LogFile)"
        }
    } finally {
        $proc.Dispose()
    }
}

try {
    Invoke-Capped -Command $InstallCmd -LogFile (Join-Path $WorkspaceDir 'install.log')
    Invoke-Capped -Command $BuildCmd -LogFile (Join-Path $WorkspaceDir 'build.log')
    Write-Output 'OK'
} finally {
    [AegisBuild.JobObject]::TerminateJobObject($job, 0) | Out-Null
}
