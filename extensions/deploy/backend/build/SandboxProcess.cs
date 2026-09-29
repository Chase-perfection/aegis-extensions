// Starts a process as a sandbox account, inside a Job Object before it runs a
// single instruction. Loaded with Add-Type by run-sandboxed-build.ps1.
//
// Why not Process.Start with a user name, which is what this replaces. That
// goes through CreateProcessWithLogonW, which (1) logs the account on
// interactively, and Create-BuildAccounts.ps1 denies these accounts
// interactive logon on purpose, so every build failed with 1385; (2) cannot be
// called from LocalSystem, which is how an installed Aegis runs; and (3) starts
// the process running, so whatever it spawned before AssignProcessToJobObject
// escaped the job's memory cap, process cap and kill.
//
// Here instead: LogonUser as a batch logon (setup grants "Log on as a batch
// job" and keeps both deny rights), CreateProcessWithTokenW suspended, assign
// to the job, resume. CreateProcessWithTokenW needs SeImpersonatePrivilege,
// which LocalSystem and an elevated administrator both hold, so the same code
// runs from the service and from a dashboard started by hand.

using System;
using System.Collections;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;

namespace AegisSandbox {
    public static class SandboxProcess {
        const int LOGON32_LOGON_BATCH = 4;
        const int LOGON32_PROVIDER_DEFAULT = 0;
        const uint CREATE_SUSPENDED = 0x00000004;
        const uint CREATE_NO_WINDOW = 0x08000000;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const uint WAIT_TIMEOUT = 0x00000102;
        const uint INFINITE = 0xFFFFFFFF;

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

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool LogonUserW(string user, string domain, IntPtr password, int logonType, int provider, out IntPtr token);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessWithTokenW(IntPtr token, int logonFlags, string app, StringBuilder cmdLine,
            uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

        const uint STARTF_USESTDHANDLES = 0x00000100;
        const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
        const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
        const uint CREATE_ALWAYS = 2, OPEN_EXISTING = 3;
        static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_ATTRIBUTES {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public bool bInheritHandle;
        }

        const uint WINSTA_ALL_ACCESS = 0x0000037F;
        const uint DESKTOP_ALL_ACCESS = 0x000F01FF;

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr GetProcessWindowStation();

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetProcessWindowStation(IntPtr winsta);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SECURITY_ATTRIBUTES sa);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, uint flags, uint access, ref SECURITY_ATTRIBUTES sa);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool CloseWindowStation(IntPtr winsta);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool CloseDesktop(IntPtr desktop);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, int revision, out IntPtr sd, IntPtr size);

        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr mem);

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

        /// <summary>A started, suspended-then-resumed process. Dispose closes its handles.</summary>
        public sealed class Started : IDisposable {
            internal IntPtr Process, Thread, WindowStation, Desktop;
            public int Id { get; internal set; }

            /// <summary>True when it exited within `ms`; false on timeout (the caller kills the job).</summary>
            public bool Wait(int ms) {
                return WaitForSingleObject(Process, ms < 0 ? INFINITE : (uint)ms) != WAIT_TIMEOUT;
            }

            public int ExitCode {
                get {
                    uint code;
                    if (!GetExitCodeProcess(Process, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    return unchecked((int)code);
                }
            }

            public void Dispose() {
                if (Thread != IntPtr.Zero) { CloseHandle(Thread); Thread = IntPtr.Zero; }
                if (Process != IntPtr.Zero) { CloseHandle(Process); Process = IntPtr.Zero; }
                if (Desktop != IntPtr.Zero) { CloseDesktop(Desktop); Desktop = IntPtr.Zero; }
                if (WindowStation != IntPtr.Zero) { CloseWindowStation(WindowStation); WindowStation = IntPtr.Zero; }
            }
        }

        /// <summary>
        /// A window station and desktop of the build's own, open to `sid`,
        /// SYSTEM and Administrators only.
        ///
        /// Without it the process lands on the backend service's desktop, which
        /// the build account cannot open. cmd's built-ins do not notice; any
        /// program that loads user32 (whoami, node, so npm) fails to initialise
        /// and waits on an error box nobody can see: the build hung until its
        /// timeout. A desktop of its own also keeps the build from sending
        /// window messages to anything the service runs.
        ///
        /// Named per account and not per build: the pool never runs two builds
        /// on one account, and CreateWindowStation opens an existing one.
        /// </summary>
        static void OwnDesktop(string user, string sid, out IntPtr winsta, out IntPtr desktop, out string name) {
            winsta = IntPtr.Zero; desktop = IntPtr.Zero;
            string station = "AegisBuild-" + user;
            IntPtr sd;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    "D:P(A;;GA;;;" + sid + ")(A;;GA;;;SY)(A;;GA;;;BA)", 1, out sd, IntPtr.Zero)) {
                int e = Marshal.GetLastWin32Error();
                throw new Win32Exception(e, "could not build the desktop's access list: " + new Win32Exception(e).Message);
            }
            IntPtr previous = GetProcessWindowStation();
            try {
                var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = sd };
                winsta = CreateWindowStationW(station, 0, WINSTA_ALL_ACCESS, ref sa);
                if (winsta == IntPtr.Zero) {
                    int e = Marshal.GetLastWin32Error();
                    throw new Win32Exception(e, "could not create the build's window station: " + new Win32Exception(e).Message);
                }
                // A desktop is created in the calling process's window station,
                // so this one is borrowed for the call and given straight back.
                if (!SetProcessWindowStation(winsta)) {
                    int e = Marshal.GetLastWin32Error();
                    throw new Win32Exception(e, "could not enter the build's window station: " + new Win32Exception(e).Message);
                }
                try {
                    desktop = CreateDesktopW("Default", IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_ALL_ACCESS, ref sa);
                    if (desktop == IntPtr.Zero) {
                        int e = Marshal.GetLastWin32Error();
                        throw new Win32Exception(e, "could not create the build's desktop: " + new Win32Exception(e).Message);
                    }
                } finally {
                    SetProcessWindowStation(previous);
                }
                name = station + "\\Default";
            } catch {
                if (desktop != IntPtr.Zero) { CloseDesktop(desktop); desktop = IntPtr.Zero; }
                if (winsta != IntPtr.Zero) { CloseWindowStation(winsta); winsta = IntPtr.Zero; }
                throw;
            } finally {
                LocalFree(sd);
            }
        }

        /// <summary>
        /// Starts `commandLine` as `user` on this machine, in `cwd`, with exactly
        /// `environment` (name -> value), already inside `job`, its stdout and
        /// stderr written to `logFile` and its stdin empty.
        ///
        /// The log is handed over as the process's own output handle, not left
        /// to a `> file` in the command line: cmd strips the first and last
        /// quote of `/c "cmd" > "file"`, which put the redirect inside a quoted
        /// string and wrote the output nowhere. The file is opened shared for
        /// reading, so builder.js can tail it while the build runs.
        ///
        /// Throws Win32Exception with the Windows error code, and a message that
        /// says which step refused: the logon (1326 password, 1385 logon right,
        /// 1331 disabled...) or the start (5 folder, 1314 caller right, 267 cwd).
        /// </summary>
        public static Started Start(string user, SecureString password, string commandLine, string cwd,
                                    IDictionary environment, IntPtr job, string logFile) {
            IntPtr token = IntPtr.Zero, secret = IntPtr.Zero, env = IntPtr.Zero;
            IntPtr log = INVALID_HANDLE_VALUE, nul = INVALID_HANDLE_VALUE;
            IntPtr winsta = IntPtr.Zero, desktop = IntPtr.Zero;
            var pi = new PROCESS_INFORMATION();
            try {
                log = CreateFileW(logFile, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, IntPtr.Zero, CREATE_ALWAYS, 0, IntPtr.Zero);
                if (log == INVALID_HANDLE_VALUE) {
                    int e = Marshal.GetLastWin32Error();
                    throw new Win32Exception(e, "could not open the log " + logFile + ": " + new Win32Exception(e).Message);
                }
                nul = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
                if (nul == INVALID_HANDLE_VALUE) {
                    int e = Marshal.GetLastWin32Error();
                    throw new Win32Exception(e, "could not open NUL: " + new Win32Exception(e).Message);
                }

                secret = Marshal.SecureStringToGlobalAllocUnicode(password);
                if (!LogonUserW(user, Environment.MachineName, secret, LOGON32_LOGON_BATCH, LOGON32_PROVIDER_DEFAULT, out token)) {
                    int e = Marshal.GetLastWin32Error();
                    throw new Win32Exception(e, "logon as a batch job refused: " + new Win32Exception(e).Message);
                }

                string sid;
                using (var identity = new System.Security.Principal.WindowsIdentity(token)) sid = identity.User.Value;
                string desktopName;
                OwnDesktop(user, sid, out winsta, out desktop, out desktopName);

                env = EnvironmentBlock(environment);
                var si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = desktopName;
                // Duplicated into the new process by the Secondary Logon
                // service, the way runas redirects: no handle inheritance needed.
                si.dwFlags = unchecked((int)STARTF_USESTDHANDLES);
                si.hStdInput = nul;
                si.hStdOutput = log;
                si.hStdError = log;
                if (!CreateProcessWithTokenW(token, 0, null, new StringBuilder(commandLine),
                        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, env, cwd, ref si, out pi)) {
                    int e = Marshal.GetLastWin32Error();
                    throw new Win32Exception(e, "start refused: " + new Win32Exception(e).Message);
                }

                // Before it runs: nothing it spawns can be outside the job.
                if (!AssignProcessToJobObject(job, pi.hProcess)) {
                    int e = Marshal.GetLastWin32Error();
                    TerminateProcess(pi.hProcess, 1);
                    throw new Win32Exception(e, "could not put the process in its Job Object: " + new Win32Exception(e).Message);
                }
                if (ResumeThread(pi.hThread) == 0xFFFFFFFF) {
                    int e = Marshal.GetLastWin32Error();
                    TerminateProcess(pi.hProcess, 1);
                    throw new Win32Exception(e, "could not resume the process: " + new Win32Exception(e).Message);
                }

                // The desktop lives as long as Started: the process is on it.
                var started = new Started { Process = pi.hProcess, Thread = pi.hThread, Id = pi.dwProcessId,
                                            WindowStation = winsta, Desktop = desktop };
                pi = new PROCESS_INFORMATION();   // ownership moved
                winsta = IntPtr.Zero; desktop = IntPtr.Zero;
                return started;
            } finally {
                if (desktop != IntPtr.Zero) CloseDesktop(desktop);
                if (winsta != IntPtr.Zero) CloseWindowStation(winsta);
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                if (secret != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(secret);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
                // Ours only: the process holds its own copies.
                if (log != INVALID_HANDLE_VALUE) CloseHandle(log);
                if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
            }
        }

        /// <summary>"NAME=value\0...\0\0", sorted case-insensitively as Windows expects.</summary>
        static IntPtr EnvironmentBlock(IDictionary environment) {
            // Convert, not cast: a value PowerShell got from a cmdlet (Join-Path)
            // arrives wrapped in a PSObject, and (string) on that throws.
            var pairs = new System.Collections.Generic.SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry kv in environment) pairs[Convert.ToString(kv.Key)] = Convert.ToString(kv.Value);
            var sb = new StringBuilder();
            foreach (var kv in pairs) {
                sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
            }
            sb.Append('\0');
            return Marshal.StringToHGlobalUni(sb.ToString());
        }
    }
}
