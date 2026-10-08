/**
 * The notices a deployed site shows its visitors.
 *
 * A push no longer cuts the people using a site (runtime.js keeps the outgoing
 * version for them), which leaves those people on a version that will stop.
 * Somebody has to tell them, and the site cannot be relied on to: it would need
 * code of its own for a mechanism that belongs to the host. So the proxy adds
 * one script to the pages it serves, `/__aegis/notices.js`, and that script
 * asks `/__aegis/notices` what to say.
 *
 * What it says is the project's to decide. Each project holds a list of
 * notices, edited on its Settings tab:
 *
 *   - `older-version`: the visitor is on a version that has been replaced and
 *     still serves them. Offers to switch to the new one now;
 *   - `page-outdated`: the page on screen came from a version that no longer
 *     answers. Offers to reload;
 *   - `always`: a message of the operator's own, shown to every visitor until
 *     they close it.
 *
 * The first two are built in. They can be switched off and reworded, never
 * removed, so a project that never opened the tab still warns its visitors.
 * A title, body or action left empty uses the built-in sentence in the
 * visitor's language; a filled one is shown as typed, in every language.
 *
 * Text only: the script writes every string with `textContent`, so nothing an
 * operator types can become markup on the site.
 */

'use strict';

const SCRIPT_PATH = '/__aegis/notices.js';
const DATA_PATH = '/__aegis/notices';

