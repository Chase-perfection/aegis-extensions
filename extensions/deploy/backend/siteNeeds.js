'use strict';

const fs = require('fs');
const path = require('path');
const detectProject = require('./detectProject');
const { requirementName, PACKAGING_ONLY } = require('./build/autofix');

/**
 * What a site served by a process declares it needs, when nothing installs it.
 *
 * Two kinds of need, and two owners. What Deploy itself needs on the server
 * (git, Python, Node) is Deploy's job: its prerequisites are listed in
 * `extension.json` and the store drawer installs them. What one site needs to
 * run (openpyxl for KPI, express for a Node app) is that site's business, and
 * installing it is a decision about that site, so it is asked, not assumed.
 *
 * The case this exists for: a branch whose start command is
 * `python packaging/api/kpi_api.py`, with its `requirements.txt` beside the
 * script and no install command anywhere. Detection at creation only reads the
 * root of the branch, so nothing ran pip, the build passed, the publish passed,
 * and the process died on its first import with ModuleNotFoundError. The
 * operator read a Python traceback about a package the branch had declared all
 * along.
 *
 * So the question is asked before anything is published, with the answer
 * already worked out: which file, which packages, and the install command
 * Deploy would run. The version on the port keeps serving while it waits.
 *
 * Only an empty install command is questioned. A project that has one, typed
 * or declared in `aegis.deploy.json`, has already answered, and second-guessing
 * a command somebody wrote is how a correct deployment gets refused.
 */

/** `python`, `python3`, `python3.13`, `py`, with or without `.exe`. */
const PYTHON_EXE = /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i;
/** `node`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, with or without `.exe`/`.cmd`. */
const NODE_EXE = /^(?:node|npm|npx|pnpm|yarn|bun)(?:\.exe|\.cmd)?$/i;

/** How many package names the question spells out before it says "and N more". */
const NAMED_MAX = 6;

/**
 * The words of a command line, quotes removed. Not a shell parser: it only has
 * to find the program and its first file argument, and both are plain tokens
 * in every start command this has met.
 */
function words(cmd) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(String(cmd || '')))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
}

function program(word) {
    return path.basename(String(word || '').replace(/\\/g, '/'));
}

/**
 * The folder the start command runs code from, relative to the site root, or
 * '' for the root itself. `python packaging/api/kpi_api.py` gives
 * `packaging/api`; `python -m app` and anything unrecognised give the root.
 */
function scriptDir(args) {
    for (const a of args) {
        if (a.startsWith('-')) {
            if (a === '-m' || a === '-c') return '';
            continue;
        }
        if (/\.(?:py|js|mjs|cjs)$/i.test(a)) {
            const dir = path.posix.dirname(a.replace(/\\/g, '/'));
            return dir === '.' ? '' : dir;
        }
        return '';
    }
    return '';
}

/**
 * Folders from `rel` up to the root, nearest first, each one checked to stay
 * inside `root`. A start command naming `../../elsewhere/app.py` yields only
 * the root: the folders it points at are not this site's.
 */
function upFrom(root, rel) {
    const dirs = [];
    let at = rel;
    for (;;) {
        const full = path.resolve(root, at);
        const inside = path.relative(root, full);
        if (!inside.startsWith('..') && !path.isAbsolute(inside)) dirs.push(at);
        if (!at) break;
        const up = path.posix.dirname(at);
        at = up === '.' ? '' : up;
    }
    if (!dirs.includes('')) dirs.push('');
    return dirs;
}

function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** A path for a command line: forward slashes, quoted when it has a space. */
function arg(rel) {
    const p = rel.replace(/\\/g, '/');
    return /\s/.test(p) ? `"${p}"` : p;
}

/**
 * Package names a requirements file installs at run time.
 *
 * The packaging-only ones (`pyinstaller` and its kind) are left out, as the
 * build drops them: a question about installing PyInstaller to run a server
 * would be a question about nothing. `-r other.txt` and `-e .` cannot be named,
 * so they count as "something" without adding a name.
 */
