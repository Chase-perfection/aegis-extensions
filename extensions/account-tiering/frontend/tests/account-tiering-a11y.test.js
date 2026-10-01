/**
 * Tier 3: what a keyboard or a screen reader gets from the page. The roles in
 * the rules dialog, the two live regions, where focus goes when a dialog
 * closes, and a focused node that sits outside the stage.
 *
 * The wheel events are dispatched in the page rather than through the mouse:
 * the handler is the subject, and a synthetic event carries exactly the deltas
 * the assertions count on.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const P = require('./page');
if (!P.available) {
    test('the Arbre des comptes page: keyboard and screen reader', { skip: P.why }, () => {});
    return;
}
const { fixture, API, SID, open, settle, count, text, focused, click } = P;

before(P.start);
after(P.stop);

/** Every node of an accessibility snapshot, flattened. */
function flat(node, out = []) {
    if (!node) return out;
    out.push(node);
    for (const child of node.children || []) flat(child, out);
    return out;
}

test('in the rules dialog every control keeps its own role and has a name', async () => {
    const { page, close } = await open();
    await click(page, '#at-rules-open');
    const controls = await page.$$eval('#at-rules-dialog select, #at-rules-dialog input, #at-rules-dialog textarea', (els) => els.map((el) => ({
        key: el.dataset.key || el.id, role: el.getAttribute('role'),
        name: el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '')
    })));
    assert.strictEqual(controls.length, 3 * 3 + 2, 'three controls per rule, two settings');
    for (const c of controls) {
        assert.strictEqual(c.role, null, `${c.key} carries no role of its own`);
        assert.ok(c.name, `${c.key} has a name`);
    }
    const shape = await page.$$eval('#at-rule-rows [role="row"]', (rows) => rows.map((r) => [...r.children].map((c) => c.getAttribute('role')).join(' ')));
    assert.deepStrictEqual(shape, Array(3).fill('cell cell cell cell cell'), 'five cells per row, the controls inside them');
    // What Chrome exposes, which is what a screen reader announces. The whole
    // tree, not the "interesting" subset: with a root, that one keeps a single leaf.
    const nodes = flat(await page.accessibility.snapshot({ interestingOnly: false, root: await page.$('#at-rule-rows') }));
    const has = (role, name) => nodes.some((n) => n.role === role && n.name === name);
    assert.strictEqual(nodes.filter((n) => n.role === 'row').length, 3, 'and the table is still a table');
    assert.ok(has('textbox', 'Motif de la règle 1'), 'the pattern is a text box');
    assert.ok(has('combobox', 'Type de la règle 1'), 'the kind is a combo box');
    assert.ok(has('combobox', 'Tier de la règle 3'), 'the tier is a combo box');
    assert.ok(has('button', 'Supprimer la règle 2'));
    // The grid still lines the controls up: they fill their column.
    const widths = await page.$$eval('#at-rule-rows [data-row="0"] [data-field]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    assert.ok(widths[0] >= 100 && widths[2] >= 90 && widths[1] > 300, `kind, pattern, tier: ${widths.join(', ')}`);
    await close();
});

test('with no rule the table still holds only rows made of cells, the empty message among them', async () => {
    const { page, close } = await open({ [`${API}/rules`]: { success: true, rules: [] } });
    await click(page, '#at-rules-open');
    const shape = await page.$$eval('#at-rule-rows > *', (els) => els.map((e) => [e.tagName, e.getAttribute('role'), [...e.children].map((c) => c.getAttribute('role')).join(' ')]));
    assert.deepStrictEqual(shape, [['DIV', 'row', 'cell']], 'one row, one cell: no paragraph straight in the rowgroup');
    assert.match(await text(page, '#at-rule-rows [role="cell"]'), /Aucune règle/);
    await close();
});

test('panning and redrawing leave the live regions alone and read no layout', async () => {
    const { page, close } = await open();
    assert.strictEqual(await text(page, '#at-zoom-label'), '85 %');
    await page.evaluate(() => {
        const seen = { label: 0, meta: 0, rects: 0 };
        window.atSeen = seen;
        const watch = (id, field) => new MutationObserver((list) => { seen[field] += list.length; })
            .observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
        watch('at-zoom-label', 'label');
        watch('at-meta', 'meta');
        const real = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () { seen.rects += 1; return real.call(this); };
    });
    const wheel = (init, times) => page.evaluate((o, n) => {
        const vp = document.getElementById('at-vp');
        for (let i = 0; i < n; i += 1) vp.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 700, clientY: 500, ...o }));
        return document.getElementById('at-layer').style.transform;
    }, init, times);
    const seen = () => page.evaluate(() => new Promise((r) => setTimeout(() => r({ ...window.atSeen }), 30)));

    const start = await page.$eval('#at-layer', (el) => el.style.transform);
    assert.notStrictEqual(await wheel({ deltaY: 20 }, 6), start, 'the view moved');
    assert.deepStrictEqual(await seen(), { label: 0, meta: 0, rects: 0 }, 'six pan frames');

    // Two zoom frames that stay at 85 %: nothing to announce, one position read for the gesture.
    await wheel({ deltaY: -1, ctrlKey: true }, 2);
    assert.strictEqual(await text(page, '#at-zoom-label'), '85 %');
    const zoomed = await seen();
    assert.strictEqual(zoomed.label, 0, 'the label is not rewritten with the same text');
    assert.ok(zoomed.rects <= 1, `at most one layout read per gesture (${zoomed.rects})`);

    // A zoom that changes the figure is announced once.
    await wheel({ deltaY: -60, ctrlKey: true }, 1);
    assert.notStrictEqual(await text(page, '#at-zoom-label'), '85 %');
    assert.strictEqual((await seen()).label, 1);

    // A render that changes nothing in the title bar says nothing either.
    await click(page, '#at-ghost');
    assert.strictEqual((await seen()).meta, 0, 'the meta line is not rewritten with the same text');
    await close();
});