const TRIGGERS = ['older-version', 'page-outdated', 'always'];
const BUILT_IN = ['older-version', 'page-outdated'];
const TONES = ['info', 'warning'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What one notice may hold. A notice is a sentence or two, not a page. */
const LIMITS = { notices: 12, title: 120, body: 600, action: 40 };

/**
 * The built-in sentences. `{idle}` is the inactivity limit in minutes and
 * `{remaining}` the minutes left before the outgoing version stops if nobody
 * uses it; both are filled in by `forVisitor`.
 */
const DEFAULT_TEXT = {
    en: {
        'older-version': {
            title: 'A new version is available',
            body: 'You are on the previous version. It stays open while you use it and stops after {idle} minutes without activity. Save your work, then switch.',
            action: 'Switch now'
        },
        'page-outdated': {
            title: 'This page has been updated',
            body: 'Reload to continue on the current version. Anything not saved will be lost.',
            action: 'Reload'
        },
        always: { title: '', body: '', action: '' }
    },
    fr: {
        'older-version': {
            title: 'Une nouvelle version est disponible',
            body: 'Vous êtes sur la version précédente. Elle reste ouverte tant que vous l\'utilisez et s\'arrête après {idle} minutes sans activité. Enregistrez votre travail, puis changez de version.',
            action: 'Changer maintenant'
        },
        'page-outdated': {
            title: 'Cette page a été mise à jour',
            body: 'Rechargez pour continuer sur la version actuelle. Ce qui n\'est pas enregistré sera perdu.',
            action: 'Recharger'
        },
        always: { title: '', body: '', action: '' }
    }
};

const DEFAULT_TONE = { 'older-version': 'warning', 'page-outdated': 'info', always: 'info' };

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

/** A project that never saved its notices gets these. */
function defaults() {
    return {
        inject: true,
        items: BUILT_IN.map((trigger) => ({
            id: trigger, trigger, enabled: true, tone: DEFAULT_TONE[trigger],
            title: '', body: '', action: ''
        }))
    };
}

/** One text field: a string, trimmed, within its limit. Empty means "built in". */
function text(raw, field, limit) {
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') throw fail('bad_notices', `${field} is not text`);
    // Control characters other than the line break have no business in a
    // sentence shown to a visitor, and a stray one makes the length lie.
    const value = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
    if (value.length > limit) throw fail('bad_notices', `${field} is longer than ${limit} characters`);
    return value;
}

/**
 * What a browser sent, made into the list a project keeps, or a throw with
 * code `bad_notices`.
 *
 * Strict on shape and lenient on omission: a field left out takes its default,
 * a field of the wrong type is refused rather than coerced. The two built-in
 * notices are always in the result, appended with their defaults when the
 * request left one out, because "present by default" must survive a client
 * that sends half a list.
 */
function normalize(raw) {
    if (raw === undefined || raw === null) return defaults();
    if (typeof raw !== 'object' || Array.isArray(raw)) throw fail('bad_notices', 'notices is not an object');
    if (raw.inject !== undefined && typeof raw.inject !== 'boolean') {
        throw fail('bad_notices', 'inject is not a boolean');
    }
    const list = raw.items === undefined ? [] : raw.items;
    if (!Array.isArray(list)) throw fail('bad_notices', 'items is not a list');
    if (list.length > LIMITS.notices) throw fail('bad_notices', `more than ${LIMITS.notices} notices`);

    const seen = new Set();
    const items = list.map((n, i) => {
        if (!n || typeof n !== 'object' || Array.isArray(n)) throw fail('bad_notices', `notice ${i} is not an object`);
        const trigger = n.trigger;
        if (!TRIGGERS.includes(trigger)) throw fail('bad_notices', `notice ${i} has an unknown trigger`);
        // A built-in notice is named after its trigger, so there is one of each.
        const id = BUILT_IN.includes(trigger) ? trigger : String(n.id || '');
        if (!ID_RE.test(id)) throw fail('bad_notices', `notice ${i} has no usable id`);
        if (BUILT_IN.includes(id) && id !== trigger) throw fail('bad_notices', `notice ${i} takes a reserved id`);
        if (seen.has(id)) throw fail('bad_notices', `notice ${id} appears twice`);
        seen.add(id);
        if (n.enabled !== undefined && typeof n.enabled !== 'boolean') {
            throw fail('bad_notices', `notice ${id}: enabled is not a boolean`);
        }
        const tone = n.tone === undefined ? DEFAULT_TONE[trigger] : n.tone;
        if (!TONES.includes(tone)) throw fail('bad_notices', `notice ${id} has an unknown tone`);
        const item = {
            id, trigger,
            enabled: n.enabled === undefined ? true : n.enabled,
            tone,
            title: text(n.title, `notice ${id} title`, LIMITS.title),
            body: text(n.body, `notice ${id} body`, LIMITS.body),
            // A message of the operator's own has nothing to do but be closed.
            action: trigger === 'always' ? '' : text(n.action, `notice ${id} action`, LIMITS.action)
        };
        if (trigger === 'always' && !item.title && !item.body) {
            throw fail('bad_notices', `notice ${id} has neither a title nor a text`);
        }
        return item;
    });

    for (const trigger of BUILT_IN) {
        if (!seen.has(trigger)) items.push(defaults().items.find((n) => n.trigger === trigger));
    }
    return { inject: raw.inject === undefined ? true : raw.inject, items };
}

/** The notices a project record holds, or the defaults when it holds none or nonsense. */
function configOf(project) {
    try {
        return normalize(project ? project.notices : undefined);
    } catch (_) {
        // A record edited by hand into something the route would refuse. The
        // visitors still get the built-in warnings rather than nothing.
        return defaults();
    }
}

function fill(sentence, values) {
    return String(sentence || '').replace(/\{(idle|remaining)\}/g, (all, name) =>
        (values[name] === undefined || values[name] === null ? all : String(values[name])));
}

/**
 * The enabled notices of a project, worded for one visitor.
 *
 * Every enabled notice goes out and the page decides which ones apply: only it
 * knows which version its own HTML came from. `values` carries the numbers the
 * placeholders stand for.
 */
function forVisitor(config, lang, values) {
    const table = DEFAULT_TEXT[lang] || DEFAULT_TEXT.en;
    const v = values || {};
    return (config && config.items ? config.items : [])
        .filter((n) => n.enabled)
        .map((n) => {
            const built = table[n.trigger] || DEFAULT_TEXT.en[n.trigger];
            return {
                id: n.id,
                trigger: n.trigger,
                tone: n.tone,
                title: fill(n.title || built.title, v),
                body: fill(n.body || built.body, v),
                action: n.trigger === 'always' ? '' : (n.action || built.action)
            };
        });
}

/**
 * The tag the proxy adds to a page. `release` is the version that served the
 * page, which is how the script tells "my page is old" from "a new one exists".
 */
function scriptTag(release) {
    const attr = release && /^[0-9a-f]{7,64}$/.test(release) ? ` data-release="${release}"` : '';
    return `<script src="${SCRIPT_PATH}"${attr} defer></script>`;
}

/**
 * An HTML document with the script added, as bytes.
 *
 * Worked on the bytes, through latin1, so a page in any ASCII-compatible
 * charset comes out exactly as it went in apart from the tag. Before `</head>`
 * when there is one, before `</body>` otherwise, at the end as a last resort:
 * a browser runs a script wherever it finds it, and `defer` waits for the page.
 * A page that already carries the script, because the site added it itself,
 * is left alone.
 */
function inject(buf, release) {
    const source = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
    const flat = source.toString('latin1');
    if (flat.includes(SCRIPT_PATH)) return source;
    const tag = Buffer.from(scriptTag(release), 'latin1');
    let at = flat.search(/<\/head\s*>/i);
    if (at < 0) at = flat.search(/<\/body\s*>/i);
    if (at < 0) return Buffer.concat([source, tag]);
    return Buffer.concat([source.subarray(0, at), tag, source.subarray(at)]);
}

/** Whether a response is a page the script belongs in. */
function isHtml(contentType) {
    return /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(String(contentType || ''));
}

module.exports = {
    SCRIPT_PATH, DATA_PATH, TRIGGERS, BUILT_IN, TONES, LIMITS, DEFAULT_TEXT,
    defaults, normalize, configOf, forVisitor, scriptTag, inject, isHtml
};
