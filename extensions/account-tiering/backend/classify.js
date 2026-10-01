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

function globToRegExp(glob) {
    const body = String(glob)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp('^' + body + '$', 'i');
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
    const compiled = ordered.map((rule) => ({
        rule,
        test: rule.kind === 'name' ? globToRegExp(rule.pattern) : null
    }));
    const cache = new Map();

    const out = new Map();
    for (const p of facts.principals || []) {
        const override = byOverride.get(p.sid);
        if (override) {
            out.set(p.sid, { tier: override.tier, source: { type: 'override' } });
            continue;
        }
        const hit = compiled.find(({ rule, test }) => {
            if (rule.kind === 'ou') return ouMatches(p.dn, rule.pattern);
            if (rule.kind === 'name') return test.test(p.sam || '');
            if (rule.kind === 'group') return groupsOf(p.sid, parents, cache).has(rule.pattern);
            return false;
        });
        out.set(p.sid, hit
            ? { tier: hit.rule.tier, source: { type: 'rule', ruleId: hit.rule.id } }
            : { tier: 2, source: { type: 'default' } });
    }
    return out;
}

module.exports = { classify, ouMatches, globToRegExp };
