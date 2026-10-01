/*
 * Account Tiering: helpers every view module shares (translation, escaping,
 * icons, severity marks, error texts, the dialog focus trap).
 *
 * Translation goes through core's window.t(key, fallback, params). The at_*
 * keys are not in core's translations.js yet, so the French fallback is what
 * shows until they land. Static markup uses `data-at-i18n`, NOT core's
 * `data-i18n`: core's applyTranslations() writes the raw key into any element
 * whose key it does not know, which would print "at_title" on the page.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});

    function T(key, fallback, params) {
        if (typeof window.t === 'function') return window.t(key, fallback, params || {});
        return AT.model ? AT.model.plainT(key, fallback, params) : fallback;
    }

    const esc = (v) => (window.escHtml ? window.escHtml(v) : String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));

    // Stroke icons on a 24 grid, as in the mockup. aria-hidden: every control
    // that carries one also carries a text or an aria-label.
    const P = {
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
        cog: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
        group: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18 14.8c2 .7 3.5 2.4 3.5 5.2"/>',
        shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
        key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
        doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
        screen: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>',
        layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        minus: '<path d="M5 12h14"/>',
        chevron: '<path d="M6 9l6 6 6-6"/>',
        swap: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        check: '<path d="M4 12l5 5L20 6"/>',
        copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
        up: '<path d="M6 15l6-6 6 6"/>',
        down: '<path d="M6 9l6 6 6-6"/>',
        trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M9 6V4h6v2"/>',
        rules: '<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/>',
        fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
        alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
    };
    function icon(name, cls) {
        return `<svg class="at-ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
    }

    /** The design system's severity chip (aegis-white .ag-sev), or the mockup's "Conforme" mark. */
    function sevHtml(sev) {
        if (sev === 'critical') return `<span class="ag-sev" data-sev="critical">${esc(T('at_sev_critical', 'Critique'))}</span>`;
        if (sev === 'high') return `<span class="ag-sev" data-sev="high">${esc(T('at_sev_high', 'Élevé'))}</span>`;
        if (sev === 'ok') return `<span class="at-ok">${icon('check', 'at-ok-ico')}${esc(T('at_sev_ok', 'Conforme'))}</span>`;
        if (sev === 'below') return `<span class="at-under">${esc(T('at_sev_below', 'Sous le prévu'))}</span>`;
        return '';
    }

    /** Status of an account as a mark: gap severity, compliant, or below the plan. */
    function accountMark(a) {
        if (a.status === 'gap') return sevHtml(a.severity);
        return sevHtml(a.status === 'below' ? 'below' : 'ok');
    }

    const TIER_NAMES = () => [T('at_tn_0', 'domaine'), T('at_tn_1', 'serveurs'), T('at_tn_2', 'postes')];

    const ERRORS = {
        no_scan_yet: "Aucune analyse n'a encore été faite.",
        store_unavailable: "Cette version d'Aegis ne fournit pas de stockage aux extensions : mettez Aegis à jour.",
        facts_schema: "La dernière analyse a un format que cette version de l'extension ne lit pas : relancez l'analyse.",
        forbidden: 'Cette page est réservée aux administrateurs du tenant.',
        network: "Le serveur Aegis n'a pas répondu. Vérifiez qu'il tourne, puis rechargez la page.",
        internal: "Le serveur a rencontré une erreur. Son journal en donne le détail.",
        scan_running: 'Une analyse est déjà en cours.',
        invalid_rules: 'Une règle est invalide : chaque règle a un type, un motif de 256 caractères au plus et un tier 0, 1 ou 2. Une règle de groupe attend un SID.',
        invalid_tier: 'Le tier doit être 0, 1 ou 2.',
        reason_required: 'Indiquez le motif de la correction (256 caractères au plus).',
        invalid_sid: "Ce compte n'a pas un SID valide.",
        invalid_domain: "Le domaine doit être un nom DNS, par exemple corp.local, ou rester vide pour le domaine du serveur.",
        invalid_passes: 'Le nombre de passes va de 1 à 5.',
        domain_unreachable: "Le serveur Aegis n'est pas membre du domaine, ou aucun contrôleur de domaine n'a répondu.",
        collector_blocked: "L'antivirus a bloqué le script de collecte.",
        powershell_missing: 'powershell.exe est introuvable sur le serveur Aegis.',
        scan_timeout: "L'analyse a dépassé 10 minutes et a été arrêtée.",
        scan_interrupted: "Le service Aegis a redémarré pendant l'analyse.",
        collector_failed: "Le script de collecte a échoué, ou ses résultats ne se lisent pas."
    };
    function errorText(code) {
        if (ERRORS[code]) return T('at_err_' + code, ERRORS[code]);
        return T('at_err_unknown', 'Erreur inattendue ({code}).', { code: String(code) });
    }

    /** "30/09/2026 à 08:12" in the page language; empty for a missing or bad date. */
    function dateText(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const lang = window.currentLang === 'en' ? 'en-GB' : 'fr-FR';
        return T('at_date_at', '{date} à {time}', {
            date: d.toLocaleDateString(lang),
            time: d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
        });
    }

    /** Translates the static markup marked with data-at-i18n; the inline text is the fallback. */
    function translateStatic(root) {
        (root || document).querySelectorAll('[data-at-i18n]').forEach((el) => {
            if (!el.dataset.atFallback) el.dataset.atFallback = el.textContent.trim();
            el.textContent = T(el.dataset.atI18n, el.dataset.atFallback);
        });
        (root || document).querySelectorAll('[data-at-i18n-attr]').forEach((el) => {
            // Format "attr:key|fallback", for placeholders and aria-labels.
            for (const spec of el.dataset.atI18nAttr.split(';')) {
                const [attr, rest] = spec.split(':');
                const [key, fallback] = rest.split('|');
                el.setAttribute(attr, T(key, fallback));
            }
        });
    }

    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const REGIONS = '#at-left, #at-centre, #at-panel';

    /**
     * Where focus is, in terms that survive a render: the element's `data-key`
     * (stable across redraws), its caret if it is a text field, and the region
     * it sits in. Null when focus is outside the page's own view, in which
     * case nothing must be moved.
     */
    function focusMark() {
        const view = document.getElementById('at-view');
        const el = document.activeElement;
        if (!view || !el || el === view || !view.contains(el)) return null;
        const mark = { el, key: el.dataset.key || null, region: el.closest(REGIONS), caret: null };
        // Only text fields have a caret; reading it on a checkbox throws.
        if (el.matches('textarea, input[type="text"]')) mark.caret = [el.selectionStart, el.selectionEnd];
        return mark;
    }

    /**
     * Puts focus back where `mark` says it was. The regions are redrawn as
     * HTML, so the element itself is usually gone: its twin with the same
     * `data-key` takes focus, and when there is none (the button became a
     * badge, the row was filtered out) the region does, never the body, from
     * where a keyboard user would start again at the top of the page.
     */
    function focusBack(mark) {
        if (!mark) return;
        const same = mark.el && document.contains(mark.el) ? mark.el : null;
        if (same && same === document.activeElement) return;
        const twin = same || (mark.key ? document.querySelector(`#at-view [data-key="${CSS.escape(mark.key)}"]`) : null);
        if (twin && !twin.disabled) {
            twin.focus({ preventScroll: true });
            if (twin !== same && mark.caret && twin.setSelectionRange) twin.setSelectionRange(mark.caret[0], mark.caret[1]);
            return;
        }
        const region = mark.region && document.contains(mark.region) ? mark.region : document.getElementById('at-view');
        if (region) region.focus({ preventScroll: true });
    }

    /**
     * Opens `html` as a modal dialog in #at-dialog-root. Focus moves in, Tab
     * cycles inside, Escape or the scrim closes, and focus returns to the
     * control that opened it, found again by its key if a render replaced it
     * while the dialog was open. Returns { el, close }.
     */
    function openDialog(html, opts) {
        const o = opts || {};
        const host = document.getElementById('at-dialog-root');
        const opener = focusMark();
        host.innerHTML = `<div class="at-modal"><button type="button" class="at-scrim" data-dlg-close tabindex="-1" aria-label="${esc(T('at_close', 'Fermer'))}"></button>${html}</div>`;
        const dlg = host.querySelector('[role="dialog"]');
        const close = () => {
            host.innerHTML = '';
            document.removeEventListener('keydown', onKey, true);
            if (o.onClose) o.onClose();
            // Opened with focus outside the view: it still comes back into the view, not to the body.
            focusBack(opener || {});
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key !== 'Tab') return;
            const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey, true);
        // A property, not addEventListener: the host outlives every dialog and
        // a listener per opening would close later dialogs several times.
        host.onclick = (e) => { if (e.target.closest('[data-dlg-close]')) close(); };
        const target = dlg.querySelector('[autofocus]') || dlg.querySelector(FOCUSABLE);
        if (target) target.focus();
        return { el: dlg, close };
    }

    function toast(message, variant) {
        if (typeof window.showToast === 'function') window.showToast(message, { variant: variant || 'default' });
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {
            // No clipboard permission (plain http, old browser): select the
            // text in a hidden field so the copy shortcut still works.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.className = 'at-offscreen';
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (__) { ok = false; }
            ta.remove();
            return ok;
        }
    }

    AT.ui = { T, esc, icon, sevHtml, accountMark, TIER_NAMES, errorText, dateText, translateStatic, focusMark, focusBack, openDialog, toast, copyText };
})();
