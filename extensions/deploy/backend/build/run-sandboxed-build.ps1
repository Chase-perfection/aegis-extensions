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

# The password and the project's variables, read once and removed from this
# process before any child starts. See sandbox-common.ps1.
. (Join-Path $PSScriptRoot 'sandbox-common.ps1')
$securePassword = Read-AccountSecret
$buildEnv = Read-ProjectEnv

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

function Start-AsBuildAccount {
    param([string]$CommandLine, [System.Collections.IDictionary]$Environment, [string]$LogFile)
    try {
        return [AegisSandbox.SandboxProcess]::Start($AccountName, $securePassword, $CommandLine, $WorkspaceDir, $Environment, $job, $LogFile)
    } catch {
        $code, $message = Get-Win32Code $_.Exception
        $hint = Get-StartFailureHint -Code $code -AccountName $AccountName -WorkspaceDir $WorkspaceDir
        # Exit 3, not a throw (which exits 1): the launcher reads 3 as "the
        # sandbox is broken, nothing of the project ran", which is what lets the
        # backend take this account out of the pool and retry on another.
        [Console]::Error.WriteLine("could not start the build as $AccountName (Windows error $code, $message): $hint")
        exit 3
    }
}

function Get-BuildEnvironment {
    return Get-SandboxEnvironment -AccountName $AccountName -HomeDir $HomeDir -ProjectEnv $buildEnv
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
