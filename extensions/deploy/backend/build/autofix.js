'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Packages whose only job is to turn a Python project into a standalone
 * executable. Nothing imports them at run time: they are invoked as a command
 * to produce a `.exe`, and that `.exe` is what ships. A project Deploy serves
 * as a process never runs that step, so installing them costs a large download
 * on every single deployment and buys nothing.
 *
 * The list is deliberately short. A name earns a place here only if a running
 * application cannot plausibly import it. Anything arguable -- test runners,
 * linters, type checkers -- stays out: a project is allowed to run its own
 * tests as its build step, and guessing wrong there breaks the build instead of
 * saving a download.
 *
 * Names are stored normalised (PEP 503: lowercase, runs of `-_.` collapsed to
 * a single `-`) so `cx_Freeze`, `cx-freeze` and `CX.Freeze` all match.
 */
const PACKAGING_ONLY = new Set([
    'pyinstaller',
    'cx-freeze',
    'py2exe',
    'py2app',
    'nuitka',
    'auto-py-to-exe',
    'pyoxidizer'
]);

function normalise(name) {
    return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * The requirement files this install command actually reads, in the order it
 * names them. Parsing `installCmd` rather than globbing for `requirements*.txt`
 * is the whole point: a repository may carry several, and the only one Deploy
 * has any business touching is the one being installed.
 */
function requirementFiles(installCmd) {
    const files = [];
    const re = /(?:^|\s)(?:-r|--requirement)(?:[=\s]+)("[^"]+"|'[^']+'|\S+)/g;
    let m;
    while ((m = re.exec(String(installCmd || '')))) {
        files.push(m[1].replace(/^["']|["']$/g, ''));
    }
    return files;
}

/**
 * The distribution a requirement line names, or null when the line names none.
 *
 * Returns null for comments, blanks, and anything starting with `-`: `-e .`,
 * `-r other.txt` and bare flags are all lines this module must leave alone,
 * since it cannot tell what they pull in.
 */
function requirementName(line) {
    const bare = String(line).split('#')[0].trim();
    if (!bare || bare.startsWith('-')) return null;
    const token = bare.split(/[\s<>=!~;[\]()@]/)[0];
    return token ? normalise(token) : null;
}

/**
 * Whether the build command invokes this packaging tool. This is the necessity
 * test, and it is what keeps the rule from breaking a project that legitimately
 * builds an executable: if `buildCmd` runs PyInstaller, PyInstaller has to be
 * installed, and the dependency stays.
 *
 * Both spellings are checked because the command a tool installs rarely matches
 * its distribution name (`cx-freeze` ships `cxfreeze`).
 */
function namedInBuild(name, buildCmd) {
    if (!buildCmd) return false;
    const hay = normalise(buildCmd);
    return hay.includes(name) || hay.includes(name.replace(/-/g, ''));
}

/**
 * Comments out packaging-only dependencies in the build copy of a project.
 *
 * `workspace` is the throwaway copy builder.js makes for this one build. It is
 * wiped before the next build of any project, and the repository, the staging
 * clone and the served `current` directory are all untouched, so this rewrite
 * cannot outlive the build that needed it. That is what makes applying it
 * without asking defensible: the decision is recomputed from the real files
 * every time, and a rule that stops being right stops applying on the next
 * deployment rather than leaving damage behind.
 *
 * The lines are commented rather than deleted so the operator reading the
 * workspace sees what happened and why, and returned so the caller can say so
 * in the build console. A build where nothing matches writes no file at all.
 */
function applyAutofixes({ workspace, installCmd, buildCmd, report }) {
    const say = report && typeof report.log === 'function' ? report : { log() { } };
    const removed = [];

    for (const rel of requirementFiles(installCmd)) {
        // The path comes from the project's own install command, so it is
        // checked the same way builder.js checks outputDir: a requirements file
        // named as `../../something` is a path traversal, not a typo to follow.
        const full = path.resolve(workspace, rel);
        const inside = path.relative(workspace, full);
        if (inside.startsWith('..') || path.isAbsolute(inside)) continue;

        let text;
        try {
            text = fs.readFileSync(full, 'utf8');
        } catch {
            continue;                     // named but absent: pip will say so, not us
        }

        // Split on \n and keep any trailing \r on the line itself, so a CRLF
        // file stays CRLF and only the matched lines differ afterwards.
        const lines = text.split('\n');
        let touched = false;
        for (let i = 0; i < lines.length; i++) {
            const cr = lines[i].endsWith('\r');
            const body = cr ? lines[i].slice(0, -1) : lines[i];
            const name = requirementName(body);
            if (!name || !PACKAGING_ONLY.has(name)) continue;
            if (namedInBuild(name, buildCmd)) continue;
            lines[i] = `# skipped by Aegis Deploy, packaging only: ${body.trim()}` + (cr ? '\r' : '');
            removed.push({ file: rel, name, line: body.trim() });
            touched = true;
        }
        if (touched) fs.writeFileSync(full, lines.join('\n'));
    }

    if (removed.length) {
        const plural = removed.length === 1 ? 'dependency' : 'dependencies';
        say.log(
            `Aegis Deploy skipped ${removed.length} packaging-only ${plural} in the build copy:\n`
            + removed.map((r) => `  ${r.file}: ${r.line}\n`).join('')
            + 'They exist to build a standalone executable, which a project served as a '
            + 'process never runs. Your repository is unchanged.\n'
        );
    }

    return removed;
}

module.exports = { applyAutofixes, requirementFiles, requirementName, namedInBuild, PACKAGING_ONLY };
