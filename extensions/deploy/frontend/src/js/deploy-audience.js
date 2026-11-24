/**
 * The Audience tab of a project, and the switch for it on the Settings tab.
 *
 * What the site's visitors did, from `GET /api/deploy/projects/:id/audience`
 * (backend/audienceStore.js): unique visitors, visits and their length over a
 * period, then the pages and the controls clicked. The measurement itself is
 * `frontend/site-auth/audience.js`, which the proxy adds to the site's pages
 * once the switch below is on.
 *
 * Every text that came from a visitor's page (a path, a control's name) is
 * written with textContent: a page can name a button anything.
 *
 * Loaded after `deploy.js`, which lends its helpers as `window.DeployKit` and
 * calls `window.DeployAudience.tab(project)` and `.section(project)`.
 */

(function () {
    'use strict';

    var K = window.DeployKit;
    if (!K) return;
    var el = K.el;

    var STRINGS = {
        en: {
            deploy_tab_audience: 'Audience',
            deploy_audience_title: 'Audience',
            deploy_audience_off: 'This site does not measure its audience yet.',
            deploy_audience_off_link: 'Switch it on in Settings',
            deploy_audience_period: 'Period',
            deploy_audience_days: '$1 days',
            deploy_audience_year: '12 months',
            deploy_audience_from: 'From',
            deploy_audience_to: 'To',
            deploy_audience_show: 'Show',
            deploy_audience_visitors: 'Unique visitors',
            deploy_audience_visits: 'Visits',
            deploy_audience_avg: 'Average visit',
            deploy_audience_total: 'Total time',
            deploy_audience_estimate: 'Visitors over this period are an estimate, to about 3 %. Past 90 days Aegis keeps no visitor ids.',
            deploy_audience_per_day: 'Visitors per day',
            deploy_audience_day_title: '$1: $2 visitors, $3 visits',
            deploy_audience_pages: 'Pages',
            deploy_audience_page: 'Page',
            deploy_audience_views: 'Views',
            deploy_audience_per_view: 'Average per view',
            deploy_audience_components: 'Most clicked',
            deploy_audience_component: 'Control',
            deploy_audience_clicks: 'Clicks',
            deploy_audience_filtered: 'Controls of $1 only. Click the page again to see them all.',
            deploy_audience_empty: 'No visit over this period.',
            deploy_audience_failed: 'Aegis could not read the audience of this site.',
            deploy_audience_retry: 'Try again',
            deploy_audience_bad_period: 'Pick a start date before the end date, neither in the future.',
            deploy_audience_section: 'Audience',
            deploy_audience_section_body: 'Counts the visitors of this site, the time they spend on it, its pages and the controls they click. A visitor is a pseudonym: on a protected site, a fingerprint of their account; on an open site, a random cookie kept 13 months. Nothing typed into a field is ever read.',
            deploy_audience_switch: 'Measure the audience of this site',
            deploy_audience_privacy: 'Mention the audience measurement in the site\'s privacy page.',
            deploy_audience_saved_on: 'Saved. Pages served from now on carry the measurement.',
            deploy_audience_saved_off: 'Saved. The measurement stops; what was counted stays until it expires.',
            deploy_audience_erase: 'Erase the audience data',
            deploy_audience_erase_confirm: 'Erase everything measured on $1? This cannot be undone. The measurement itself stays as it is.',
            deploy_audience_erased: 'Audience data erased.',
            deploy_audience_refused: 'Aegis refused: $1'
        },
        fr: {
            deploy_tab_audience: 'Fréquentation',
            deploy_audience_title: 'Fréquentation',
            deploy_audience_off: 'Ce site ne mesure pas encore sa fréquentation.',
            deploy_audience_off_link: 'L\'activer dans les Réglages',
            deploy_audience_period: 'Période',
            deploy_audience_days: '$1 jours',
            deploy_audience_year: '12 mois',
            deploy_audience_from: 'Du',
            deploy_audience_to: 'Au',
            deploy_audience_show: 'Afficher',
            deploy_audience_visitors: 'Visiteurs uniques',
            deploy_audience_visits: 'Visites',
            deploy_audience_avg: 'Durée moyenne d\'une visite',
            deploy_audience_total: 'Temps total',
            deploy_audience_estimate: 'Les visiteurs de cette période sont une estimation, à 3 % près environ. Au-delà de 90 jours, Aegis ne garde aucun identifiant de visiteur.',
            deploy_audience_per_day: 'Visiteurs par jour',
            deploy_audience_day_title: '$1 : $2 visiteurs, $3 visites',
            deploy_audience_pages: 'Pages',
            deploy_audience_page: 'Page',
            deploy_audience_views: 'Vues',
            deploy_audience_per_view: 'Temps moyen par vue',
            deploy_audience_components: 'Les plus cliqués',
            deploy_audience_component: 'Élément',
            deploy_audience_clicks: 'Clics',
            deploy_audience_filtered: 'Éléments de $1 seulement. Cliquez à nouveau sur la page pour tout voir.',
            deploy_audience_empty: 'Aucune visite sur cette période.',
            deploy_audience_failed: 'Aegis n\'a pas pu lire la fréquentation de ce site.',
            deploy_audience_retry: 'Réessayer',
            deploy_audience_bad_period: 'Choisissez une date de début avant la date de fin, aucune dans le futur.',
            deploy_audience_section: 'Fréquentation',
            deploy_audience_section_body: 'Compte les visiteurs de ce site, le temps qu\'ils y passent, ses pages et les éléments sur lesquels ils cliquent. Un visiteur est un pseudonyme : sur un site protégé, une empreinte de son compte ; sur un site ouvert, un cookie aléatoire gardé 13 mois. Rien de ce qui est saisi dans un champ n\'est lu.',
            deploy_audience_switch: 'Mesurer la fréquentation de ce site',
            deploy_audience_privacy: 'Mentionnez la mesure d\'audience dans la page de confidentialité du site.',
            deploy_audience_saved_on: 'Enregistré. Les pages servies à partir de maintenant portent la mesure.',
            deploy_audience_saved_off: 'Enregistré. La mesure s\'arrête ; ce qui a été compté reste jusqu\'à son échéance.',
            deploy_audience_erase: 'Effacer les données de fréquentation',
            deploy_audience_erase_confirm: 'Effacer tout ce qui a été mesuré sur $1 ? C\'est définitif. La mesure elle-même reste comme elle est.',
            deploy_audience_erased: 'Données de fréquentation effacées.',
            deploy_audience_refused: 'Aegis a refusé : $1'
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

    var DAY_MS = 86400000;
    var PERIODS = [7, 30, 90, 365];

    function dayStr(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function daysBefore(day, n) {
        var p = day.split('-').map(Number);
        return dayStr(new Date(p[0], p[1] - 1, p[2] - n));
    }

    function num(n) { return Number(n || 0).toLocaleString(lang()); }

    /** `33 s`, `2 min 12 s`, `11 h 23 min`. */
    function duration(ms) {
        var s = Math.round((ms || 0) / 1000);
        if (s < 60) return s + ' s';
        var m = Math.floor(s / 60);
        if (m < 60) return m + ' min ' + (s % 60) + ' s';
        return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
    }

    function apiUrl(project, from, to) {
        return '/api/deploy/projects/' + encodeURIComponent(project.id) + '/audience?from=' + from + '&to=' + to;
    }

    function cell(tag, text, cls) { return el(tag, cls || '', text); }

    function table(cls, heads) {
        var t = el('table', 'dep-aud-table ' + cls);
        var tr = el('tr');
        heads.forEach(function (h, i) { tr.appendChild(cell('th', h, i ? 'dep-aud-num' : '')); });
        var thead = el('thead');
        thead.appendChild(tr);
        t.appendChild(thead);
        t.appendChild(el('tbody'));
        return t;
    }

    function kpis(totals) {
        var dl = el('dl', 'dep-aud-kpi');
        [
            [T('deploy_audience_visitors'), num(totals.visitors)],
            [T('deploy_audience_visits'), num(totals.visits)],
            [T('deploy_audience_avg'), duration(totals.avgVisitMs)],
            [T('deploy_audience_total'), duration(totals.activeMs)]
        ].forEach(function (pair) {
            var item = el('div', 'dep-aud-kpi-item');
            item.appendChild(el('dt', '', pair[0]));
            item.appendChild(el('dd', '', pair[1]));
            dl.appendChild(item);
        });
        return dl;
    }

    var SVG = 'http://www.w3.org/2000/svg';

    /** One bar per day, scaled to the busiest day. Static: no transition. */
    function chart(series) {
        var wrap = el('figure', 'dep-aud-chart');
        wrap.appendChild(el('figcaption', 'dep-hint', T('deploy_audience_per_day')));
        var max = 1;
        series.forEach(function (d) { if (d.visitors > max) max = d.visitors; });
        var w = 10;
        var h = 80;
        var svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + (series.length * w) + ' ' + h);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', T('deploy_audience_per_day'));
        series.forEach(function (d, i) {
            var bh = d.visitors ? Math.max(2, Math.round(d.visitors / max * (h - 2))) : 1;
            var r = document.createElementNS(SVG, 'rect');
            r.setAttribute('x', String(i * w + 1));
            r.setAttribute('y', String(h - bh));
            r.setAttribute('width', String(w - 2));
            r.setAttribute('height', String(bh));
            r.setAttribute('class', d.visitors ? 'dep-aud-bar' : 'dep-aud-bar dep-aud-bar-zero');
            var title = document.createElementNS(SVG, 'title');
            title.textContent = T('deploy_audience_day_title').replace('$1', d.day)
                .replace('$2', num(d.visitors)).replace('$3', num(d.visits));
            r.appendChild(title);
            svg.appendChild(r);
        });
        wrap.appendChild(svg);
        if (series.length) {
            var axis = el('div', 'dep-aud-axis');
            axis.appendChild(el('span', '', series[0].day));
            axis.appendChild(el('span', '', series[series.length - 1].day));
            wrap.appendChild(axis);
        }
        return wrap;
    }

    function report(body, data) {
        body.textContent = '';
        body.appendChild(kpis(data.totals || {}));
        if (data.visitorsPrecision === 'estimate') body.appendChild(el('p', 'dep-hint dep-aud-estimate', T('deploy_audience_estimate')));
        if (!data.totals || !data.totals.visits) {
            body.appendChild(el('p', 'dep-empty', T('deploy_audience_empty')));
        }
        body.appendChild(chart(data.series || []));

        body.appendChild(el('h3', 'dep-aud-h', T('deploy_audience_pages')));
        var pages = table('dep-aud-pages', [T('deploy_audience_page'), T('deploy_audience_views'),
            T('deploy_audience_visitors'), T('deploy_audience_per_view'), T('deploy_audience_total')]);
        body.appendChild(pages);

        body.appendChild(el('h3', 'dep-aud-h', T('deploy_audience_components')));
        var filterNote = el('p', 'dep-hint', '');
        filterNote.hidden = true;
        body.appendChild(filterNote);
        var comps = table('dep-aud-components', [T('deploy_audience_component'), T('deploy_audience_page'),
            T('deploy_audience_clicks'), T('deploy_audience_visitors')]);
        body.appendChild(comps);

        var selected = null;
        var buttons = [];

        function drawComponents() {
            var tbody = comps.querySelector('tbody');
            tbody.textContent = '';
            (data.components || []).filter(function (c) { return !selected || c.path === selected; }).forEach(function (c) {
                var tr = el('tr');
                tr.appendChild(cell('td', c.name, 'dep-aud-name'));
                tr.appendChild(cell('td', c.path, 'dep-mono'));
                tr.appendChild(cell('td', num(c.clicks), 'dep-aud-num'));
                tr.appendChild(cell('td', num(c.visitors), 'dep-aud-num'));
                tbody.appendChild(tr);
            });
            filterNote.hidden = !selected;
            filterNote.textContent = selected ? T('deploy_audience_filtered').replace('$1', selected) : '';
            buttons.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.path === selected ? 'true' : 'false'); });
        }

        (data.pages || []).forEach(function (p) {
            var tr = el('tr');
            var first = el('td');
            var b = el('button', 'dep-btn-link dep-mono', p.path);
            b.type = 'button';
            b.dataset.path = p.path;
            b.addEventListener('click', function () {
                selected = selected === p.path ? null : p.path;
                drawComponents();
            });
            buttons.push(b);
            first.appendChild(b);
            tr.appendChild(first);
            tr.appendChild(cell('td', num(p.views), 'dep-aud-num'));
            tr.appendChild(cell('td', num(p.visitors), 'dep-aud-num'));
            tr.appendChild(cell('td', duration(p.views ? p.activeMs / p.views : 0), 'dep-aud-num'));
            tr.appendChild(cell('td', duration(p.activeMs), 'dep-aud-num'));
            pages.querySelector('tbody').appendChild(tr);
        });
        drawComponents();
    }

    function tab(project) {
        var wrap = el('div', 'dep-block dep-aud');
        wrap.appendChild(el('h2', 'dep-subtitle', T('deploy_audience_title')));
        if (!project.audience || !project.audience.enabled) {
            var off = el('p', 'dep-hint dep-aud-off', T('deploy_audience_off') + ' ');
            var link = el('a', '', T('deploy_audience_off_link'));
            link.href = '#project/' + encodeURIComponent(project.id) + '/settings';
            off.appendChild(link);
            wrap.appendChild(off);
            return wrap;
        }

        var today = dayStr(new Date());
        var bar = el('div', 'dep-aud-periods');
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', T('deploy_audience_period'));
        var body = el('div', 'dep-aud-body');
        var presets = [];

        function load(from, to, pressed) {
            presets.forEach(function (b) { b.setAttribute('aria-pressed', b === pressed ? 'true' : 'false'); });
            body.setAttribute('aria-busy', 'true');
            window.api(apiUrl(project, from, to))
                .then(function (r) { return K.readJson(r, 'audience'); })
                .then(function (data) {
                    body.removeAttribute('aria-busy');
                    if (data && data.success) return report(body, data);
                    failed(data && data.error === 'bad_period' ? T('deploy_audience_bad_period') : T('deploy_audience_failed'), from, to, pressed);
                })
                .catch(function (e) {
                    body.removeAttribute('aria-busy');
                    console.error('[Deploy] audience read failed:', e);
                    failed(T('deploy_audience_failed'), from, to, pressed);
                });
        }

        function failed(message, from, to, pressed) {
            body.textContent = '';
            body.appendChild(el('p', 'dep-error', message));
            var again = el('button', 'dep-btn dep-btn-ghost dep-btn-small', T('deploy_audience_retry'));
            again.type = 'button';
            again.addEventListener('click', function () { load(from, to, pressed); });
            body.appendChild(again);
        }

        PERIODS.forEach(function (n) {
            var b = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
                n === 365 ? T('deploy_audience_year') : T('deploy_audience_days').replace('$1', String(n)));
            b.type = 'button';
            b.dataset.days = String(n);
            b.addEventListener('click', function () { load(daysBefore(today, n - 1), today, b); });
            presets.push(b);
            bar.appendChild(b);
        });

        var fromIn = document.createElement('input');
        fromIn.type = 'date';
        fromIn.max = today;
        fromIn.value = daysBefore(today, 29);
        var toIn = document.createElement('input');
        toIn.type = 'date';
        toIn.max = today;
        toIn.value = today;
        var range = el('span', 'dep-aud-range');
        var fromLabel = el('label', '', T('deploy_audience_from') + ' ');
        fromLabel.appendChild(fromIn);
        var toLabel = el('label', '', T('deploy_audience_to') + ' ');
        toLabel.appendChild(toIn);
        var show = el('button', 'dep-btn dep-btn-small', T('deploy_audience_show'));
        show.type = 'button';
        show.addEventListener('click', function () {
            if (!fromIn.value || !toIn.value || fromIn.value > toIn.value || toIn.value > today) {
                failed(T('deploy_audience_bad_period'), fromIn.value, toIn.value, null);
                return;
            }
            load(fromIn.value, toIn.value, null);
        });
        range.appendChild(fromLabel);
        range.appendChild(toLabel);
        range.appendChild(show);
        bar.appendChild(range);

        wrap.appendChild(bar);
        wrap.appendChild(body);
        load(daysBefore(today, 29), today, presets[1]);
        return wrap;
    }

    function section(project) {
        var admin = K.isAdmin();
        var wrap = el('div', 'dep-aud-section');
        wrap.appendChild(el('h2', 'dep-subtitle', T('deploy_audience_section')));
        wrap.appendChild(el('p', 'dep-hint', T('deploy_audience_section_body')));

        var check = el('label', 'dep-check');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!(project.audience && project.audience.enabled);
        box.disabled = !admin;
        check.appendChild(box);
        check.appendChild(el('span', '', T('deploy_audience_switch')));
        wrap.appendChild(check);
        wrap.appendChild(el('p', 'dep-hint', T('deploy_audience_privacy')));

        var erase = el('button', 'dep-btn dep-btn-ghost dep-btn-small dep-btn-danger dep-aud-erase', T('deploy_audience_erase'));
        erase.type = 'button';
        erase.disabled = !admin;
        wrap.appendChild(erase);

        var note = el('p', 'dep-note', '');
        note.hidden = true;
        wrap.appendChild(note);

        function say(text) { note.hidden = false; note.textContent = text; }

        box.addEventListener('change', function () {
            var wanted = box.checked;
            box.disabled = true;
            window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audience: { enabled: wanted } })
            })
                .then(function (r) { return K.readJson(r, 'settings'); })
                .then(function (data) {
                    box.disabled = !K.isAdmin();
                    if (data && data.success && data.audience) {
                        project.audience = data.audience;
                        box.checked = !!data.audience.enabled;
                        say(data.audience.enabled ? T('deploy_audience_saved_on') : T('deploy_audience_saved_off'));
                        return;
                    }
                    box.checked = !wanted;
                    say(T('deploy_audience_refused').replace('$1', (data && (data.detail || data.error)) || ''));
                })
                .catch(function (e) {
                    box.disabled = !K.isAdmin();
                    box.checked = !wanted;
                    say(K.tr('deploy_auth_unreachable', 'Aegis did not answer. Check the backend is running, then reload this page.'));
                    console.error('[Deploy] audience switch failed:', e);
                });
        });

        erase.addEventListener('click', function () {
            if (!window.confirm(T('deploy_audience_erase_confirm').replace('$1', project.name || project.id))) return;
            erase.disabled = true;
            window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/audience', { method: 'DELETE' })
                .then(function (r) { return K.readJson(r, 'audience erase'); })
                .then(function (data) {
                    erase.disabled = !K.isAdmin();
                    say(data && data.success ? T('deploy_audience_erased')
                        : T('deploy_audience_refused').replace('$1', (data && data.error) || ''));
                })
                .catch(function (e) {
                    erase.disabled = !K.isAdmin();
                    say(K.tr('deploy_auth_unreachable', 'Aegis did not answer. Check the backend is running, then reload this page.'));
                    console.error('[Deploy] audience erase failed:', e);
                });
        });
        return wrap;
    }

    window.DeployAudience = { tab: tab, section: section };
})();
