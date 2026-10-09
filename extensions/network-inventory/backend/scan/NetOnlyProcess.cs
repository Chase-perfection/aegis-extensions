// Starts a process whose network accesses use another account, the way
// `runas /netonly` does. Loaded with Add-Type by Start-NetOnly.ps1.
//
// LOGON32_LOGON_NEW_CREDENTIALS gives a token that is the caller's own identity
// locally (same SID, same local rights, same desktop) and presents the given
// account to every remote server: DHCP RPC, LDAP, ADWS, DNS RPC, SMB. Nothing
// changes on this machine, so the backend service keeps running as it is and
// no restart is needed to switch the account the scan reads the network with.
//
// The logon itself does not check the password: Windows only tries it when a
// server asks. scanAccount.verify runs a network logon first for that reason.
//
// Why CreateProcessWithTokenW and not Process.Start with a user name: that one
// goes through CreateProcessWithLogonW, which cannot be called from LocalSystem,
// and LocalSystem is how an installed Aegis runs. CreateProcessWithTokenW needs
// SeImpersonatePrivilege, which LocalSystem, a service account and an elevated
// administrator all hold. The deploy extension's SandboxProcess.cs takes the
// same route for the same reason.

using System;
using System.Collections;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;

namespace AegisNetOnly {
    public static class NetOnlyProcess {
        const int LOGON32_LOGON_NEW_CREDENTIALS = 9;
        const int LOGON32_PROVIDER_WINNT50 = 3;
        const uint CREATE_SUSPENDED = 0x00000004;
        const uint CREATE_NO_WINDOW = 0x08000000;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const uint STARTF_USESTDHANDLES = 0x00000100;
        const uint INFINITE = 0xFFFFFFFF;
        const int STD_OUTPUT_HANDLE = -11;
        const int STD_ERROR_HANDLE = -12;
        const uint GENERIC_READ = 0x80000000;
        const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2;
        const uint OPEN_EXISTING = 3;
        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO {
            public int cb;
            public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
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
        struct IO_COUNTERS {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool LogonUserW(string user, string domain, IntPtr password, int logonType, int provider, out IntPtr token);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessWithTokenW(IntPtr token, int logonFlags, string app, StringBuilder cmdLine,
            uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr GetStdHandle(int which);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr process, uint code);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint ms);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out uint code);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);

        static Win32Exception Fail(string step) {
            int e = Marshal.GetLastWin32Error();
            return new Win32Exception(e, step + ": " + new Win32Exception(e).Message);
        }

        /// <summary>
        /// A job that kills what it holds when its last handle closes. The
        /// launcher keeps the handle for its whole life, so a launcher killed by
        /// the backend takes the scan down with it instead of leaving it running.
        /// </summary>
        static IntPtr KillOnCloseJob() {
            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Fail("could not create the Job Object");
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, size)) {
                var ex = Fail("could not configure the Job Object");
                CloseHandle(job);
                throw ex;
            }
            return job;
        }

        /// <summary>
        /// Runs `commandLine` with `user` (and `domain`, null for a UPN) as its
        /// network identity, with exactly `environment`, its stdout and stderr
        /// being this process's own so the caller reads them live. Waits for it
        /// and returns its exit code.
        ///
        /// Throws Win32Exception with the Windows error code and the step that
        /// refused: the logon (1326, 1331...) or the start (1314 when the caller
        /// lacks SeImpersonatePrivilege, 1058 when Secondary Logon is disabled).
        /// </summary>
        public static int Run(string user, string domain, SecureString password, string commandLine,
                              IDictionary environment) {
            IntPtr token = IntPtr.Zero, secret = IntPtr.Zero, env = IntPtr.Zero, job = IntPtr.Zero;
            IntPtr nul = INVALID_HANDLE_VALUE;
            var pi = new PROCESS_INFORMATION();
            // PowerShell hands a $null string argument over as "", and LogonUser
            // wants NULL, not empty, before it reads `user` as a UPN.
            if (string.IsNullOrEmpty(domain)) domain = null;
            try {
                nul = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
                if (nul == INVALID_HANDLE_VALUE) throw Fail("could not open NUL");

                secret = Marshal.SecureStringToGlobalAllocUnicode(password);
                if (!LogonUserW(user, domain, secret, LOGON32_LOGON_NEW_CREDENTIALS, LOGON32_PROVIDER_WINNT50, out token)) {
                    throw Fail("network logon refused");
                }
                Marshal.ZeroFreeGlobalAllocUnicode(secret);
                secret = IntPtr.Zero;

                job = KillOnCloseJob();
                env = EnvironmentBlock(environment);
                var si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                // Duplicated into the new process by the Secondary Logon
                // service, the way runas redirects: no handle inheritance needed.
                si.dwFlags = unchecked((int)STARTF_USESTDHANDLES);
                si.hStdInput = nul;
                si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
                si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
                if (!CreateProcessWithTokenW(token, 0, null, new StringBuilder(commandLine),
                        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out pi)) {
                    throw Fail("start refused");
                }

                // Before it runs: nothing it spawns can outlive the job.
                if (!AssignProcessToJobObject(job, pi.hProcess)) {
                    var ex = Fail("could not put the process in its Job Object");
                    TerminateProcess(pi.hProcess, 1);
                    throw ex;
                }
                if (ResumeThread(pi.hThread) == 0xFFFFFFFF) {
                    var ex = Fail("could not resume the process");
                    TerminateProcess(pi.hProcess, 1);
                    throw ex;
                }

                WaitForSingleObject(pi.hProcess, INFINITE);
                uint code;
                if (!GetExitCodeProcess(pi.hProcess, out code)) throw Fail("could not read the exit code");
                return unchecked((int)code);
            } finally {
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                if (secret != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(secret);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
                if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }

        /// <summary>"NAME=value\0...\0\0", sorted case-insensitively as Windows expects.</summary>
        static IntPtr EnvironmentBlock(IDictionary environment) {
            // Convert, not cast: a value PowerShell got from a cmdlet arrives
            // wrapped in a PSObject, and (string) on that throws.
            var pairs = new System.Collections.Generic.SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry kv in environment) pairs[Convert.ToString(kv.Key)] = Convert.ToString(kv.Value);
            var sb = new StringBuilder();
            foreach (var kv in pairs) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
            sb.Append('\0');
            return Marshal.StringToHGlobalUni(sb.ToString());
        }
    }
}
