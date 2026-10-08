/**
 * The Settings section where a project decides what its site says to visitors.
 *
 * The notices themselves are drawn on the deployed site by
 * `frontend/site-auth/notices.js`, which the proxy adds to every page; the
 * rules live in `backend/siteNotices.js`. This file only edits the list:
 * the two built-in notices (an older version, a page out of date), which can be
 * reworded or switched off and never removed, and the operator's own messages.
 *
 * A field left empty shows the built-in sentence, in the visitor's language.
 * The empty field displays that sentence as its placeholder, in the language of
 * this page, so the operator reads what a visitor would get.
 *
 * Loaded after `deploy.js`, which lends its helpers as `window.DeployKit` and
 * calls `window.DeployNotices.section(project)` from the Settings tab.
 */

(function () {
    'use strict';

    var K = window.DeployKit;
    if (!K) return;
    var el = K.el;

    var STRINGS = {
        en: {
            deploy_notices_title: 'Notices to visitors',
            deploy_notices_body: 'Short messages the site shows in a corner of its pages. The two built-in ones tell a visitor when a deployment replaced the version they are on. Leave a field empty to keep the built-in sentence, which follows the visitor\'s language.',
            deploy_notices_inject: 'Add the notices to the site\'s pages',
            deploy_notices_inject_hint: 'Deploy adds one script tag to every HTML page it serves. Untick it if the site includes /__aegis/notices.js itself, or shows nothing of the kind.',
            deploy_notices_placeholders: 'In a text, {idle} is the number of minutes without activity after which a previous version stops, and {remaining} the minutes left before it does.',
            deploy_notices_kind_older: 'Previous version',
            deploy_notices_kind_older_hint: 'Shown while a visitor is still on a version that a deployment replaced. Its button moves them to the new version.',
            deploy_notices_kind_outdated: 'Page out of date',
            deploy_notices_kind_outdated_hint: 'Shown when the page on screen came from a version that no longer answers. Its button reloads the page.',
            deploy_notices_kind_always: 'Message',
            deploy_notices_kind_always_hint: 'Shown to every visitor until they close it. Changing the text shows it again to those who closed it.',
            deploy_notices_shown: 'Shown',
            deploy_notices_tone: 'Tone',
            deploy_notices_tone_info: 'Information',
            deploy_notices_tone_warning: 'Warning',
            deploy_notices_field_title: 'Title',
            deploy_notices_field_body: 'Text',
            deploy_notices_field_action: 'Button',
            deploy_notices_remove: 'Remove',
            deploy_notices_add: 'Add a message',
            deploy_notices_save: 'Save notices',
            deploy_notices_saved: 'Saved. Visitors see the change within two minutes.',
            deploy_notices_refused: 'Aegis refused these notices: $1',
            deploy_notices_full: 'A project holds $1 notices at most.',
            deploy_notices_empty_message: 'A message needs a title or a text.'
        },
        fr: {
            deploy_notices_title: 'Notifications aux visiteurs',
            deploy_notices_body: 'De courts messages que le site affiche dans un coin de ses pages. Les deux notifications intégrées préviennent un visiteur quand un déploiement a remplacé la version sur laquelle il se trouve. Laissez un champ vide pour garder la phrase intégrée, qui suit la langue du visiteur.',
            deploy_notices_inject: 'Ajouter les notifications aux pages du site',
            deploy_notices_inject_hint: 'Deploy ajoute une balise script à chaque page HTML qu\'il sert. Décochez si le site inclut lui-même /__aegis/notices.js, ou n\'affiche rien de tel.',
            deploy_notices_placeholders: 'Dans un texte, {idle} est le nombre de minutes sans activité après lequel une version précédente s\'arrête, et {remaining} les minutes qui restent avant qu\'elle ne s\'arrête.',
            deploy_notices_kind_older: 'Version précédente',
            deploy_notices_kind_older_hint: 'Affichée tant qu\'un visiteur est encore sur une version remplacée par un déploiement. Son bouton le fait passer sur la nouvelle version.',
            deploy_notices_kind_outdated: 'Page périmée',
            deploy_notices_kind_outdated_hint: 'Affichée quand la page à l\'écran vient d\'une version qui ne répond plus. Son bouton recharge la page.',
            deploy_notices_kind_always: 'Message',
            deploy_notices_kind_always_hint: 'Affiché à chaque visiteur jusqu\'à ce qu\'il le ferme. Modifier le texte le réaffiche à ceux qui l\'avaient fermé.',
            deploy_notices_shown: 'Affichée',
            deploy_notices_tone: 'Ton',
            deploy_notices_tone_info: 'Information',
            deploy_notices_tone_warning: 'Avertissement',
            deploy_notices_field_title: 'Titre',
            deploy_notices_field_body: 'Texte',
            deploy_notices_field_action: 'Bouton',
            deploy_notices_remove: 'Retirer',
            deploy_notices_add: 'Ajouter un message',
            deploy_notices_save: 'Enregistrer les notifications',
            deploy_notices_saved: 'Enregistré. Les visiteurs voient le changement dans les deux minutes.',
            deploy_notices_refused: 'Aegis a refusé ces notifications : $1',
            deploy_notices_full: 'Un projet garde $1 notifications au plus.',
            deploy_notices_empty_message: 'Un message demande un titre ou un texte.'
        }
    };
    (function mergeStrings() {
        var table = window.translations;
        if (!table) return;
        Object.keys(STRINGS).forEach(function (lang) {
            var target = table[lang] || (table[lang] = {});
            Object.keys(STRINGS[lang]).forEach(function (k) {
                if (!(k in target)) target[k] = STRINGS[lang][k];
            });
        });
    })();

    function T(key) { return K.tr(key, STRINGS.en[key]); }

    /* eslint-disable-next-line no-undef */
    function lang() { return (typeof currentLang === 'string' && currentLang) || 'en'; }

    var MAX = 12;
    var KIND = {
        'older-version': ['deploy_notices_kind_older', 'deploy_notices_kind_older_hint'],
        'page-outdated': ['deploy_notices_kind_outdated', 'deploy_notices_kind_outdated_hint'],
        always: ['deploy_notices_kind_always', 'deploy_notices_kind_always_hint']
    };

    function copy(v) { return JSON.parse(JSON.stringify(v)); }

    /** The built-in sentence a field falls back to, for its placeholder. */
    function builtIn(project, trigger, field) {
        var all = project.noticeDefaults || {};
        var table = all[lang()] || all.en || {};
        return (table[trigger] && table[trigger][field]) || '';
    }

    function field(labelText, control) {
        var row = el('label', 'dep-field');
        row.appendChild(el('span', 'dep-label', labelText));
        row.appendChild(control);
        return row;
    }

    function textInput(value, placeholder, max, onInput) {
        var input = el('input', 'dep-input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.maxLength = max;
        input.value = value || '';
        input.placeholder = placeholder || '';
        input.disabled = !K.isAdmin();
        input.addEventListener('input', function () { onInput(input.value); });
        return input;
    }

    function noticeCard(project, draft, n, redraw) {
        var admin = K.isAdmin();
        var card = el('div', 'dep-notice');

        var head = el('div', 'dep-notice-head');
        var check = el('label', 'dep-check');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!n.enabled;
        box.disabled = !admin;
        box.addEventListener('change', function () { n.enabled = box.checked; });
        check.appendChild(box);
        check.appendChild(el('span', '', T(KIND[n.trigger][0])));
        head.appendChild(check);

        var tone = el('select', 'dep-select dep-notice-tone');
        tone.disabled = !admin;
        tone.setAttribute('aria-label', T('deploy_notices_tone'));
        [['info', 'deploy_notices_tone_info'], ['warning', 'deploy_notices_tone_warning']].forEach(function (o) {
            var opt = el('option', '', T(o[1]));
            opt.value = o[0];
            if (n.tone === o[0]) opt.selected = true;
            tone.appendChild(opt);
        });
        tone.addEventListener('change', function () { n.tone = tone.value; });
        head.appendChild(tone);

        if (n.trigger === 'always') {
            var remove = el('button', 'dep-btn dep-btn-ghost dep-btn-small', T('deploy_notices_remove'));
            remove.type = 'button';
            remove.disabled = !admin;
            remove.addEventListener('click', function () {
                draft.items = draft.items.filter(function (x) { return x !== n; });
                redraw();
            });
            head.appendChild(remove);
        }
        card.appendChild(head);
        card.appendChild(el('p', 'dep-hint', T(KIND[n.trigger][1])));

        var fields = el('div', 'dep-fields');
        fields.appendChild(field(T('deploy_notices_field_title'),
            textInput(n.title, builtIn(project, n.trigger, 'title'), 120, function (v) { n.title = v; })));
        if (n.trigger !== 'always') {
            fields.appendChild(field(T('deploy_notices_field_action'),
                textInput(n.action, builtIn(project, n.trigger, 'action'), 40, function (v) { n.action = v; })));
        }
        card.appendChild(fields);

        var body = el('textarea', 'dep-input dep-textarea');
        body.rows = 3;
        body.maxLength = 600;
        body.value = n.body || '';
        body.placeholder = builtIn(project, n.trigger, 'body');
        body.disabled = !admin;
        body.addEventListener('input', function () { n.body = body.value; });
        card.appendChild(field(T('deploy_notices_field_body'), body));
        return card;
    }

    function save(project, draft, button, note, redraw) {
        var custom = draft.items.filter(function (n) {
            return n.trigger === 'always' && !String(n.title || '').trim() && !String(n.body || '').trim();
        });
        note.hidden = false;
        if (custom.length) {
            note.textContent = T('deploy_notices_empty_message');
            return;
        }
        button.disabled = true;
        note.textContent = K.tr('deploy_auth_working', 'Saving.');
        window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notices: draft })
        })
            .then(function (r) { return K.readJson(r, 'settings'); })
            .then(function (data) {
                button.disabled = !K.isAdmin();
                if (data && data.success && data.notices) {
                    project.notices = data.notices;
                    redraw(copy(data.notices));
                    note.hidden = false;
                    note.textContent = T('deploy_notices_saved');
                    return;
                }
                note.textContent = T('deploy_notices_refused')
                    .replace('$1', (data && (data.detail || data.error)) || '');
            })
            .catch(function (e) {
                button.disabled = !K.isAdmin();
                note.textContent = K.tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.');
                console.error('[Deploy] notices save failed:', e);
            });
    }

    /** The whole section, for `settingsTab` in deploy.js. */
    function section(project) {
        var admin = K.isAdmin();
        var wrap = el('div', 'dep-notices-section');
        wrap.appendChild(el('h2', 'dep-subtitle', T('deploy_notices_title')));
        wrap.appendChild(el('p', 'dep-hint', T('deploy_notices_body')));

        var draft = copy(project.notices || { inject: true, items: [] });

        var check = el('label', 'dep-check');
        var inject = document.createElement('input');
        inject.type = 'checkbox';
        inject.disabled = !admin;
        check.appendChild(inject);
        check.appendChild(el('span', '', T('deploy_notices_inject')));
        wrap.appendChild(check);
        wrap.appendChild(el('p', 'dep-hint', T('deploy_notices_inject_hint')));

        var list = el('div', 'dep-notices');
        wrap.appendChild(list);
        wrap.appendChild(el('p', 'dep-hint', T('deploy_notices_placeholders')));

        var actions = el('div', 'dep-notice-actions');
        var add = el('button', 'dep-btn dep-btn-ghost dep-btn-small', T('deploy_notices_add'));
        add.type = 'button';
        var saveBtn = el('button', 'dep-btn dep-btn-small', T('deploy_notices_save'));
        saveBtn.type = 'button';
        saveBtn.disabled = !admin;
        actions.appendChild(add);
        actions.appendChild(saveBtn);
        wrap.appendChild(actions);

        var note = el('p', 'dep-note', '');
        note.hidden = true;
        wrap.appendChild(note);

        function redraw(next) {
            if (next) draft = next;
            inject.checked = draft.inject !== false;
            list.textContent = '';
            draft.items.forEach(function (n) {
                list.appendChild(noticeCard(project, draft, n, function () { redraw(); }));
            });
            add.disabled = !admin || draft.items.length >= MAX;
            add.title = draft.items.length >= MAX ? T('deploy_notices_full').replace('$1', String(MAX)) : '';
        }

        inject.addEventListener('change', function () { draft.inject = inject.checked; });
        add.addEventListener('click', function () {
            if (draft.items.length >= MAX) return;
            draft.items.push({
                id: 'msg-' + Date.now().toString(36), trigger: 'always', enabled: true,
                tone: 'info', title: '', body: '', action: ''
            });
            redraw();
        });
        saveBtn.addEventListener('click', function () { save(project, draft, saveBtn, note, redraw); });

        redraw();
        return wrap;
    }

    window.DeployNotices = { section: section };
})();
