/**
 * Runs the collector and turns whatever happens into facts or one error code.
 *
 * The collector is `collect/collect-tiering.ps1`, run by `powershell.exe`
 * (Windows PowerShell 5.1, the version every Windows server has). It writes its
 * facts to `-OutFile` as UTF-8 with a BOM, because 5.1's `Out-File -Encoding
 * UTF8` always writes one, and the BOM is stripped here before `JSON.parse`.
 *
 * The collector says what went wrong with a fixed line, `AT-ERROR <code>`, on
 * stdout, never a translated message: the page translates the code. Other
 * stdout lines are progress and go to `onLine`, which the routes hand to
 * `broadcastLog`.
 *
 * The codes, checked in this order:
 * - `powershell_missing`: the executable is not there (ENOENT on spawn);
 * - `scan_timeout`: the run passed `timeoutMs` and was killed;
 * - `collector_blocked`: the antivirus refused the script. AMSI's refusal
 *   carries the error id `ScriptContainedMaliciousContent` whatever the
 *   language of the host, so that id is what is matched, never the French
 *   or English sentence around it;
 * - the code of an `AT-ERROR` line, when it is one of `COLLECTOR_CODES`;
 * - `domain_unreachable`: exit code 2, the collector's own convention;
 * - `collector_failed`: any other non-zero exit, or facts that do not parse.
 *
 * `command` exists for the tests, which run a Node script in place of
 * PowerShell so the suite needs neither Windows PowerShell nor a domain.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'collect', 'collect-tiering.ps1');
const TIMEOUT_MS = 10 * 60 * 1000;
const COLLECTOR_CODES = new Set(['domain_unreachable', 'collector_blocked']);
const AMSI_ID = 'ScriptContainedMaliciousContent';
const MAX_LINE = 64 * 1024;

const POWERSHELL = {
    exe: 'powershell.exe',
    prefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH]
};

function runCollector({ domain, passes, outFile, onLine = () => {}, timeoutMs = TIMEOUT_MS, command = POWERSHELL }) {
    const args = [...command.prefix, '-Passes', String(passes), '-OutFile', outFile];
    if (domain) args.push('-Domain', domain);

    return new Promise((resolve) => {
        let reported = null;
        let pending = '';
        const lines = (chunk) => {
            pending += chunk;
            const parts = pending.split(/\r?\n/);
            // A collector that never ends its line must not grow this buffer
            // without bound: past MAX_LINE the rest of the line is dropped.
            pending = parts.pop().slice(0, MAX_LINE);
            for (const raw of parts) line(raw.trim());
        };
        const line = (text) => {
            if (!text) return;
            const match = /^AT-ERROR ([a-z_]{1,40})$/.exec(text);
            if (match) {
                if (!reported && COLLECTOR_CODES.has(match[1])) reported = match[1];
                return;
            }
            onLine(text);
        };

        const child = execFile(command.exe, args, {
            timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
            line(pending.trim());
            // The facts file is the whole directory graph: it goes on every
            // path, a timeout or a refusal included, before the caller hears
            // the outcome.
            outcome(error, `${stdout}\n${stderr}`)
                .catch(() => ({ ok: false, code: 'collector_failed' }))
                .then((result) => fs.promises.rm(outFile, { force: true }).catch(() => {}).then(() => resolve(result)));
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', lines);

        async function outcome(error, output) {
            if (error && error.code === 'ENOENT') return { ok: false, code: 'powershell_missing' };
            // A maxBuffer overflow kills the child too; it is not a timeout.
            if (error && error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ok: false, code: 'scan_timeout' };
            if (output.includes(AMSI_ID)) return { ok: false, code: 'collector_blocked' };
            if (reported) return { ok: false, code: reported };
            if (error && error.code === 2) return { ok: false, code: 'domain_unreachable' };
            if (error) return { ok: false, code: 'collector_failed' };
            return readFacts(outFile);
        }
    });
}

async function readFacts(outFile) {
    try {
        const facts = JSON.parse((await fs.promises.readFile(outFile, 'utf8')).replace(/^﻿/, ''));
        const partial = Array.isArray(facts.unreadable) && facts.unreadable.length > 0;
        return { ok: true, status: partial ? 'partial' : 'ok', facts };
    } catch (_) {
        return { ok: false, code: 'collector_failed' };
    }
}

module.exports = { runCollector, SCRIPT_PATH, TIMEOUT_MS };
