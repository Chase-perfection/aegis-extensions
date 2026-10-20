// The scan's network engine: ping sweep, reverse DNS, NetBIOS, TCP connect
// probes. Loaded with Add-Type -Path by network_scan.ps1, under Windows
// PowerShell 5.1, which compiles with the .NET Framework's C# 5 compiler: no
// string interpolation, no ?., no exception filters, no expression bodies.
//
// ADR 0015 (core, docs/decisions/0015-csharp-engines-report-failure.md): a
// failure is counted and returned with the first error seen, never swallowed.
// A host that does not answer is not a failure; a request that could not be
// sent is. Without the difference, a scan whose ICMP was blocked on this
// machine reported "0 hosts" and nothing else.
//
// Concurrency comes from async calls behind a SemaphoreSlim, not from
// Parallel.ForEach over blocking ones: the thread pool starts at one thread per
// core and adds about one a second, so 256 "parallel" blocking pings ran a
// handful at a time. Where .NET Framework only offers a blocking call (DNS,
// NetBIOS receive), the pool's minimum is raised to the fan-out first.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class NetworkScanner {

    public class PingResult {
        public string IP { get; set; }
        public long RoundtripMs { get; set; }
        // The reply's remaining TTL, 0 when the stack did not report it.
        public int Ttl { get; set; }
    }

    public class DnsResult {
        public string IP { get; set; }
        public string Hostname { get; set; }
    }

    public class NetBiosResult {
        public string IP { get; set; }
        public string Name { get; set; }
        // The adapter address the node reports, "AA:BB:CC:DD:EE:FF", or null.
        public string Mac { get; set; }
    }

    public class TcpResult {
        public string IP { get; set; }
        public int[] OpenPorts { get; set; }
    }

    /// <summary>What a batch did: its results, and how many requests could not even be made.</summary>
    public class Report<T> {
        public List<T> Results { get; set; }
        public int Sent { get; set; }
        public int Failed { get; set; }
        public int TimedOut { get; set; }
        public string FirstError { get; set; }
    }

    // A Report<T> under construction, shared by the workers of one batch.
    class Tally {
        public int Failed, TimedOut;
        public string FirstError;
        public void Fail(Exception ex) {
            Interlocked.Increment(ref Failed);
            Interlocked.CompareExchange(ref FirstError, Describe(ex), null);
        }
        public void Timeout() { Interlocked.Increment(ref TimedOut); }
        public Report<T> Into<T>(IEnumerable<T> results, int sent) {
            return new Report<T> { Results = results.ToList(), Sent = sent, Failed = Failed, TimedOut = TimedOut, FirstError = FirstError };
        }
    }

    static string Describe(Exception ex) {
        // PingException and friends wrap the Win32 error that says what happened.
        var inner = ex.InnerException ?? ex;
        return inner.GetType().Name + ": " + inner.Message;
    }

    static void EnsureThreads(int fanOut) {
        int worker, io;
        ThreadPool.GetMinThreads(out worker, out io);
        int wanted = fanOut + Environment.ProcessorCount;
        if (worker < wanted) ThreadPool.SetMinThreads(wanted, Math.Max(io, wanted));
    }

    // ---- Ping ------------------------------------------------------------------

    public static Report<PingResult> PingSweep(string[] ips, int timeoutMs, int concurrency) {
        return PingSweepAsync(ips, timeoutMs, concurrency).GetAwaiter().GetResult();
    }

    static async Task<Report<PingResult>> PingSweepAsync(string[] ips, int timeoutMs, int concurrency) {
        var alive = new ConcurrentBag<PingResult>();
        var tally = new Tally();
        using (var gate = new SemaphoreSlim(concurrency)) {
            var tasks = ips.Select(async ip => {
                await gate.WaitAsync().ConfigureAwait(false);
                try {
                    using (var ping = new Ping()) {
                        PingReply reply = await ping.SendPingAsync(ip, timeoutMs).ConfigureAwait(false);
                        // TimedOut, DestinationHostUnreachable...: a host that did
                        // not answer, which is what a sweep is for finding out.
                        if (reply.Status == IPStatus.Success) {
                            alive.Add(new PingResult {
                                IP = ip,
                                RoundtripMs = reply.RoundtripTime,
                                Ttl = reply.Options != null ? reply.Options.Ttl : 0
                            });
                        }
                    }
                } catch (Exception ex) {
                    tally.Fail(ex);
                } finally {
                    gate.Release();
                }
            }).ToArray();
            await Task.WhenAll(tasks).ConfigureAwait(false);
        }
        return tally.Into(alive, ips.Length);
    }

    /// <summary>
    /// The family a reply's TTL points to: hosts start at 64 (Linux, macOS,
    /// most Unix and embedded stacks), 128 (Windows) or 255 (routers, switches,
    /// printers), and each hop takes one off. A hint, never an identification.
    /// </summary>
    public static string OsHintFromTtl(int ttl) {
        if (ttl <= 0) return null;
        if (ttl <= 64) return "unix";
        if (ttl <= 128) return "windows";
        return "network";
    }

    // ---- Reverse DNS -------------------------------------------------------------

    /// <summary>
    /// PTR names, each lookup bounded by `timeoutMs`. GetHostEntry on an
    /// address does a reverse and then a forward lookup and has no timeout of
    /// its own, so one dead resolver used to hold the batch for minutes.
    /// </summary>
    public static Report<DnsResult> BatchReverseDns(string[] ips, int timeoutMs, int concurrency) {
        EnsureThreads(concurrency);
        return BatchReverseDnsAsync(ips, timeoutMs, concurrency).GetAwaiter().GetResult();
    }

    static async Task<Report<DnsResult>> BatchReverseDnsAsync(string[] ips, int timeoutMs, int concurrency) {
        var found = new ConcurrentBag<DnsResult>();
        var tally = new Tally();
        using (var gate = new SemaphoreSlim(concurrency)) {
            var tasks = ips.Select(async ip => {
                await gate.WaitAsync().ConfigureAwait(false);
                try {
                    Task<IPHostEntry> lookup = Dns.GetHostEntryAsync(ip);
                    Task first = await Task.WhenAny(lookup, Task.Delay(timeoutMs)).ConfigureAwait(false);
                    if (first != lookup) {
                        tally.Timeout();
                        // Observed later, so its exception is not left unobserved.
                        var ignored = lookup.ContinueWith(t => t.Exception, TaskContinuationOptions.OnlyOnFaulted);
                        return;
                    }
                    IPHostEntry entry = await lookup.ConfigureAwait(false);
                    if (!string.IsNullOrEmpty(entry.HostName) && entry.HostName != ip) {
                        found.Add(new DnsResult { IP = ip, Hostname = entry.HostName });
                    }
                } catch (SocketException se) {
                    // No PTR record is an answer, not a failure.
                    if (se.SocketErrorCode != SocketError.HostNotFound && se.SocketErrorCode != SocketError.NoData) tally.Fail(se);
                } catch (Exception ex) {
                    tally.Fail(ex);
                } finally {
                    gate.Release();
                }
            }).ToArray();
            await Task.WhenAll(tasks).ConfigureAwait(false);
        }
        return tally.Into(found, ips.Length);
    }

    // ---- NetBIOS -----------------------------------------------------------------

    // NBSTAT query for "*" (RFC 1002 4.2.17): header, the encoded wildcard name,
    // type NBSTAT (0x21), class IN.
    static readonly byte[] NodeStatusQuery = new byte[] {
        0x80, 0x94, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x20, 0x43, 0x4b, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
        0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
        0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x00, 0x00, 0x21,
        0x00, 0x01
    };

    public static Report<NetBiosResult> BatchNetBiosLookup(string[] ips, int timeoutMs, int concurrency) {
        EnsureThreads(concurrency);
        var found = new ConcurrentBag<NetBiosResult>();
        var tally = new Tally();
        Parallel.ForEach(ips, new ParallelOptions { MaxDegreeOfParallelism = concurrency }, ip => {
            try {
                byte[] response = QueryNodeStatus(ip, timeoutMs);
                if (response == null) return;
                NetBiosResult parsed = ParseNodeStatus(response);
                if (parsed != null) {
                    parsed.IP = ip;
                    found.Add(parsed);
                }
            } catch (Exception ex) {
                tally.Fail(ex);
            }
        });
        return tally.Into(found, ips.Length);
    }

    // The reply, or null when the host did not answer or someone else did.
    static byte[] QueryNodeStatus(string ip, int timeoutMs) {
        var target = IPAddress.Parse(ip);
        using (var client = new UdpClient()) {
            client.Client.SendTimeout = timeoutMs;
            client.Client.ReceiveTimeout = timeoutMs;
            client.Send(NodeStatusQuery, NodeStatusQuery.Length, new IPEndPoint(target, 137));
            var remote = new IPEndPoint(IPAddress.Any, 0);
            try {
                byte[] response = client.Receive(ref remote);
                return remote.Address.Equals(target) ? response : null;
            } catch (SocketException se) {
                // Silence, or an ICMP port unreachable reported back as a reset.
                if (se.SocketErrorCode == SocketError.TimedOut || se.SocketErrorCode == SocketError.ConnectionReset) return null;
                throw;
            }
        }
    }

    /// <summary>
    /// The machine name and adapter address in an NBSTAT reply (RFC 1002
    /// 4.2.18): the name count at byte 56, then 18 bytes per name (15 of name,
    /// one suffix, two flags whose top bit marks a group), then six bytes of
    /// unit ID, the MAC. The name is the unique &lt;00&gt; entry, else the
    /// unique &lt;20&gt; one; the first entry is often the workgroup, which is
    /// what the first version of this read.
    /// </summary>
    public static NetBiosResult ParseNodeStatus(byte[] response) {
        if (response == null || response.Length < 57) return null;
        int count = response[56];
        int namesEnd = 57 + count * 18;
        if (count == 0 || response.Length < namesEnd) return null;

        string workstation = null, server = null;
        for (int i = 0; i < count; i++) {
            int at = 57 + i * 18;
            byte suffix = response[at + 15];
            bool group = (response[at + 16] & 0x80) != 0;
            if (group) continue;
            string name = Encoding.ASCII.GetString(response, at, 15).TrimEnd(' ', '\0');
            if (name.Length == 0) continue;
            if (suffix == 0x00 && workstation == null) workstation = name;
            else if (suffix == 0x20 && server == null) server = name;
        }
        string chosen = workstation ?? server;
        if (chosen == null) return null;

        string mac = null;
        if (response.Length >= namesEnd + 6) {
            bool zero = true;
            var parts = new string[6];
            for (int i = 0; i < 6; i++) {
                byte b = response[namesEnd + i];
                if (b != 0) zero = false;
                parts[i] = b.ToString("X2");
            }
            // Samba and some embedded stacks report zeros: no address, not a real one.
            if (!zero) mac = string.Join(":", parts);
        }
        return new NetBiosResult { Name = chosen, Mac = mac };
    }

    // ---- TCP connect probes ------------------------------------------------------

    /// <summary>
    /// Which of `ports` accept a TCP connection on each address. Connect only,
    /// then close: no byte is sent and no banner is read. Opt-in per tenant, off
    /// by default, since it is active scanning an IDS may flag.
    /// </summary>
    public static Report<TcpResult> ProbeTcp(string[] ips, int[] ports, int timeoutMs, int concurrency) {
        return ProbeTcpAsync(ips, ports, timeoutMs, concurrency).GetAwaiter().GetResult();
    }

    static async Task<Report<TcpResult>> ProbeTcpAsync(string[] ips, int[] ports, int timeoutMs, int concurrency) {
        var open = new ConcurrentDictionary<string, ConcurrentBag<int>>();
        var tally = new Tally();
        var pairs = ips.SelectMany(ip => ports.Select(port => new KeyValuePair<string, int>(ip, port))).ToArray();
        using (var gate = new SemaphoreSlim(concurrency)) {
            var tasks = pairs.Select(async pair => {
                await gate.WaitAsync().ConfigureAwait(false);
                try {
                    if (await Connects(pair.Key, pair.Value, timeoutMs).ConfigureAwait(false)) {
                        open.GetOrAdd(pair.Key, _ => new ConcurrentBag<int>()).Add(pair.Value);
                    }
                } catch (Exception ex) {
                    tally.Fail(ex);
                } finally {
                    gate.Release();
                }
            }).ToArray();
            await Task.WhenAll(tasks).ConfigureAwait(false);
        }
        var results = open.Select(kv => new TcpResult { IP = kv.Key, OpenPorts = kv.Value.Distinct().OrderBy(p => p).ToArray() });
        return tally.Into(results, pairs.Length);
    }

    // True when the port accepted the connection; false when it refused, timed
    // out or the host was unreachable. Throws only for a local failure.
    static async Task<bool> Connects(string ip, int port, int timeoutMs) {
        using (var client = new TcpClient()) {
            Task connect = client.ConnectAsync(ip, port);
            Task first = await Task.WhenAny(connect, Task.Delay(timeoutMs)).ConfigureAwait(false);
            if (first != connect) {
                var ignored = connect.ContinueWith(t => t.Exception, TaskContinuationOptions.OnlyOnFaulted);
                return false;
            }
            try {
                await connect.ConfigureAwait(false);
                return true;
            } catch (SocketException se) {
                switch (se.SocketErrorCode) {
                    case SocketError.ConnectionRefused:
                    case SocketError.TimedOut:
                    case SocketError.HostUnreachable:
                    case SocketError.NetworkUnreachable:
                    case SocketError.HostDown:
                        return false;
                    default:
                        throw;
                }
            }
        }
    }
}
