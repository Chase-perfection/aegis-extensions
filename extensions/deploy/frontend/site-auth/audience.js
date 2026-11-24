/*
 * Aegis Deploy: audience measurement for this site.
 *
 * Added by Deploy to the pages of a site whose operator switched audience on.
 * It reports three things to /__aegis/audience, on the same origin:
 *   - a view, each time the page loads or its path changes (pushState,
 *     replaceState, popstate: the navigation of a single-page application);
 *   - the active time of the current view: the tab is visible and the visitor
 *     did something in the last 30 seconds;
 *   - a click on a control (a link, a button, a role=button, a summary...),
 *     with a name for the control: data-aegis-track, else its id, else its
 *     aria-label, else its visible text, else its tag and position.
 *
 * Never sent: the query string, the fragment, the page title, or the value of
 * any field. The visitor is named on the server, never here. A browser that
 * sends the Global Privacy Control signal is not measured at all.
 *
 * Any error stops the measurement, never the page. No element is drawn.
 */
(function () {
    'use strict';

    var ENDPOINT = '/__aegis/audience';
    var IDLE_MS = 30000;
    var FLUSH_MS = 15000;
    var TICK_MS = 1000;
    var BATCH = 50;
    var MAX_BATCHES = 10;
    var TEXT_MAX = 40;
    var NAME_MAX = 80;
    var PATH_MAX = 200;
    var INTERACTIVE_TAGS = { A: 1, BUTTON: 1, SUMMARY: 1, SELECT: 1, LABEL: 1 };
    var TEXT_TAGS = { A: 1, BUTTON: 1, SUMMARY: 1 };
    var ROLES = { button: 1, link: 1, tab: 1, menuitem: 1, checkbox: 1, 'switch': 1 };
    var INPUT_TYPES = { button: 1, submit: 1, reset: 1, checkbox: 1, radio: 1 };
    var GENERATED_ID = /\d{4}|[0-9a-f]{8,}/i;
    // C0, DEL, C1 and the two Unicode line breaks, from code points so this
    // file holds none of them literally.
    var CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f)
        + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f)
        + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

    function clean(text, max) {
        return String(text == null ? '' : text).replace(CONTROL, ' ').replace(/\s+/g, ' ')
            .replace(/^\s+|\s+$/g, '').slice(0, max);
    }

    function attr(node, name) {
        var v = node && node.getAttribute ? node.getAttribute(name) : null;
        return v == null ? '' : String(v);
    }

    function tagOf(node) { return String((node && node.tagName) || '').toUpperCase(); }

    function usableId(id) { return !!id && !GENERATED_ID.test(id); }

    function isInteractive(node) {
        var tag = tagOf(node);
        if (INTERACTIVE_TAGS[tag]) return true;
        if (ROLES[attr(node, 'role').toLowerCase()]) return true;
        return tag === 'INPUT' && !!INPUT_TYPES[attr(node, 'type').toLowerCase()];
    }

    /** The control a click landed in, or null when it landed on no control. */
    function controlOf(target) {
        var node = target;
        for (var depth = 0; node && depth < 12; depth++) {
            if (attr(node, 'data-aegis-track') || isInteractive(node)) return node;
            node = node.parentElement;
        }
        return null;
    }

    function segmentOf(node) {
        var tag = tagOf(node).toLowerCase();
        var cls = String(node.className || '').split(/\s+/)[0];
        var seg = tag + (cls ? '.' + clean(cls, 30) : '');
        var parent = node.parentElement;
        if (parent && parent.children) {
            var nth = 0;
            for (var i = 0; i < parent.children.length; i++) {
                if (tagOf(parent.children[i]) === tagOf(node)) nth++;
                if (parent.children[i] === node) break;
            }
            seg += ':nth-of-type(' + nth + ')';
        }
        return seg;
    }

    /** Tag and position, up to three levels, from the nearest ancestor with an id. */
    function pathOf(node) {
        var segs = [];
        var prefix = '';
        var cur = node;
        for (var depth = 0; cur && depth < 3; depth++) {
            segs.unshift(segmentOf(cur));
            var parent = cur.parentElement;
            if (!parent) break;
            if (usableId(parent.id)) { prefix = '#' + clean(parent.id, 40) + ' > '; break; }
            cur = parent;
        }
        return prefix + segs.join(' > ');
    }

    function nameOf(node) {
        var tag = tagOf(node).toLowerCase();
        var value = clean(attr(node, 'data-aegis-track'), NAME_MAX);
        if (!value && usableId(node.id)) value = '#' + clean(node.id, NAME_MAX);
        if (!value) value = clean(attr(node, 'aria-label'), NAME_MAX);
        if (!value && (TEXT_TAGS[tagOf(node)] || ROLES[attr(node, 'role').toLowerCase()])) {
            value = clean(node.innerText || node.textContent, TEXT_MAX);
        }
        if (!value) value = pathOf(node);
        return (tag + ': ' + value).slice(0, NAME_MAX);
    }

    function newPv() {
        var s = '';
        while (s.length < 12) s += Math.random().toString(36).slice(2);
        return s.slice(0, 12);
    }

    function currentPath() {
        return String(window.location.pathname || '/').slice(0, PATH_MAX);
    }

    try {
        if (window.navigator && window.navigator.globalPrivacyControl === true) return;
        var doc = window.document;
        var queue = [];
        var view = null;
        var lastActivity = Date.now();
        var lastTick = lastActivity;
        var lastFlush = lastActivity;

        var startView = function () {
            view = { pv: newPv(), p: currentPath(), ms: 0, sent: 0 };
            queue.push({ k: 'view', pv: view.pv, p: view.p });
        };

        var noteTime = function () {
            if (view && view.ms > view.sent) {
                var ms = Math.round(view.ms);
                queue.push({ k: 'time', pv: view.pv, p: view.p, ms: ms });
                view.sent = ms;
            }
        };

        var send = function (events) {
            var body = JSON.stringify({ v: 1, events: events });
            try {
                if (window.navigator.sendBeacon
                    && window.navigator.sendBeacon(ENDPOINT, new window.Blob([body], { type: 'text/plain' }))) return;
            } catch (e) { /* refused by the browser: try fetch */ }
            try {
                if (typeof fetch === 'function') {
                    fetch(ENDPOINT, {
                        method: 'POST', body: body, keepalive: true, credentials: 'same-origin',
                        headers: { 'Content-Type': 'text/plain' }
                    })['catch'](function () {});
                }
            } catch (e) { /* nothing left to try */ }
        };

        var flush = function () {
            noteTime();
            lastFlush = Date.now();
            for (var n = 0; queue.length && n < MAX_BATCHES; n++) send(queue.splice(0, BATCH));
            queue.length = 0;
        };

        var onNavigate = function () {
            if (currentPath() === view.p) return;
            noteTime();
            startView();
        };

        var visible = function () { return doc.visibilityState !== 'hidden' && !doc.hidden; };

        var tick = function () {
            try {
                var now = Date.now();
                if (visible() && now - lastActivity <= IDLE_MS) view.ms += Math.min(now - lastTick, 2 * TICK_MS);
                lastTick = now;
                if (now - lastFlush >= FLUSH_MS) flush();
            } catch (e) { /* the measurement stops, the page does not */ }
        };

        var activity = function () { lastActivity = Date.now(); };

        startView();
        doc.addEventListener('click', function (ev) {
            try {
                activity();
                var control = controlOf(ev && ev.target);
                if (control) queue.push({ k: 'click', pv: view.pv, p: view.p, c: nameOf(control) });
            } catch (e) { /* ignored */ }
        }, true);
        ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (type) {
            doc.addEventListener(type, activity, { capture: true, passive: true });
        });
        doc.addEventListener('visibilitychange', function () {
            try {
                if (visible()) { lastTick = Date.now(); activity(); } else flush();
            } catch (e) { /* ignored */ }
        });
        window.addEventListener('pagehide', function () { try { flush(); } catch (e) { /* ignored */ } });
        window.addEventListener('popstate', function () { try { onNavigate(); } catch (e) { /* ignored */ } });

        var history = window.history;
        ['pushState', 'replaceState'].forEach(function (name) {
            var original = history && history[name];
            if (typeof original !== 'function') return;
            history[name] = function () {
                var out = original.apply(this, arguments);
                try { onNavigate(); } catch (e) { /* ignored */ }
                return out;
            };
        });

        window.setInterval(tick, TICK_MS);

        if (window.__aegisAudienceTest === true) window.__aegisAudience = { nameOf: nameOf, flush: flush };
    } catch (e) {
        /* Something in this browser is not what the script expects: no measure. */
    }
})();
