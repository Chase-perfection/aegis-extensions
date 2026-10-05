/**
 * The guided setup of an external database: five steps and the result.
 *
 * A stepper, where `deploy.html` says of the new-project form that deploying is
 * one form rather than a wizard. The difference is what a mistake costs. A
 * wrong build command is a failed build the next push repairs. Here the last
 * step stops a site and moves its data, so each thing that can refuse is asked
 * in turn and shown before it: the address, the login, the checks, the copy.
 *
 * Each field carries a callout, a bordered note with an arrow pointing at it,
 * that says what the value is and where to find it. The operator of this page
 * set the database up once, weeks ago, and the callout is what saves them from
 * opening its documentation again. Its text follows the type of database picked
 * in step 1.
 *
 * Nothing is kept in the hash. A step number in the URL would be a link that
 * lands a colleague in the middle of somebody else's unsaved form.
 *
 * Opened by `deploy-storage.js`, which passes what it already holds: the
 * helpers of `deploy.js`, the API call, the project and the storage record.
 */

(function () {
    'use strict';

    var LABELS = ['step_1', 'step_2', 'step_3', 'step_4', 'step_5'];

    /** The check mark of a finished step. */
    var TICK = ['M5 12l5 5L20 7'];

    function open(container, ctx) {
        var K = ctx.K;
        var T = ctx.T;
        var el = K.el;
        var project = ctx.project;
        var saved = (ctx.info.storage && ctx.info.storage.target) || {};

        var st = {
            step: 1,
            reached: 1,
            target: {
                kind: saved.kind || 'supabase',
                host: saved.host || '',
                port: saved.port || '',
                database: saved.database || '',
                ssl: !!saved.ssl,
                consoleUrl: saved.consoleUrl || '',
                user: saved.user || ''
            },
            password: '',
            hasPassword: !!(ctx.info.storage && ctx.info.storage.hasPassword),
            canReplace: !!(ctx.info.storage && ctx.info.storage.canReplace),
            replace: false,
            checksOk: false,
            previewOk: false
        };

        var wrap = el('div', 'dep-storage-steps');
        var head = el('ol', 'dep-steps');
        var body = el('div', 'dep-step-body');
        var note = el('p', 'dep-note', '');
        note.hidden = true;
        note.setAttribute('role', 'status');
        var foot = el('div', 'dep-step-foot');
        wrap.appendChild(head);
        wrap.appendChild(body);
        wrap.appendChild(note);
        wrap.appendChild(foot);
        container.textContent = '';
        container.appendChild(wrap);

        function say(text) {
            note.hidden = !text;
            note.textContent = text || '';
        }

        function button(label, cls, onClick) {
            var b = el('button', 'dep-btn ' + (cls || ''), label);
            b.type = 'button';
            b.addEventListener('click', function () { onClick(b); });
            return b;
        }

        function go(step) {
            st.step = step;
            if (step > st.reached) st.reached = step;
            say('');
            paint();
        }

        // --- the numbered header ------------------------------------------

        function paintHead() {
            head.textContent = '';
            LABELS.forEach(function (key, i) {
                var n = i + 1;
                var done = n < st.step;
                var li = el('li', 'dep-step' + (n === st.step ? ' is-current' : '') + (done ? ' is-done' : ''));
                var btn = el('button', 'dep-step-btn');
                btn.type = 'button';
                // A step already visited can be reopened. One ahead cannot be
                // jumped to: its content depends on the answers before it.
                btn.disabled = n > st.reached || n === st.step;
                if (n === st.step) btn.setAttribute('aria-current', 'step');
                var num = el('span', 'dep-step-num');
                if (done) num.appendChild(K.icon(TICK, { width: '3' }));
                else num.textContent = String(n);
                btn.appendChild(num);
                btn.appendChild(el('span', 'dep-step-label', T(key)));
                btn.addEventListener('click', function () { go(n); });
                li.appendChild(btn);
                head.appendChild(li);
            });
        }

        // --- a field and its callout --------------------------------------

        /**
         * One field with the note that points at it.
         *
         * The note is tied to the input with `aria-describedby`, so a screen
         * reader says it after the label, which is when a sighted reader's
         * eye reaches it too.
         */
        function guided(parent, id, label, help, build) {
            var row = el('div', 'dep-guided');
            var field = el('label', 'dep-field');
            field.setAttribute('for', id);
            field.appendChild(el('span', 'dep-label', label));
            var input = build();
            input.id = id;
            input.setAttribute('aria-describedby', id + '-help');
            field.appendChild(input);
            var error = el('span', 'dep-field-error', '');
            error.hidden = true;
            field.appendChild(error);
            row.appendChild(field);
            var callout = el('p', 'dep-callout', help);
            callout.id = id + '-help';
            row.appendChild(callout);
            parent.appendChild(row);
            return { input: input, callout: callout, error: error };
        }

        function textInput(value, type) {
            var input = el('input', 'dep-input');
            input.type = type || 'text';
            input.autocomplete = type === 'password' ? 'new-password' : 'off';
            input.spellcheck = false;
            input.value = value == null ? '' : String(value);
            return input;
        }

        function help(name) {
            return T('help_' + name + '_' + st.target.kind);
        }

        function showFieldError(fields, code) {
            var map = { bad_host: 'host', bad_port: 'port', bad_database: 'database', bad_user: 'user', bad_console_url: 'consoleUrl', bad_kind: 'kind' };
            Object.keys(fields).forEach(function (k) {
                fields[k].error.hidden = true;
                fields[k].input.removeAttribute('aria-invalid');
            });
            var f = fields[map[code]];
            if (!f) return false;
            f.error.textContent = T(code);
            f.error.hidden = false;
            f.input.setAttribute('aria-invalid', 'true');
            f.input.focus();
            return true;
        }

        // --- the check list ------------------------------------------------

        function checkRow(c) {
            var label = T('check_' + c.id);
            if (c.ok === null) return K.row('todo', label, T('check_not_asked'), '');
            var key = 'check_' + c.id + '_' + c.code;
            var detail = ctx.text.has(key) ? T(key, c.detail || '') : (c.ok ? '' : (c.detail || c.code));
            return K.row(c.ok ? 'ok' : 'blocked', label, detail, '');
        }

        function post(path, payload) {
            return ctx.call('POST', ctx.base + path, payload);
        }

        function failed(e) {
            say(T('unreachable'));
            console.error('[Deploy] storage setup failed:', e);
        }

        // --- step 1: the address -------------------------------------------

        function stepAddress() {
            var f = {};
            var form = el('div', 'dep-guided-form');

            f.kind = guided(form, 'dep-storage-kind', T('kind'), T('help_kind'), function () {
                var select = el('select', 'dep-select');
                ['supabase', 'postgres'].forEach(function (k) {
                    var o = el('option', '', T('kind_' + k));
                    o.value = k;
                    if (k === st.target.kind) o.selected = true;
                    select.appendChild(o);
                });
                return select;
            });
            f.host = guided(form, 'dep-storage-host', T('host'), help('host'), function () { return textInput(st.target.host); });
            f.port = guided(form, 'dep-storage-port', T('port'), help('port'), function () {
                var i = textInput(st.target.port);
                i.inputMode = 'numeric';
                return i;
            });
            f.database = guided(form, 'dep-storage-database', T('database'), help('database'), function () { return textInput(st.target.database); });
            f.ssl = guided(form, 'dep-storage-ssl', T('ssl'), T('help_ssl'), function () {
                var box = el('input', 'dep-checkbox');
                box.type = 'checkbox';
                box.checked = st.target.ssl;
                return box;
            });
            f.consoleUrl = guided(form, 'dep-storage-console', T('console'), help('console'), function () { return textInput(st.target.consoleUrl); });

            // The callouts follow the type: the same field is found in a
            // different place on a Supabase stack and on a plain server.
            f.kind.input.addEventListener('change', function () {
                st.target.kind = f.kind.input.value;
                f.host.callout.textContent = help('host');
                f.port.callout.textContent = help('port');
                f.database.callout.textContent = help('database');
                f.consoleUrl.callout.textContent = help('console');
            });

            var approve = el('div', 'dep-approve');
            approve.hidden = true;
            body.appendChild(form);
            body.appendChild(approve);

            function read() {
                st.target.kind = f.kind.input.value;
                st.target.host = f.host.input.value.trim();
                st.target.port = f.port.input.value.trim();
                st.target.database = f.database.input.value.trim();
                st.target.ssl = f.ssl.input.checked;
                st.target.consoleUrl = f.consoleUrl.input.value.trim();
            }

            function submit(btn) {
                read();
                // Step 2 has not been filled yet on a first pass. The server
                // refuses an empty user by name, and the address is all this
                // step is asking about, so a stand-in keeps it to that.
                var target = Object.assign({}, st.target, { user: st.target.user || 'postgres' });
                btn.disabled = true;
                say(T('working'));
                post('/check', { target: target, password: '' }).then(function (d) {
                    btn.disabled = false;
                    say('');
                    approve.hidden = true;
                    if (!d.success) {
                        if (!showFieldError(f, d.error)) say(T(ctx.text.has(d.error) ? d.error : 'check_failed'));
                        return;
                    }
                    showFieldError(f, '');
                    var first = (d.checks || []).filter(function (c) { return c.ok === false; })[0];
                    if (first && (first.id === 'runtime' || first.id === 'capability')) {
                        approve.textContent = '';
                        approve.appendChild(checkRow(first));
                        approve.hidden = false;
                        return;
                    }
                    if (first && first.id === 'approved') {
                        approve.textContent = '';
                        approve.appendChild(K.row('blocked', T('approve_title'), T('approve_body'),
                            first.command || d.approveCommand || '', T('approve_note')));
                        approve.appendChild(button(T('check_again'), 'dep-btn-ghost dep-btn-small', submit));
                        approve.hidden = false;
                        return;
                    }
                    st.hasPassword = !!(d.storage && d.storage.hasPassword);
                    st.canReplace = !!(d.storage && d.storage.canReplace);
                    go(2);
                }).catch(function (e) { btn.disabled = false; failed(e); });
            }

            foot.appendChild(button(T('cancel'), 'dep-btn-ghost', ctx.onCancel));
            foot.appendChild(button(T('next'), '', submit));
        }

        // --- step 2: the credentials ---------------------------------------

        function stepCredentials() {
            var f = {};
            var form = el('div', 'dep-guided-form');
            f.user = guided(form, 'dep-storage-user', T('user'), help('user'), function () { return textInput(st.target.user); });
            f.password = guided(form, 'dep-storage-password', T('password'), help('password'), function () {
                var i = textInput(st.password, 'password');
                if (st.hasPassword) i.placeholder = T('password_kept');
                return i;
            });
            body.appendChild(form);

            foot.appendChild(button(T('previous'), 'dep-btn-ghost', function () { go(1); }));
            foot.appendChild(button(T('next'), '', function () {
                st.target.user = f.user.input.value.trim();
                st.password = f.password.input.value;
                if (!st.target.user) {
                    showFieldError(f, 'bad_user');
                    return;
                }
                st.checksOk = false;
                go(3);
            }));
        }

        // --- step 3: the checks --------------------------------------------

        function stepChecks() {
            var list = el('div', 'dep-readiness');
            body.appendChild(list);
            var next = button(T('next'), '', function () { st.previewOk = false; go(4); });
            next.disabled = true;

            function run() {
                list.textContent = '';
                list.appendChild(el('p', 'dep-empty', T('working')));
                next.disabled = true;
                post('/check', { target: st.target, password: st.password }).then(function (d) {
                    list.textContent = '';
                    if (!d.success) {
                        say(T(ctx.text.has(d.error) ? d.error : 'check_failed'));
                        return;
                    }
                    (d.checks || []).forEach(function (c) { list.appendChild(checkRow(c)); });
                    st.hasPassword = !!(d.storage && d.storage.hasPassword);
                    st.canReplace = !!(d.storage && d.storage.canReplace);
                    st.checksOk = !!d.ok;
                    next.disabled = !d.ok;
                    say(d.ok ? T('checks_ok') : '');
                    // The typed password is now kept on the server, encrypted.
                    // This page has no further use for it.
                    if (st.hasPassword) st.password = '';
                }).catch(failed);
            }

            foot.appendChild(button(T('previous'), 'dep-btn-ghost', function () { go(2); }));
            foot.appendChild(button(T('run_checks'), 'dep-btn-ghost', run));
            foot.appendChild(next);
            run();
        }

        // --- step 4: the data ----------------------------------------------

        function tableLine(t) {
            var line = el('div', 'dep-listrow');
            var main = el('div', 'dep-listrow-main');
            main.appendChild(el('span', 'dep-listrow-name', t.name));
            var text;
            if (t.state === 'ok') text = t.replaced ? T('data_ok_replace', t.replaced) : T('data_ok');
            else if (t.state === 'missing_columns') text = T('data_missing_columns', (t.missingColumns || []).join(', '));
            else if (t.state === 'not_empty') text = T('data_not_empty') + ' ' + (st.canReplace ? '' : T('data_not_empty_foreign'));
            else text = T('data_' + t.state);
            main.appendChild(el('span', 'dep-listrow-sub', T('data_rows', t.rows) + ' · ' + text));
            line.appendChild(main);
            var good = t.state === 'ok' || t.state === 'empty';
            line.appendChild(K.pill(good ? 'ok' : 'blocked', good ? T('done') : T('result_failed')));
            return line;
        }

        function stepData() {
            body.appendChild(el('p', 'dep-hint', T('data_intro')));
            var out = el('div', 'dep-data-plan');
            body.appendChild(out);
            var next = button(T('next'), '', function () { go(5); });
            next.disabled = true;

            function run() {
                out.textContent = '';
                out.appendChild(el('p', 'dep-empty', T('data_running')));
                next.disabled = true;
                say('');
                post('/preview', { replace: st.replace }).then(function (d) {
                    out.textContent = '';
                    if (!d.success) {
                        say(T(ctx.text.has(d.error) ? d.error : 'check_failed'));
                        return;
                    }
                    if (d.error) out.appendChild(K.row('blocked', T('result_failed'), T('data_failed', d.detail || d.error), ''));
                    if ((d.migrations || []).length) {
                        out.appendChild(el('p', 'dep-note', T('data_migrations', d.migrations.join(', '))));
                    }
                    var tables = d.tables || [];
                    if (!tables.length && !d.error) out.appendChild(el('p', 'dep-empty', T('data_none')));
                    if (tables.length) {
                        var rows = el('div', 'dep-rows');
                        tables.forEach(function (t) { rows.appendChild(tableLine(t)); });
                        out.appendChild(rows);
                    }

                    var occupied = tables.some(function (t) { return t.state === 'not_empty'; });
                    if (st.canReplace && (occupied || st.replace)) {
                        var label = el('label', 'dep-check');
                        var box = el('input', 'dep-checkbox');
                        box.type = 'checkbox';
                        box.id = 'dep-storage-replace';
                        box.checked = st.replace;
                        box.addEventListener('change', function () { st.replace = box.checked; run(); });
                        label.appendChild(box);
                        label.appendChild(el('span', '', T('data_replace')));
                        out.appendChild(label);
                        out.appendChild(el('p', 'dep-hint', T('data_replace_help')));
                    }
                    if ((d.withoutRls || []).length) {
                        out.appendChild(K.row('todo', T('data_rls_title'), T('data_rls', d.withoutRls.join(', ')), ''));
                    }

                    st.previewOk = !!d.ok;
                    next.disabled = !d.ok;
                    if (d.ok) say(T('data_good'));
                }).catch(failed);
            }

            foot.appendChild(button(T('previous'), 'dep-btn-ghost', function () { go(3); }));
            foot.appendChild(button(T('check_again'), 'dep-btn-ghost', run));
            foot.appendChild(next);
            run();
        }

        // --- step 5: the switch --------------------------------------------

        function stepSwitch() {
            body.appendChild(el('h3', 'dep-subtitle', T('switch_what')));
            var list = el('ol', 'dep-manual-steps');
            ['switch_1', 'switch_2', 'switch_3', 'switch_4'].forEach(function (k) {
                list.appendChild(el('li', '', T(k)));
            });
            body.appendChild(list);
            body.appendChild(el('p', 'dep-note', T('switch_keep')));

            var form = el('div', 'dep-guided-form');
            var pw = guided(form, 'dep-storage-admin-password', T('switch_password'), T('switch_password_help'), function () {
                var i = textInput('', 'password');
                i.autocomplete = 'current-password';
                return i;
            });
            body.appendChild(form);

            var back = button(T('previous'), 'dep-btn-ghost', function () { go(4); });
            var confirm = button(T('switch_button'), '', function (btn) {
                if (!pw.input.value) {
                    pw.input.focus();
                    return;
                }
                btn.disabled = true;
                back.disabled = true;
                say(T('switch_running'));
                post('/switch', { to: 'postgres', password: pw.input.value, replace: st.replace }).then(function (d) {
                    btn.disabled = false;
                    back.disabled = false;
                    if (!d.success) {
                        pw.input.value = '';
                        say(T(d.error === 'password' ? 'password_refused'
                            : (ctx.text.has(d.error) ? d.error : 'check_failed')));
                        return;
                    }
                    ctx.onResult(d);
                }).catch(function (e) { btn.disabled = false; back.disabled = false; failed(e); });
            });
            foot.appendChild(back);
            foot.appendChild(confirm);
        }

        function paint() {
            paintHead();
            body.textContent = '';
            foot.textContent = '';
            if (st.step === 1) stepAddress();
            else if (st.step === 2) stepCredentials();
            else if (st.step === 3) stepChecks();
            else if (st.step === 4) stepData();
            else stepSwitch();
            var first = body.querySelector('input, select');
            if (first && st.step !== 3 && st.step !== 4) first.focus();
        }

        paint();
    }

    window.DeployStorageSteps = { open: open };
})();
