/*
 * Network Inventory · the scan account.
 *
 * Which account the scan reads DHCP, AD and DNS with. The same form as the
 * audit page's account (account, its Windows password, your Aegis password),
 * against this extension's own routes: changing it restarts nothing and does
 * not touch the account the audit runs as. Without one, the scan runs as the
 * Aegis service, which a DHCP server usually refuses.
 *
 * Admin only: the bar stays hidden when GET /api/inventory/account refuses.
 */
(function () {
    'use strict';

    const byId = id => document.getElementById(id);
    const esc = window.escHtml || (s => (s == null ? '' : String(s)));
    const T = (key, fallback) => (window.t ? window.t(key, fallback) : fallback);

    const state = { account: null, serviceIdentity: '', canChange: true, busy: false };

    /** Server codes the form has a sentence for. */
    function errorText(data) {
        const code = data && data.code;
        const reasons = {
            bad_password: T('ni_account_err_bad_password', 'Mot de passe Windows refusé pour ce compte.'),
            disabled: T('ni_account_err_disabled', 'Ce compte est désactivé.'),
            expired: T('ni_account_err_expired', 'Le mot de passe de ce compte a expiré.'),
            locked: T('ni_account_err_locked_out', 'Ce compte est verrouillé dans l\'annuaire.'),
            restricted: T('ni_account_err_restricted', 'Ce compte ne peut pas ouvrir de session à cette heure ou depuis cette machine.'),
            logon_type: T('ni_account_err_logon_type', 'Ce compte n\'a pas le droit d\'ouvrir une session réseau sur cette machine.')
        };
        if (code === 'EBADCRED') return reasons[data.reason] || T('ni_account_err_bad_password', 'Mot de passe Windows refusé pour ce compte.');
        const codes = {
            EREAUTH: T('ni_account_err_reauth', 'Votre mot de passe Aegis est incorrect.'),
            EBADACCOUNT: T('ni_account_err_account', 'Saisir le compte sous la forme DOMAINE\\nom ou nom@domaine.local.'),
            ENOPASSWORD: T('ni_account_err_nopassword', 'Saisir le mot de passe Windows du compte.'),
            ELOCKED: T('ni_account_err_locked', 'Trop de mots de passe refusés : réessayer dans dix minutes.'),
            ECOREOLD: T('ni_account_err_core', 'Cette version d\'Aegis ne permet pas encore de changer le compte du scan.'),
            EVERIFY: T('ni_account_err_verify', 'Le mot de passe n\'a pas pu être vérifié sur cette machine.')
        };
        return codes[code] || T('ni_account_err_generic', 'L\'opération a échoué.');
    }

    function renderBar() {
        const bar = byId('ni-account');
        const name = byId('ni-account-name');
        const note = byId('ni-account-note');
        if (!bar || !name) return;
        bar.hidden = false;
        const gear = byId('ni-account-gear');
        if (gear) gear.hidden = false;
        if (state.account) {
            name.textContent = state.account.account;
            if (note) note.textContent = '';
        } else {
            name.textContent = state.serviceIdentity || T('ni_account_service', 'identité du service');
            if (note) note.textContent = T('ni_account_service_note', '(identité du service Aegis)');
        }
    }

    async function load() {
        try {
            const res = await window.api('/api/inventory/account');
            if (!res.ok) return;
            const data = await res.json();
            state.account = data.account || null;
            state.serviceIdentity = data.serviceIdentity || '';
            state.canChange = data.canChange !== false;
            renderBar();
        } catch (_) { /* not an admin, or an older backend: no bar */ }
    }

    function setMessage(text, kind) {
        const msg = byId('ni-account-msg');
        if (!msg) return;
        msg.textContent = text || '';
        msg.className = 'ni-account-msg' + (kind ? ' ' + kind : '');
        msg.hidden = !text;
    }

    function setBusy(busy) {
        state.busy = busy;
        ['ni-account-save', 'ni-account-reset', 'ni-account-test'].forEach(id => {
            const b = byId(id);
            if (b) b.disabled = busy || (id !== 'ni-account-test' && !state.canChange);
        });
    }

    function open() {
        const modal = byId('ni-account-modal');
        if (!modal) return;
        byId('ni-account-input').value = state.account ? state.account.account : '';
        byId('ni-account-secret').value = '';
        byId('ni-account-password').value = '';
        byId('ni-account-results').innerHTML = '';
        byId('ni-account-current').textContent = state.account
            ? state.account.account
            : (state.serviceIdentity || T('ni_account_service', 'identité du service'));
        byId('ni-account-reset').hidden = !state.account;
        setMessage(state.canChange ? '' : errorText({ code: 'ECOREOLD' }), state.canChange ? '' : 'error');
        setBusy(false);
        modal.hidden = false;
        byId('ni-account-input').focus();
    }

    function close() {
        const modal = byId('ni-account-modal');
        if (modal) modal.hidden = true;
        // Nothing typed here outlives the dialog.
        ['ni-account-secret', 'ni-account-password'].forEach(id => { const f = byId(id); if (f) f.value = ''; });
    }

    async function send(method, body) {
        const res = await window.api('/api/inventory/account', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        let data = {};
        try { data = await res.json(); } catch (_) { }
        return { ok: res.ok && data.success === true, data };
    }

    async function save() {
        if (state.busy) return;
        setBusy(true);
        setMessage(T('ni_account_checking', 'Vérification du mot de passe…'));
        try {
            const r = await send('PUT', {
                account: byId('ni-account-input').value,
                accountPassword: byId('ni-account-secret').value,
                password: byId('ni-account-password').value
            });
            if (!r.ok) { setMessage(errorText(r.data), 'error'); return; }
            state.account = r.data.account;
            renderBar();
            byId('ni-account-current').textContent = state.account.account;
            byId('ni-account-reset').hidden = false;
            byId('ni-account-secret').value = '';
            byId('ni-account-password').value = '';
            setMessage(T('ni_account_saved', 'Compte enregistré. Le prochain scan lira le réseau avec ce compte.'), 'ok');
        } catch (_) {
            setMessage(T('ni_account_err_generic', 'L\'opération a échoué.'), 'error');
        } finally {
            setBusy(false);
        }
    }

    async function reset() {
        if (state.busy) return;
        setBusy(true);
        try {
            const r = await send('DELETE', { password: byId('ni-account-password').value });
            if (!r.ok) { setMessage(errorText(r.data), 'error'); return; }
            state.account = null;
            renderBar();
            byId('ni-account-current').textContent = state.serviceIdentity;
            byId('ni-account-input').value = '';
            byId('ni-account-password').value = '';
            byId('ni-account-reset').hidden = true;
            setMessage(T('ni_account_reset_done', 'Le scan utilise de nouveau l\'identité du service.'), 'ok');
        } catch (_) {
            setMessage(T('ni_account_err_generic', 'L\'opération a échoué.'), 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderResults(diagnostics) {
        const list = byId('ni-account-results');
        if (!list) return;
        list.innerHTML = (diagnostics || []).map(d => {
            const st = String(d.status || 'ok');
            return `
                <div class="ni-diag-entry ${esc(st)}">
                    <div class="ni-diag-entry-head">
                        <span class="ni-diag-source">${esc(d.source || 'Scan')}</span>
                        <span class="ni-diag-status ${esc(st)}">${esc(T('ni_diag_status_' + st, st))}</span>
                    </div>
                    ${d.message ? `<p class="ni-diag-msg">${esc(d.message)}</p>` : ''}
                    ${d.hint ? `<p class="ni-diag-hint">${esc(d.hint)}</p>` : ''}
                    ${d.detail ? `<code class="ni-diag-detail">${esc(d.detail)}</code>` : ''}
                </div>`;
        }).join('');
    }

    async function test() {
        if (state.busy) return;
        setBusy(true);
        byId('ni-account-results').innerHTML = '';
        setMessage(T('ni_account_testing', 'Test des accès : annuaire, DHCP, DNS…'));
        try {
            const res = await window.api('/api/inventory/account/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            let data = {};
            try { data = await res.json(); } catch (_) { }
            renderResults(data.diagnostics);
            const failed = (data.diagnostics || []).some(d => d.status === 'failed');
            setMessage(failed || !data.success
                ? T('ni_account_test_failed', 'Certains accès sont refusés : le détail est ci-dessous.')
                : T('ni_account_test_ok', 'Tests terminés.'), failed || !data.success ? 'error' : 'ok');
        } catch (_) {
            setMessage(T('ni_account_err_generic', 'L\'opération a échoué.'), 'error');
        } finally {
            setBusy(false);
        }
    }

    document.addEventListener('click', (e) => {
        if (e.target.closest('#ni-account-change') || e.target.closest('#ni-account-gear')) { open(); return; }
        if (e.target.closest('#ni-account-close') || e.target.closest('#ni-account-cancel') ||
            e.target.closest('#ni-account-backdrop')) { close(); return; }
        if (e.target.closest('#ni-account-save')) { save(); return; }
        if (e.target.closest('#ni-account-reset')) { reset(); return; }
        if (e.target.closest('#ni-account-test')) { test(); }
    });
    document.addEventListener('keydown', (e) => {
        const modal = byId('ni-account-modal');
        if (e.key === 'Escape' && modal && !modal.hidden) close();
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
    else load();
})();
