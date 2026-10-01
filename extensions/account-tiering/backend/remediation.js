/**
 * The step that cuts one link of a path, as text to copy. Nothing here runs.
 *
 * A command is built from names read out of the directory, and an AD name may
 * hold an apostrophe. Every value goes through `psQuote`, which wraps it in
 * single quotes and doubles any quote inside. PowerShell also reads the curly
 * quotes U+2018 to U+201B as single quotes, so those are doubled too: a name
 * typed in Word with "O’Brien" would otherwise close the string early.
 *
 * GPO steps are not commands: a GPO is fixed in the management console. They
 * come back as a GPO name plus a section code, and the page translates the
 * section, so this file emits no French or English prose.
 */

'use strict';

const PRIMARY_DEFAULT = { user: 513, gmsa: 515, computer: 515 };

function psQuote(value) {
    return "'" + String(value).replace(/['‘’‚‛]/g, '$&$&') + "'";
}

function netbiosOf(facts) {
    return facts.netbios || String(facts.domain).split('.')[0].toUpperCase();
}

/**
 * @param edge  one link of an account's path (`from`, `to`, `kind`, `detail`)
 * @param facts the facts the model came from, for names, DNs and GPOs
 * @returns `{ mechanism, command?, gpo?, section?, warning? }`
 */
function remediationFor(edge, facts) {
    const principals = new Map((facts.principals || []).map((p) => [p.sid, p]));
    const nameOf = (sid) => {
        const p = principals.get(sid);
        return p ? (p.sam || p.name || sid) : sid;
    };

    if (edge.kind === 'membership' && edge.detail.via === 'primaryGroup') {
        const member = principals.get(edge.from) || {};
        const rid = PRIMARY_DEFAULT[member.kind] || 513;
        return {
            mechanism: 'primaryGroup',
            command: `Set-ADObject -Identity ${psQuote(member.dn || edge.from)} -Replace @{primaryGroupID=${rid}}`,
            warning: 'primary_group'
        };
    }
    if (edge.kind === 'membership') {
        return {
            mechanism: 'membership',
            command: `Remove-ADGroupMember -Identity ${psQuote(nameOf(edge.to))} -Members ${psQuote(nameOf(edge.from))}`
        };
    }
    if (edge.kind === 'acl') {
        const dn = edge.detail.originDn || edge.detail.objectDn;
        return {
            mechanism: 'acl',
            command: `dsacls ${psQuote(dn)} /R ${psQuote(netbiosOf(facts) + '\\' + nameOf(edge.from))}`,
            warning: 'removes_all_aces'
        };
    }
    const gpo = (facts.gpos || []).find((g) => String(g.guid).toLowerCase() === edge.detail.gpo);
    const gpoName = gpo ? gpo.name : edge.detail.gpo;
    if (edge.kind === 'gpoEdit') {
        return { mechanism: 'gpoEdit', gpo: gpoName, section: 'delegation' };
    }
    if (edge.kind === 'gpoLocal') {
        return {
            mechanism: 'gpoLocal', gpo: gpoName, localGroup: edge.detail.localGroup,
            section: edge.detail.source === 'GptTmpl' ? 'restrictedGroups' : 'localUsersAndGroups'
        };
    }
    return { mechanism: edge.kind };
}

module.exports = { remediationFor, psQuote };
