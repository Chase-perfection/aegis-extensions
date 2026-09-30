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

The process is started exactly as a build is, by SandboxProcess.cs: a batch
logon, a suspended start, the job, then resume, on a desktop of its own. It used
to be Process.Start with a password, which is CreateProcessWithLogonW: that
fails with "Accès refusé" when Aegis runs as LocalSystem, asks for the
interactive logon setup denies these accounts, and put the process on a desktop
it could not open. Every node and Python project failed to start on it.

The account's password arrives via AEGIS_BUILD_ACCOUNT_SECRET and the
application's variables via AEGIS_BUILD_ENV_JSON. Both are removed from this
process before the child starts, so neither is inherited and neither was ever a
command-line argument.

Output: the application writes to -LogFile (its own stdout and stderr handle),
and this script copies what lands there to its own stdout, which is how the
deployment console shows a crash on boot.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorkspaceDir,
    [Parameter(Mandatory)][string]$AccountName,
    [Parameter(Mandatory)][string]$StartCmd,
    # The account's writable profile for this process: TEMP, APPDATA, the
    # package caches, and the log. Beside `current/` and never inside it, which
    # the account can only read.
    [Parameter(Mandatory)][string]$HomeDir,
    [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'
# Read by Node as UTF-8. Without these, an error reaches the deployment console
# wrapped in ANSI colour codes and in the console code page.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }

. (Join-Path $PSScriptRoot '..\build\sandbox-common.ps1')
$securePassword = Read-AccountSecret
$appEnv = Read-ProjectEnv

if (-not $LogFile) { $LogFile = Join-Path $HomeDir 'server.log' }
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

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

Add-Type -Path (Join-Path $PSScriptRoot '..\build\SandboxProcess.cs')

# Defaults an application server needs when its output is a file and not a
# console, set before the project's values so the project can still override
# them. Python buffers stdout to a file, so a traceback on boot arrived after
# the health check had already given up; and it writes in the ANSI code page.
$defaults = @{ PYTHONUNBUFFERED = '1'; PYTHONIOENCODING = 'utf-8' }
foreach ($name in $defaults.Keys) { if (-not $appEnv.ContainsKey($name)) { $appEnv[$name] = $defaults[$name] } }
$environment = Get-SandboxEnvironment -AccountName $AccountName -HomeDir $HomeDir -ProjectEnv $appEnv

$cmdExe = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
$commandLine = "`"$cmdExe`" /d /s /c `"$StartCmd`""

try {
    $proc = [AegisSandbox.SandboxProcess]::Start($AccountName, $securePassword, $commandLine, $WorkspaceDir, $environment, $job, $LogFile)
} catch {
    $code, $message = Get-Win32Code $_.Exception
    $hint = Get-StartFailureHint -Code $code -AccountName $AccountName -WorkspaceDir $WorkspaceDir
    [Console]::Error.WriteLine("could not start the application as $AccountName (Windows error $code, $message): $hint")
    exit 3
}

# Copies what the application wrote since the last call to this script's stdout.
$reader = [System.IO.FileStream]::new($LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
$decoder = [System.Text.UTF8Encoding]::new($false).GetDecoder()
$buffer = [byte[]]::new(8192)
$chars = [char[]]::new(8193)
function Copy-NewOutput {
    while (($read = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $count = $decoder.GetChars($buffer, 0, $read, $chars, 0)
        if ($count -gt 0) { [Console]::Out.Write($chars, 0, $count); [Console]::Out.Flush() }
    }
}

try {
    # Waits for as long as the application runs. Aegis stops it by killing this
    # process, which closes the job handle and takes the application with it.
    while (-not $proc.Wait(250)) { Copy-NewOutput }
    Copy-NewOutput
    $exitCode = $proc.ExitCode
    [Console]::Error.WriteLine("the application exited with code $exitCode")
    exit $exitCode
} finally {
    $reader.Dispose()
    [AegisRuntime.JobObject]::TerminateJobObject($job, 0) | Out-Null
    $proc.Dispose()
}
