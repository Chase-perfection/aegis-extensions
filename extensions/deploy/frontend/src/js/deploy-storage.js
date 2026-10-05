/**
 * Where a project keeps its data: the gear, its page, and the Data tab of a
 * project that moved to a database.
 *
 * `deploy.js` records that the gear menu this header once had is gone, because
 * it duplicated the rail. This gear is not that one. It opens one page about
 * one subject, and nothing in the rail or the tabs leads there.
 *
 * The page is `#project/<id>/storage`: a sub-page of the project and not a
 * ninth tab. A tab is somewhere a reader goes back to; this is visited once,
 * to move the data, and again the day somebody wants it moved back.
 *
 * The gear is drawn only after the backend answered the storage route for this
 * project. That is what keeps it off the screen for a member, for a static
 * site, for a preview, and on a backend that has not been restarted since the
 * route was added.
 *
 * Three files, loaded in this order after `deploy.js`: `deploy-storage-text.js`
 * (the sentences), `deploy-storage-steps.js` (the guided setup) and this one.
 * `deploy.js` hands over its helpers as `window.DeployKit` and calls
 * `window.DeployStorage` back from the header, the router and the Data tab.
 */

(function () {
    'use strict';

    var K = window.DeployKit;
    var text = window.DeployStorageText;
    var steps = window.DeployStorageSteps;
    if (!K || !text || !steps) return;

    var T = text.T;
    var el = K.el;

    /** The cog. Core's `settings` glyph, as the paths `icon()` takes. */
    var GEAR = [
        'M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
        'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'
    ];

    /** Projects the backend said the gear has something to offer, so a tab change does not ask again. */
    var offered = {};

    function baseFor(project) {
        return '/api/deploy/projects/' + encodeURIComponent(project.id) + '/storage';
    }

    function pageHash(project) {
        return '#project/' + encodeURIComponent(project.id) + '/storage';
    }

    /** One call, answered as parsed JSON whatever the status. */
    function call(method, url, body) {
        var opts = { method: method };
        if (body) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(body);
        }
        return window.api(url, opts).then(function (r) { return K.readJson(r, url); });
    }

    function button(label, cls, onClick) {
        var b = el('button', 'dep-btn ' + (cls || ''), label);
        b.type = 'button';
        b.addEventListener('click', function () { onClick(b); });
        return b;
    }

    // --- the gear in the header ---------------------------------------------

    function drawGear(project, slot) {
        if (slot.getAttribute('data-project') !== project.id || slot.firstChild) return;
        var link = el('a', 'dep-btn dep-btn-ghost dep-btn-icon dep-storage-gear');
        link.href = pageHash(project);
        link.setAttribute('aria-label', T('gear'));
        link.title = T('gear');
        link.appendChild(K.icon(GEAR));
        slot.appendChild(link);
    }

    /**
     * Puts the gear in `slot` when this project can use it.
     *
     * The two local tests are a shortcut, not the rule: the backend decides,
     * and a project that passes them here can still be refused there.
     */
    function gear(project, slot) {
        slot.setAttribute('data-project', project.id);
        if (!K.isAdmin() || project.runtime !== 'node' || project.parentId) return;
        if (offered[project.id]) {
            drawGear(project, slot);
            return;
        }
        call('GET', baseFor(project)).then(function (d) {
            if (!(d && d.success && d.available)) return;
            offered[project.id] = true;
            drawGear(project, slot);
        }).catch(function () {
            // No gear. A backend older than the route answers HTML here, and
            // the header is not the place to say so.
        });
    }

    // --- the page ------------------------------------------------------------

    function card(title, lines, active) {
        var c = el('div', 'dep-storage-card' + (active ? ' is-active' : ''));
        var head = el('div', 'dep-storage-card-head');
        head.appendChild(el('h3', 'dep-storage-card-title', title));
        if (active) head.appendChild(K.pill('ok', T('active')));
        c.appendChild(head);
        var list = el('ul', 'dep-storage-card-list');
        lines.forEach(function (line) { list.appendChild(el('li', '', line)); });
        c.appendChild(list);
        return c;
    }

    function page(project) {
        var wrap = el('div', 'dep-block dep-storage');
        var back = el('a', 'dep-crumb', T('back_to_project'));
        back.href = '#project/' + encodeURIComponent(project.id) + '/data';
        wrap.appendChild(back);
        wrap.appendChild(el('h2', 'dep-subtitle', T('title')));
        wrap.appendChild(el('p', 'dep-hint', T('intro')));
        var body = el('div', 'dep-storage-body');
        wrap.appendChild(body);

        var info = null;

        function refreshProjects() {
            // The project list carries `storageMode`, which the Data tab reads.
            if (typeof K.reload === 'function') K.reload();
        }

        function passwordField(id, label, hint, autocomplete) {
            var field = el('label', 'dep-field');
            field.setAttribute('for', id);
            field.appendChild(el('span', 'dep-label', label));
            var input = el('input', 'dep-input');
            input.type = 'password';
            input.id = id;
            input.autocomplete = autocomplete;
            field.appendChild(input);
            if (hint) field.appendChild(el('span', 'dep-hint', hint));
            return { field: field, input: input };
        }

        function landing() {
            body.textContent = '';
            var s = info.storage || {};
            var external = s.mode === 'postgres';
            var t = s.target || {};

            body.appendChild(K.row('ok',
                external ? T('now_external') : T('now_local'),
                external ? T('now_external_detail', t.host + ':' + t.port, t.database) : T('now_local_detail', info.dbFile || ''),
                ''));

            var cards = el('div', 'dep-storage-cards');
            cards.appendChild(card(T('card_local'), [T('card_local_1'), T('card_local_2'), T('card_local_3')], !external));
            cards.appendChild(card(T('card_external'), [T('card_external_1'), T('card_external_2'), T('card_external_3')], external));
            body.appendChild(cards);

            if (!info.capable) {
                body.appendChild(K.row('blocked', T('check_capability'), T('too_old'), ''));
                return;
            }

            var actions = el('div', 'dep-step-foot');
            if (!external) {
                actions.appendChild(button(s.target ? T('resume') : T('setup'), '', openSteps));
                body.appendChild(actions);
                return;
            }

            if (s.switchedAt) {
                body.appendChild(el('p', 'dep-note', T('switched', K.ago(s.switchedAt), s.switchedBy || '')));
            }
            if (t.consoleUrl) {
                var link = el('a', 'dep-btn', T('open_console'));
                link.href = t.consoleUrl;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                actions.appendChild(link);
            }
            actions.appendChild(button(T('go_back'), 'dep-btn-ghost dep-btn-danger', goBack));
            body.appendChild(actions);
            body.appendChild(rotation(t));
        }

        /** A new database password for a project that is live on it. */
        function rotation(target) {
            var box = el('details', 'dep-more');
            box.appendChild(el('summary', 'dep-more-head', T('rotate_title')));
            box.appendChild(el('p', 'dep-hint', T('rotate_body')));
            var pw = passwordField('dep-storage-rotate', T('password'), '', 'new-password');
            box.appendChild(pw.field);
            var note = el('p', 'dep-note', '');
            note.hidden = true;
            box.appendChild(button(T('rotate_button'), 'dep-btn-ghost dep-btn-small', function (btn) {
                if (!pw.input.value) return;
                btn.disabled = true;
                note.hidden = false;
                note.textContent = T('working');
                call('POST', baseFor(project) + '/check', { target: target, password: pw.input.value }).then(function (d) {
                    btn.disabled = false;
                    var login = ((d && d.checks) || []).filter(function (c) { return c.id === 'login'; })[0];
                    var ok = !!(d && d.success && login && login.ok === true);
                    note.textContent = ok ? T('rotate_saved') : T('rotate_refused');
                    if (ok) pw.input.value = '';
                }).catch(function () {
                    btn.disabled = false;
                    note.textContent = T('unreachable');
                });
            }));
            box.appendChild(note);
            return box;
        }

        function openSteps() {
            steps.open(body, {
                K: K, T: T, text: text, call: call, base: baseFor(project), project: project, info: info,
                onCancel: landing,
                onResult: result
            });
        }

        /** What the switch did, step by step, and where the site is now. */
        function result(d) {
            body.textContent = '';
            if (d.storage) info.storage = d.storage;
            var stepList = d.steps || [];
            var restore = stepList.filter(function (s) { return s.id === 'restore'; })[0];
            var stopped = stepList.some(function (s) { return s.id === 'stop'; });

            var copied = 0;
            (d.tables || []).forEach(function (t) { copied += t.copied || 0; });
            var where = d.ok ? T('result_ok_detail', copied)
                : !stopped ? T('result_never_stopped')
                    : (restore && restore.ok) ? T('result_restored') : T('result_down');
            body.appendChild(K.row(d.ok ? 'ok' : 'blocked', d.ok ? T('result_ok') : T('result_failed'), where, ''));

            var list = el('div', 'dep-readiness');
            stepList.forEach(function (s) {
                list.appendChild(K.row(s.ok ? 'ok' : 'blocked', T('step_' + s.id), s.ok ? '' : (s.detail || ''), ''));
            });
            // The checks the server ran again, when it is one of them that refused.
            (d.checks || []).filter(function (c) { return c.ok === false; }).forEach(function (c) {
                var key = 'check_' + c.id + '_' + c.code;
                list.appendChild(K.row('blocked', T('check_' + c.id), text.has(key) ? T(key, c.detail || '') : (c.detail || c.code), ''));
            });
            body.appendChild(list);

            var actions = el('div', 'dep-step-foot');
            actions.appendChild(button(T('done'), '', landing));
            body.appendChild(actions);
            if (d.ok) refreshProjects();
        }

        function goBack() {
            body.textContent = '';
            body.appendChild(el('h3', 'dep-subtitle', T('back_title')));
            body.appendChild(el('p', 'dep-note', T('back_body')));
            body.appendChild(el('p', 'dep-hint', T('back_keep')));
            var pw = passwordField('dep-storage-back-password', T('switch_password'), T('switch_password_help'), 'current-password');
            body.appendChild(pw.field);
            var note = el('p', 'dep-note', '');
            note.hidden = true;
            note.setAttribute('role', 'status');

            var actions = el('div', 'dep-step-foot');
            actions.appendChild(button(T('cancel'), 'dep-btn-ghost', landing));
            actions.appendChild(button(T('back_button'), 'dep-btn-ghost dep-btn-danger', function (btn) {
                if (!pw.input.value) {
                    pw.input.focus();
                    return;
                }
                btn.disabled = true;
                note.hidden = false;
                note.textContent = T('switch_running');
                call('POST', baseFor(project) + '/switch', { to: 'local', password: pw.input.value }).then(function (d) {
                    btn.disabled = false;
                    if (!d.success) {
                        pw.input.value = '';
                        note.textContent = T(d.error === 'password' ? 'password_refused'
                            : (text.has(d.error) ? d.error : 'check_failed'));
                        return;
                    }
                    if (d.storage) info.storage = d.storage;
                    body.textContent = '';
                    body.appendChild(K.row(d.ok ? 'ok' : 'blocked', d.ok ? T('back_done') : T('back_failed'), '', ''));
                    var after = el('div', 'dep-step-foot');
                    after.appendChild(button(T('done'), '', landing));
                    body.appendChild(after);
                    refreshProjects();
                }).catch(function () {
                    btn.disabled = false;
                    note.textContent = T('unreachable');
                });
            }));
            body.appendChild(actions);
            body.appendChild(note);
            pw.input.focus();
        }

        body.appendChild(el('p', 'dep-empty', T('loading')));
        call('GET', baseFor(project)).then(function (d) {
            if (!(d && d.success)) throw new Error('refused');
            info = d;
            if (!d.available) {
                body.textContent = '';
                body.appendChild(K.row('blocked', T('check_runtime'), T('check_runtime_' + d.reason), ''));
                return;
            }
            landing();
        }).catch(function (e) {
            body.textContent = '';
            body.appendChild(el('p', 'dep-error', T('unreachable')));
            console.error('[Deploy] storage page failed:', e);
        });

        return wrap;
    }

    // --- the Data tab of a project on a database -----------------------------

    function dataSummary(project) {
        var wrap = el('div', 'dep-block');
        wrap.appendChild(el('h2', 'dep-subtitle', K.tr('deploy_data_title', 'Data')));
        wrap.appendChild(el('p', 'dep-hint', T('summary_body')));
        var body = el('div', 'dep-data-body');
        wrap.appendChild(body);
        body.appendChild(el('p', 'dep-empty', T('loading')));

        call('GET', baseFor(project) + '/summary').then(function (d) {
            body.textContent = '';
            if (!(d && d.success)) throw new Error((d && d.error) || 'refused');
            var t = d.target || {};
            body.appendChild(K.row(d.healthy ? 'ok' : 'blocked',
                d.healthy ? T('summary_healthy') : T('summary_down'),
                T('now_external_detail', t.host + ':' + t.port, t.database) + (d.detail ? ' ' + d.detail : ''),
                ''));

            var tables = d.tables || [];
            if (d.healthy && !tables.length) body.appendChild(el('p', 'dep-empty', T('summary_no_tables')));
            if (tables.length) {
                var rows = el('div', 'dep-rows');
                tables.forEach(function (table) {
                    var line = el('div', 'dep-listrow');
                    var main = el('div', 'dep-listrow-main');
                    main.appendChild(el('span', 'dep-listrow-name', table.name));
                    main.appendChild(el('span', 'dep-listrow-sub', T('summary_tables', table.rows)));
                    line.appendChild(main);
                    rows.appendChild(line);
                });
                body.appendChild(rows);
                if (d.more) body.appendChild(el('p', 'dep-hint', T('summary_more')));
            }

            var actions = el('div', 'dep-step-foot');
            if (d.consoleUrl) {
                var link = el('a', 'dep-btn', T('open_console'));
                link.href = d.consoleUrl;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                actions.appendChild(link);
            }
            if (K.isAdmin()) {
                var settings = el('a', 'dep-btn dep-btn-ghost', T('summary_settings'));
                settings.href = pageHash(project);
                actions.appendChild(settings);
            }
            body.appendChild(actions);
            body.appendChild(el('p', 'dep-hint', T('summary_files')));
        }).catch(function (e) {
            body.textContent = '';
            body.appendChild(el('p', 'dep-error', T('unreachable')));
            console.error('[Deploy] storage summary failed:', e);
        });

        return wrap;
    }

    window.DeployStorage = { gear: gear, page: page, dataSummary: dataSummary };
})();