test('focus returns to the control that opened a dialog, even when a render replaced it meanwhile', async () => {
    const still = await open();
    await click(still.page, '#at-rules-open');
    assert.ok(await still.page.evaluate(() => document.getElementById('at-rules-dialog').contains(document.activeElement)));
    await still.page.keyboard.press('Escape');
    await settle(still.page);
    assert.strictEqual(await focused(still.page), '#at-rules-open', 'the title-bar button');
    await still.close();

    // The banner is redrawn by every render, so its button is not the element that opened the dialog any more.
    const none = await open({ [`${API}/model`]: { success: true, model: { ...fixture.model, rulesCount: 0 } }, [`${API}/rules`]: { success: true, rules: [] } });
    await click(none.page, '#at-banner-norules [data-act="rules-open"]');
    await none.page.evaluate(() => window.setLanguage('fr'));
    await settle(none.page);
    await none.page.keyboard.press('Escape');
    await settle(none.page);
    assert.strictEqual(await focused(none.page), '[banner:at-banner-norules]');
    await none.close();
});

test('once a remediation is recorded, focus lands in the panel, not on the body', async () => {
    const { page, close, map } = await open();
    await click(page, '#at-fix-open');
    // The reload answers with the marker set, so the button that opened the dialog is gone.
    const model = JSON.parse(JSON.stringify(fixture.model));
    model.accounts.find((a) => a.sid === SID(2001)).remediationProposed = true;
    map[`${API}/model`] = { success: true, model };
    await click(page, '#at-fix-confirm');
    await page.waitForSelector('#at-fix-badge', { timeout: 5000 });
    await settle(page);
    assert.strictEqual(await page.$('#at-fix-open'), null);
    assert.strictEqual(await focused(page), '#at-panel');
    await close();
});

test('a node that takes focus outside the stage is panned into it', async () => {
    const { page, close } = await open();
    await click(page, '#at-more');
    await click(page, `[data-account="${SID(2007)}"]`);
    await click(page, '[data-node="cl:g"]');
    // The fit shrank the tree to show all of it; at 100 % it is taller than the stage.
    for (let i = 0; i < 10 && await text(page, '#at-zoom-label') !== '100 %'; i += 1) await click(page, '#at-zoom-in');
    assert.strictEqual(await text(page, '#at-zoom-label'), '100 %');
    assert.ok(await count(page, '.at-node') > 20, 'a tall tree');
    const measure = (which) => page.evaluate((w) => {
        const nodes = [...document.querySelectorAll('.at-node')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
        const el = w === 'last' ? nodes[nodes.length - 1] : nodes[0];
        const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
        const stage = box(document.getElementById('at-stage').getBoundingClientRect());
        const inside = (n) => n.l >= stage.l && n.r <= stage.r && n.t >= stage.t && n.b <= stage.b;
        const was = inside(box(el.getBoundingClientRect()));
        el.focus();
        const vp = document.getElementById('at-vp');
        return new Promise((r) => setTimeout(() => r({
            was, now: inside(box(el.getBoundingClientRect())), focused: document.activeElement === el,
            scroll: [vp.scrollLeft, vp.scrollTop, vp.parentNode.scrollLeft, vp.parentNode.scrollTop]
        }), 60));
    }, which);
    // Keyboard modality: after a key press a script focus matches :focus-visible, after a click it does not.
    await page.keyboard.press('Shift');
    const last = await measure('last');
    assert.strictEqual(last.was, false, 'the last node starts outside the stage');
    assert.deepStrictEqual([last.focused, last.now], [true, true], 'focused, and now inside');
    assert.deepStrictEqual(last.scroll, [0, 0, 0, 0], 'moved by the view transform, which the mini-map follows, not by a scroll');
    const first = await measure('first');
    assert.strictEqual(first.was, false, 'which pushed the first node out');
    assert.deepStrictEqual([first.focused, first.now], [true, true]);
    assert.deepStrictEqual(first.scroll, [0, 0, 0, 0]);
    await close();
});

test('pressing the mouse on a node near the edge does not pan: the click must land where it was aimed', async () => {
    const { page, close } = await open();
    await click(page, '#at-more');
    await click(page, `[data-account="${SID(2007)}"]`);
    await click(page, '[data-node="cl:g"]');
    for (let i = 0; i < 10 && await text(page, '#at-zoom-label') !== '100 %'; i += 1) await click(page, '#at-zoom-in');
    const layer = () => page.$eval('#at-layer', (el) => el.style.transform);
    // Pan by the wheel until a node sits wholly inside the stage but in the strip
    // at its foot, where a focus would pan it, and nothing else covers its centre.
    const spot = () => page.evaluate(() => {
        const stage = document.getElementById('at-stage').getBoundingClientRect();
        for (const el of document.querySelectorAll('.at-node')) {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            const top = document.elementFromPoint(x, y);
            if (r.top > stage.top + 20 && r.bottom < stage.bottom - 8 && r.bottom > stage.bottom - 90 && r.left > stage.left + 20 && r.right < stage.right - 20 && top && el.contains(top)) return { x, y };
        }
        return null;
    });
    let at = await spot();
    for (let i = 0; i < 80 && !at; i += 1) {
        await page.evaluate(() => document.getElementById('at-vp').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 12 })));
        at = await spot();
    }
    assert.ok(at, 'a node was found in the foot strip');
    const before = await layer();
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await settle(page);
    assert.strictEqual(await layer(), before, 'the press did not move the view');
    await page.mouse.up();
    await settle(page);
    assert.strictEqual(await layer(), before, 'nor did the click');
    await close();
});
