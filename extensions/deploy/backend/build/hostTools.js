'use strict';
// The folders a build or a site should find its tools in, read when it starts.
//
// Why at spawn time: the Aegis service read its PATH when it booted, so a
// Python installed afterwards (by the prerequisites phase, or by hand) stayed
// invisible to every build until someone restarted the service. The machine
// PATH in the registry is what installers update, and it is current.
//
// The registered all-users Python folders are added too: an all-users Python
// installed without "add to PATH" is found by core's drawer, and a build has to
// agree with the drawer. A WindowsApps folder never counts: its python.exe is
// the Store's alias, present in every profile, and opens the Store when run.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const w = path.win32;
const ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const PY_KEY = 'HKLM\\SOFTWARE\\Python\\PythonCore';

/** `reg query` output as rows. Same parser as core's hostPrerequisites.js. */
function parseReg(text) {
    const rows = [];
    let key = null;
    for (const line of String(text || '').split(/\r?\n/)) {
        if (/^HKEY_/i.test(line)) { key = line.trim(); continue; }
        const m = /^\s+(.+?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/.exec(line);
        if (m && key) rows.push({ key, name: m[1].trim(), type: m[2], data: m[3].trim() });
    }
    return rows;
}

function expand(value, env) {
    return String(value).replace(/%([^%]+)%/g, (whole, name) => {
        const k = Object.keys(env || {}).find((x) => x.toLowerCase() === name.toLowerCase());
        return k ? env[k] : whole;
    });
}

const defaultIo = {
    reg: (args) => {
        try {
            return execFileSync('reg', ['query', ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (_) {
            return '';
        }
    },
    isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } },
    exists: (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } },
    env: process.env
};

function isStoreAlias(dir) { return /\\WindowsApps$/i.test(dir); }

/** Existing tool folders, most specific first, no duplicates, no WindowsApps. */
function toolDirs(io = defaultIo) {
    const dirs = [];
    for (const view of ['/reg:64', '/reg:32']) {
        for (const r of parseReg(io.reg([PY_KEY, '/s', view]))) {
            if (/\\InstallPath$/i.test(r.key) && r.name === 'ExecutablePath') {
                const dir = w.dirname(r.data);
                dirs.push(dir, w.join(dir, 'Scripts'));
            }
        }
    }
    const machine = parseReg(io.reg([ENV_KEY, '/v', 'Path']))[0];
    if (machine) dirs.push(...expand(machine.data, io.env).split(';'));

    const seen = new Set();
    const out = [];
    for (const raw of dirs) {
        const dir = String(raw).trim().replace(/[\\/]+$/, '');
        const k = dir.toLowerCase();
        if (!dir || seen.has(k) || isStoreAlias(dir) || !io.isDir(dir)) continue;
        seen.add(k);
        out.push(dir);
    }
    return out;
}

/** A copy of `env` with a single `Path`: the tool folders, then what it inherited. */
function withToolPath(env, dirs) {
    const out = Object.assign({}, env);
    const inherited = out.Path || out.PATH || '';
    delete out.PATH;
    delete out.Path;
    out.Path = [...(dirs || []), inherited].filter(Boolean).join(';');
    return out;
}

const COMMAND_TOOL = { python: 'python', py: 'python', pip: 'python', pip3: 'python', node: 'node', npm: 'node', npx: 'node', pnpm: 'node', yarn: 'node' };
const TOOL_EXE = { python: 'python.exe', node: 'node.exe' };

/**
 * The runtime ('python' or 'node') one of these commands needs and cannot
 * find on `dirs` plus the inherited PATH, or null.
 *
 * Only the first word of each `&&`, `||`, `;` or `|` segment is read: that is
 * the program cmd.exe will look for.
 */
function missingTool(commands, dirs, io = defaultIo) {
    const inherited = String(io.env.Path || io.env.PATH || '').split(';');
    const search = [...(dirs || []), ...inherited].map((d) => d.trim()).filter((d) => d && !isStoreAlias(d.replace(/[\\/]+$/, '')));
    for (const command of commands || []) {
        for (const segment of String(command || '').split(/&&|\|\||;|\|/)) {
            const first = segment.trim().split(/\s+/)[0].toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
            const tool = COMMAND_TOOL[first];
            if (!tool) continue;
            if (!search.some((d) => io.exists(w.join(d, TOOL_EXE[tool])))) return tool;
        }
    }
    return null;
}

module.exports = { toolDirs, withToolPath, missingTool, parseReg, expand };
