/*
    The notices a deployed site shows its visitors.

    Added to the site's pages by the Deploy proxy (backend/siteNotices.js), or
    by the site itself with <script src="/__aegis/notices.js" defer>. It asks
    /__aegis/notices what to say every two minutes while the tab is visible,
    and draws the notices that apply in a corner of the page.

    Which ones apply is decided here, because only the page knows which version
    its own HTML came from (`data-release` on this tag):

      older-version  the visitor is on a version that has been replaced and
                     still serves them; "switch" moves them to the new one;
      page-outdated  the page on screen came from a version that no longer
                     answers; "reload" fetches the current one;
      always         a message of the operator's own, until the visitor
                     closes it.

    Inside a shadow root, so the site's CSS cannot reach it and its CSS cannot
    reach the site. Every string is written with textContent. No animation.
    A poll carries X-Aegis-Background so it does not keep an outgoing version
    alive on its own.
*/

(function () {
    'use strict';

    if (window.__aegisNotices) return;
    window.__aegisNotices = true;

    var DATA_PATH = '/__aegis/notices';
    var SWITCH_PATH = '/__aegis/release/switch';
    var POLL_MS = 120000;
    var SNOOZE_MS = 10 * 60 * 1000;

    var tag = document.currentScript ||
        document.querySelector('script[src*="/__aegis/notices.js"]');
    var pageRelease = (tag && tag.getAttribute('data-release')) || null;

    var lang = String(document.documentElement.lang || navigator.language || 'en').toLowerCase();
    var CHROME = lang.indexOf('fr') === 0
        ? { later: 'Plus tard', close: 'Fermer', region: 'Notifications du site' }
        : { later: 'Later', close: 'Close', region: 'Site notifications' };

    var stopped = false;
    var shownKey = '';
    var host = null;
    var stack = null;

    function store(kind) {
        try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { return null; }
    }
    function read(kind, key) {
        var s = store(kind);
        try { return s ? s.getItem(key) : null; } catch (e) { return null; }
    }
    function write(kind, key, value) {
        var s = store(kind);
        try { if (s) s.setItem(key, value); } catch (e) { /* private window: shown again next time */ }
    }

    /** A short fingerprint, so a reworded message is shown again to those who closed the old one. */
    function hash(text) {
        var h = 0;
        for (var i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }
    function closedKey(n) { return 'aegis-notice:' + n.id + ':' + hash(n.title + '\n' + n.body); }
    function snoozeKey(n) { return 'aegis-notice-snooze:' + n.id; }

    function applies(n, data) {
        if (n.trigger === 'always') return !read('local', closedKey(n));
        var until = Number(read('session', snoozeKey(n)) || 0);
        if (until > Date.now()) return false;
        var older = !!(data.served && data.latest && data.served !== data.latest);
        if (n.trigger === 'older-version') return older;
        if (n.trigger === 'page-outdated') {
            return !older && !!(pageRelease && data.served && pageRelease !== data.served);
        }
        return false;
    }

    var CSS = [
        ':host{all:initial}',
        '.stack{--surface:#ffffff;--ink:#080808;--ink-pressed:#1c1c1e;--on-ink:#ffffff;--body:#363636;',
        '--muted:#5a5a5a;--border:#e4e4e4;--warning:#b45309;--info:#14305c;--focus-ring:#14305c;',
        '--font-ui:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
        '--radius-md:8px;--radius-pill:999px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;',
        'position:fixed;right:var(--space-4);bottom:var(--space-4);z-index:2147483000;',
        'display:flex;flex-direction:column;gap:var(--space-2);width:min(380px,calc(100vw - 2 * var(--space-4)));',
        'font:14px/1.45 var(--font-ui);color:var(--body)}',
        '@media (prefers-color-scheme:dark){.stack{--surface:#1c1c1e;--ink:#f5f5f7;--ink-pressed:#e4e4e4;',
        '--on-ink:#080808;--body:#e4e4e4;--muted:#a1a1a6;--border:#3a3a3c;--warning:#f59e0b;--info:#8ab4f8;--focus-ring:#8ab4f8}}',
        '.card{box-sizing:border-box;display:grid;grid-template-columns:16px 1fr;column-gap:var(--space-3);',
        'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);',
        'padding:var(--space-3) var(--space-4)}',
        '.glyph{width:16px;height:16px;margin-top:2px;color:var(--info)}',
        '.card.warning .glyph{color:var(--warning)}',
        '.text{min-width:0}',
        '.title{margin:0 0 var(--space-1);font-weight:600;color:var(--ink)}',
        '.body{margin:0;white-space:pre-line}',
        '.row{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3)}',
        'button{font:inherit;font-weight:500;cursor:pointer;border-radius:var(--radius-pill);',
        'padding:var(--space-1) var(--space-3);min-height:32px}',
        'button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}',
        '.go{background:var(--ink);color:var(--on-ink);border:1px solid var(--ink)}',
        '.go:hover{background:var(--ink-pressed)}',
        '.later{background:transparent;color:var(--muted);border:1px solid transparent}',
        '.later:hover{color:var(--ink)}'
    ].join('');

    function mount() {
        if (host) return;
        host = document.createElement('div');
        host.setAttribute('data-aegis-notices', '');
        var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
        var style = document.createElement('style');
        style.textContent = CSS;
        root.appendChild(style);
        stack = document.createElement('div');
        stack.className = 'stack';
        stack.setAttribute('role', 'region');
        stack.setAttribute('aria-label', CHROME.region);
        stack.setAttribute('aria-live', 'polite');
        root.appendChild(stack);
        (document.body || document.documentElement).appendChild(host);
    }

    function act(n) {
        if (n.trigger === 'older-version') {
            location.href = SWITCH_PATH + '?next=' +
                encodeURIComponent(location.pathname + location.search + location.hash);
        } else if (n.trigger === 'page-outdated') {
            location.reload();
        }
    }

    function dismiss(n) {
        if (n.trigger === 'always') write('local', closedKey(n), '1');
        else write('session', snoozeKey(n), String(Date.now() + SNOOZE_MS));
        shownKey = '';
        if (last) draw(last);
    }

    /** A circle with "!" for a warning, "i" for the rest: the tone is the glyph's colour and nothing else's. */
    var SVG = 'http://www.w3.org/2000/svg';
    function glyph(tone) {
        var svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('class', 'glyph');
        svg.setAttribute('aria-hidden', 'true');
        var paths = tone === 'warning'
            ? ['M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13z', 'M8 4.5v4.25', 'M8 11h.01']
            : ['M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13z', 'M8 7.25v4.25', 'M8 5h.01'];
        paths.forEach(function (d) {
            var p = document.createElementNS(SVG, 'path');
            p.setAttribute('d', d);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', 'currentColor');
            p.setAttribute('stroke-width', '1.5');
            p.setAttribute('stroke-linecap', 'round');
            svg.appendChild(p);
        });
        return svg;
    }

    function card(n) {
        var c = document.createElement('div');
        c.className = 'card' + (n.tone === 'warning' ? ' warning' : '');
        c.appendChild(glyph(n.tone));
        var text = document.createElement('div');
        text.className = 'text';
        c.appendChild(text);
        if (n.title) {
            var t = document.createElement('p');
            t.className = 'title';
            t.textContent = n.title;
            text.appendChild(t);
        }
        if (n.body) {
            var b = document.createElement('p');
            b.className = 'body';
            b.textContent = n.body;
            text.appendChild(b);
        }
        var row = document.createElement('div');
        row.className = 'row';
        if (n.action) {
            var go = document.createElement('button');
            go.type = 'button';
            go.className = 'go';
            go.textContent = n.action;
            go.addEventListener('click', function () { act(n); });
            row.appendChild(go);
        }
        var later = document.createElement('button');
        later.type = 'button';
        later.className = 'later';
        later.textContent = n.trigger === 'always' ? CHROME.close : CHROME.later;
        later.addEventListener('click', function () { dismiss(n); });
        row.appendChild(later);
        text.appendChild(row);
        return c;
    }

    var last = null;
    function draw(data) {
        last = data;
        var list = (data.notices || []).filter(function (n) { return applies(n, data); });
        // Redrawn only when something changed, so a poll never takes the
        // focus away from a button somebody is about to press.
        var key = JSON.stringify(list);
        if (key === shownKey) return;
        shownKey = key;
        if (!list.length) {
            if (stack) stack.textContent = '';
            return;
        }
        mount();
        stack.textContent = '';
        list.forEach(function (n) { stack.appendChild(card(n)); });
    }

    function poll() {
        if (stopped || document.visibilityState === 'hidden' || !window.fetch) return;
        fetch(DATA_PATH, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Accept': 'application/json', 'X-Aegis-Background': '1' }
        }).then(function (r) {
            // Not served by Deploy, or the feature is gone: nothing to ask again.
            if (r.status === 404) { stopped = true; return null; }
            return r.ok ? r.json() : null;
        }).then(function (data) {
            if (!data) return;
            if (!pageRelease) pageRelease = data.served || null;
            draw(data);
        }).catch(function () { /* the network: asked again at the next tick */ });
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') poll();
    });
    setInterval(poll, POLL_MS);
    poll();
})();
