<#
Runs one long-lived application process as a restricted local account, inside a
Win32 Job Object that is killed outright when this script exits. No Docker, no
WSL2 -- the same isolation the build sandbox uses
(docs/superpowers/specs/2026-08-18-deploy-build-sandbox-design.md), with one
difference: there is no timeout. A server is meant to keep running, so this
script waits on it and Aegis stops it by killing this process.

That is the whole reason pwsh stays in the picture instead of Aegis starting the
application directly. The Job Object is set to KILL_ON_JOB_CLOSE and the handle
lives here, so whatever the application spawned dies with this script rather
than being orphaned under an account nobody looks at.

The account's password arrives via AEGIS_BUILD_ACCOUNT_SECRET and the
application's variables via AEGIS_BUILD_ENV_JSON. Both are removed from this
process before the child starts, so neither is inherited and neither was ever a
command-line argument.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorkspaceDir,
    [Parameter(Mandatory)][string]$AccountName,
    [Parameter(Mandatory)][string]$StartCmd
)

$ErrorActionPreference = 'Stop'

$plainPassword = $env:AEGIS_BUILD_ACCOUNT_SECRET
if (-not $plainPassword) { throw "AEGIS_BUILD_ACCOUNT_SECRET is not set" }
$securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential(".\$AccountName", $securePassword)
$plainPassword = $null
Remove-Item Env:AEGIS_BUILD_ACCOUNT_SECRET -ErrorAction SilentlyContinue

$appEnv = @{}
if ($env:AEGIS_BUILD_ENV_JSON) {
    try {
        $parsed = $env:AEGIS_BUILD_ENV_JSON | ConvertFrom-Json
    } catch {
        throw "AEGIS_BUILD_ENV_JSON is not valid JSON"
    }
    foreach ($property in $parsed.PSObject.Properties) {
        $appEnv[$property.Name] = [string]$property.Value
    }
    Remove-Item Env:AEGIS_BUILD_ENV_JSON -ErrorAction SilentlyContinue
}

# --- Job Object wrapper: the same one the build script uses. -----------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AegisRuntime {
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

# 16 processes and 1 GiB. Tighter than a build, which forks a dependency tree:
# a server is one process that may spawn a worker or two, and a cap it can reach
# is a cap that means something.
$job = [AegisRuntime.JobObject]::CreateCappedJob(16, 1GB)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = "/d /c `"$StartCmd`""
$psi.WorkingDirectory = $WorkspaceDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.LoadUserProfile = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UserName = $credential.UserName
$psi.Password = $credential.Password

# `Environment` and not `EnvironmentVariables`: the latter lowercases every key
# it stores, and an application reading DATABASE_URL needs the case it wrote.
foreach ($name in $appEnv.Keys) {
    $psi.Environment[$name] = $appEnv[$name]
}

$proc = [System.Diagnostics.Process]::Start($psi)
[AegisRuntime.JobObject]::AssignProcessToJobObject($job, $proc.Handle) | Out-Null

# Forwarded so the deployment console shows what the application printed while it
# was starting, which is where a crash on boot explains itself.
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()
Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
    if ($EventArgs.Data) { Write-Output $EventArgs.Data }
} | Out-Null
Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data) { Write-Output $EventArgs.Data }
} | Out-Null

try {
    # Waits for as long as the application runs. Aegis stops it by killing this
    # process, which closes the job handle and takes the application with it.
    $proc.WaitForExit()
    exit $proc.ExitCode
} finally {
    [AegisRuntime.JobObject]::TerminateJobObject($job, 0) | Out-Null
}