function pythonPackages(text) {
    const names = [];
    let opaque = false;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.split('#')[0].trim();
        if (!line) continue;
        if (/^(?:-r|--requirement|-e|--editable|-c|--constraint)\b/.test(line)) {
            opaque = true;
            continue;
        }
        const name = requirementName(line);
        if (name && !PACKAGING_ONLY.has(name) && !names.includes(name)) names.push(name);
    }
    return { names, opaque };
}

function python(root, args) {
    for (const dir of upFrom(root, scriptDir(args))) {
        const rel = dir ? `${dir}/${detectProject.PY_REQUIREMENTS}` : detectProject.PY_REQUIREMENTS;
        const full = path.join(root, rel);
        if (!isFile(full)) continue;
        let text;
        try {
            text = fs.readFileSync(full, 'utf8');
        } catch {
            return null;
        }
        const { names, opaque } = pythonPackages(text);
        if (!names.length && !opaque) return null;      // only PyInstaller, or empty
        return {
            kind: 'python',
            file: rel,
            packages: names,
            // `--target .` and `python -m pip` for the reasons detectProject.js
            // gives. `.` is the site root, which runtime.js puts first on
            // PYTHONPATH, so a script in a subfolder imports what lands there.
            installCmd: `python -m pip install --no-cache-dir -r ${arg(rel)} --target .`
        };
    }
    return null;
}

function node(root, args) {
    for (const dir of upFrom(root, scriptDir(args))) {
        const base = dir ? path.join(root, dir) : root;
        const pkgFile = path.join(base, 'package.json');
        if (!isFile(pkgFile)) continue;
        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        } catch {
            return null;          // a package.json nobody can read: not ours to guess at
        }
        const deps = pkg && typeof pkg.dependencies === 'object' && pkg.dependencies
            ? Object.keys(pkg.dependencies) : [];
        if (!deps.length) return null;
        // Committed node_modules: the branch ships what it needs.
        if (fs.existsSync(path.join(base, 'node_modules'))) return null;

        let entries = [];
        try {
            entries = fs.readdirSync(base);
        } catch { /* empty is fine: npm install without a lockfile */ }
        const install = detectProject.detect(entries, pkg).installCmd;
        if (!install) return null;
        return {
            kind: 'node',
            file: dir ? `${dir}/package.json` : 'package.json',
            packages: deps,
            installCmd: dir ? `cd ${arg(dir)} && ${install}` : install
        };
    }
    return null;
}

/**
 * What the site at `root` needs and nothing installs, or null.
 *
 * `root` is the folder about to be served (the branch, or its `rootDir`).
 * `startCmd` is the project's start command; a project without one is served
 * as files and runs nothing, so it needs nothing. `installCmd` is the one that
 * will run; any non-empty value means the question has been answered.
 */
function find({ root, startCmd, installCmd }) {
    if (!startCmd || String(installCmd || '').trim()) return null;
    const [first, ...rest] = words(startCmd);
    const exe = program(first);
    if (PYTHON_EXE.test(exe)) return python(root, rest);
    if (NODE_EXE.test(exe)) return node(root, rest);
    return null;
}

/** "openpyxl", "openpyxl, requests", or the first six "and 3 more". */
function packageList(packages, more) {
    const list = Array.isArray(packages) ? packages : [];
    if (list.length <= NAMED_MAX) return list.join(', ');
    return `${list.slice(0, NAMED_MAX).join(', ')} ${more.replace('$1', list.length - NAMED_MAX)}`;
}

/** The console line, in the words the page asks the question in. */
function sentence(needs) {
    const what = needs.packages.length
        ? packageList(needs.packages, 'and $1 more')
        : `what ${needs.file} lists`;
    return `This site needs ${what} to run (${needs.file}), and nothing installs it: `
        + 'the project has no install command. Nothing was published; the version that was '
        + 'serving still is. Answer on the project page: Yes installs it with\n'
        + `  ${needs.installCmd}\n`
        + 'on this deployment and every one after. Or declare installCmd in aegis.deploy.json.\n';
}

module.exports = { find, sentence, packageList, words, scriptDir, pythonPackages, NAMED_MAX };
