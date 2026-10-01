/**
 * The tier each account is meant to have.
 *
 * An override set by hand wins. Otherwise the rules are tried in order and the
 * first that matches gives the tier. An account no rule covers is Tier 2: the
 * safe default, because it makes an unclassified administrator show up as a
 * gap instead of hiding it.
 *
 * Three kinds of rule:
 * - `ou`: the account's DN ends with the pattern, case-insensitive, on an RDN
 *   boundary, so `OU=Admins-T0,...` does not match `OU=XAdmins-T0,...`;
 * - `name`: `sAMAccountName` matches a glob where `*` is any run and `?` one
 *   character, case-insensitive, every other character literal;
 * - `group`: the account is a member of that group SID, directly, through
 *   nested groups, or through its primary group.
 */

'use strict';

function ouMatches(dn, pattern) {
    const d = String(dn || '').toLowerCase();
    const p = String(pattern).toLowerCase();
    return d === p || d.endsWith(',' + p);
}

/**
 * Whether `text` matches `glob`, case-insensitive. Not a regular expression:
 * `*` turned into `.*` backtracks exponentially on a pattern like `*a*a*a…b`,
 * and one such rule would block the event loop for every tenant. This is the
 * two-pointer matcher that remembers only the last `*`, so a mismatch costs at
 * most glob length times text length steps, never more.
 */
function globMatch(glob, text) {
    const g = String(glob).toLowerCase();
    const t = String(text).toLowerCase();
    let gi = 0;
    let ti = 0;
    let star = -1;
    let resume = 0;
    while (ti < t.length) {
        if (gi < g.length && (g[gi] === '?' || (g[gi] !== '*' && g[gi] === t[ti]))) {
            gi += 1;
            ti += 1;
        } else if (gi < g.length && g[gi] === '*') {
            star = gi;
            gi += 1;
            resume = ti;
        } else if (star >= 0) {
            // Let the last `*` swallow one more character and retry from there.
            gi = star + 1;
            resume += 1;
            ti = resume;
        } else {
            return false;
        }
    }
    while (gi < g.length && g[gi] === '*') gi += 1;
    return gi === g.length;
}

/** Every group a principal belongs to, nested membership included, cycles cut. */
function groupsOf(sid, parents, cache) {
    if (cache.has(sid)) return cache.get(sid);
    const found = new Set();
    const stack = [...(parents.get(sid) || [])];
    while (stack.length) {
        const group = stack.pop();
        if (found.has(group)) continue;
        found.add(group);
        for (const next of parents.get(group) || []) stack.push(next);
    }
    cache.set(sid, found);
    return found;
}

/**
 * @param facts      the collected facts (`principals`, `memberships`)
 * @param rules      `[{ id, position, kind, pattern, tier }]`, any order
 * @param overrides  `[{ sid, tier, reason, set_by, set_at }]`
 * @returns Map sid -> `{ tier, source: { type: 'override'|'rule'|'default', ruleId? } }`
 */
function classify(facts, rules, overrides) {
    const parents = new Map();
    for (const m of facts.memberships || []) {
        if (!parents.has(m.member)) parents.set(m.member, []);
        parents.get(m.member).push(m.group);
    }
    const byOverride = new Map((overrides || []).map((o) => [o.sid, o]));
    const ordered = [...(rules || [])].sort((a, b) => a.position - b.position);
    const cache = new Map();

    const out = new Map();
    for (const p of facts.principals || []) {
        const override = byOverride.get(p.sid);
        if (override) {
            out.set(p.sid, { tier: override.tier, source: { type: 'override' } });
            continue;
        }
        const hit = ordered.find((rule) => {
            if (rule.kind === 'ou') return ouMatches(p.dn, rule.pattern);
            if (rule.kind === 'name') return globMatch(rule.pattern, p.sam || '');
            if (rule.kind === 'group') return groupsOf(p.sid, parents, cache).has(rule.pattern);
            return false;
        });
        out.set(p.sid, hit
            ? { tier: hit.tier, source: { type: 'rule', ruleId: hit.id } }
            : { tier: 2, source: { type: 'default' } });
    }
    return out;
}

module.exports = { classify, ouMatches, globMatch };
