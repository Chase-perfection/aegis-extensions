/**
 * A margin on a paragraph or a heading has to be scoped to `#deploy-view`.
 *
 * The white skin resets them: `body.aegis-white p` and `body.aegis-white h1`
 * to `h5` set `margin: 0` at (0,1,2), which outranks a bare class whatever the
 * load order. So `.dep-hint { margin: 0 0 16px }` on a `<p>` never applied,
 * and the page lost every gap between a hint and the field under it, a heading
 * and the button above it, without one failing test. `#deploy-view .dep-hint`
 * is (1,1,0) and wins.
 *
 * Static on purpose: no browser and no copy of Aegis, so it runs in CI where
 * the page tests are skipped. It reads which classes the page puts on those
 * elements from the source, then checks every rule that sets a margin on one.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..');
const RESET_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'tests' || e.name === 'site-auth' ? [] : walk(path.join(dir, e.name));
    return [path.join(dir, e.name)];
  });
}

const files = walk(FRONTEND);

/** Classes the page puts on an element the skin resets. */
function classesOnResetElements() {
  const found = new Set();
  const add = (list) => list.split(/\s+/).filter(Boolean).forEach((c) => found.add(c));
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/el\(\s*'(\w+)'\s*,\s*'([^']*)'/g)) if (RESET_TAGS.has(m[1])) add(m[2]);
    for (const m of src.matchAll(/<(\w+)[^>]*class="([^"]*)"/g)) if (RESET_TAGS.has(m[1])) add(m[2]);
  }
  return found;
}

/** A selector list split on its top-level commas, not the ones inside `:is()`. */
function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

/** Every (file, line, selector) whose rule sets a margin on one of `classes`. */
function marginRulesOn(classes) {
  const out = [];
  for (const f of files.filter((f) => f.endsWith('.css'))) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      if (sel.startsWith('@')) continue;
      if (!/(^|[;\s])margin(-top|-bottom|-block[\w-]*)?\s*:/.test(m[2])) continue;
      for (const part of splitSelectors(sel)) {
        const subject = part.split(/\s+|>|\+|~/).filter(Boolean).pop() || '';
        const hit = [...subject.matchAll(/\.([\w-]+)/g)].map((x) => x[1]).find((c) => classes.has(c));
        if (!hit) continue;
        const line = src.slice(0, m.index + m[0].indexOf(sel)).split('\n').length;
        out.push({ file: path.basename(f), line, selector: part });
      }
    }
  }
  return out;
}

test('the class scan finds the paragraphs and headings the page draws', () => {
  // A scan that matched nothing would make the next test pass on an empty list.
  const classes = classesOnResetElements();
  for (const known of ['dep-hint', 'dep-subtitle', 'dep-card-error', 'dep-access-lead']) {
    assert.ok(classes.has(known), `expected ${known} among the classes on <p>/<h*>`);
  }
});

test('the rule scan sees a margin rule on a known paragraph class', () => {
  const rules = marginRulesOn(new Set(['dep-hint']));
  assert.ok(rules.some((r) => r.selector === '#deploy-view .dep-hint'), JSON.stringify(rules));
});

test('every margin on a paragraph or heading class is scoped to #deploy-view', () => {
  const unscoped = marginRulesOn(classesOnResetElements())
    .filter((r) => !r.selector.startsWith('#deploy-view'));
  assert.deepStrictEqual(unscoped.map((r) => `${r.file}:${r.line} ${r.selector}`), [],
    'body.aegis-white resets these margins at (0,1,2); write the margin as `#deploy-view <selector> { margin: ... }`');
});
