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
    [Parameter(Mandatory)][int]$TimeoutMs
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
$credential = New-Object System.Management.Automation.PSCredential(".\$AccountName", $securePassword)
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

# The Windows error behind a failed Process.Start, as the sentence an operator
# can act on. The raw message names neither the account nor the fix, and "Access
# is denied" alone has three unrelated causes on this path.
function Get-StartFailureHint {
    param([int]$Code)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    switch ($Code) {
        5 {
            if ($identity.IsSystem) {
                return "the Aegis backend runs as LocalSystem, and Windows refuses to start a process under another account from LocalSystem (CreateProcessWithLogonW). Run the backend service as a local administrator account instead."
            }
            return "Windows refused $AccountName access to $WorkspaceDir or to cmd.exe. Aegis resets the workspace permissions before each build, so run the Deploy host setup again to repair the account."
        }
        267 { return "$WorkspaceDir is not a folder $AccountName can open. Run the Deploy host setup again." }
        1326 { return "the password Aegis stored for $AccountName no longer matches the account. Run the Deploy host setup again: it resets both." }
        1327 { return "a policy on this host restricts how $AccountName may sign in (logon hours, workstations or blank password)." }
        1330 { return "the password of $AccountName has expired. Run the Deploy host setup again." }
        1331 { return "$AccountName is disabled. Enable it in Local Users and Groups, or run the Deploy host setup again." }
        1385 { return "$AccountName is not allowed the logon type a build needs. A security policy denies it local logon: check 'Deny log on locally' in the host's user rights." }
        1909 { return "$AccountName is locked out. Unlock it in Local Users and Groups." }
        1792 { return "the Secondary Logon service (seclogon) is stopped or disabled. Set it to Manual and start it." }
        default { return "run the Deploy host setup again; if it persists, the Windows error code above names the cause." }
    }
}

function Start-AsBuildAccount {
    param([System.Diagnostics.ProcessStartInfo]$StartInfo)
    try {
        return [System.Diagnostics.Process]::Start($StartInfo)
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

function Invoke-Capped {
    param([string]$Command, [string]$LogFile)
    if (-not $Command) { return }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = "/d /c `"$Command`" > `"$LogFile`" 2>&1"
    $psi.WorkingDirectory = $WorkspaceDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.LoadUserProfile = $false
    $psi.UserName = $credential.UserName
    $psi.Password = $credential.Password

    # Added last, so the project's own values win over anything inherited. The
    # names Aegis refuses on the way in (PATH, ComSpec, the AEGIS_ prefix) are
    # exactly the ones that would matter here: see projectEnv.js.
    # `Environment` and not `EnvironmentVariables`: the latter is a
    # StringDictionary, which lowercases every key it stores. Windows and Node
    # both read environment variables case-insensitively so it would mostly
    # work, and "mostly" is not what a build script reading API_TOKEN needs.
    foreach ($name in $buildEnv.Keys) {
        $psi.Environment[$name] = $buildEnv[$name]
    }

    $proc = Start-AsBuildAccount -StartInfo $psi
    [AegisBuild.JobObject]::AssignProcessToJobObject($job, $proc.Handle) | Out-Null

    $exited = $proc.WaitForExit($TimeoutMs)
    if (-not $exited) {
        [AegisBuild.JobObject]::TerminateJobObject($job, 1) | Out-Null
        throw "command timed out after ${TimeoutMs}ms: $Command"
    }
    if ($proc.ExitCode -ne 0) {
        throw "command exited $($proc.ExitCode): $Command (see $LogFile)"
    }
}

try {
    Invoke-Capped -Command $InstallCmd -LogFile (Join-Path $WorkspaceDir 'install.log')
    Invoke-Capped -Command $BuildCmd -LogFile (Join-Path $WorkspaceDir 'build.log')
    Write-Output 'OK'
} finally {
    [AegisBuild.JobObject]::TerminateJobObject($job, 0) | Out-Null
}
