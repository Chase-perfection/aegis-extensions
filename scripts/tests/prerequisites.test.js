import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prerequisiteErrors, PREREQUISITE_IDS } from '../build-index.mjs';

test('the catalogue list is the same closed list core checks', () => {
    assert.deepEqual(PREREQUISITE_IDS, ['git', 'python', 'node', 'pwsh']);
});

test('good lists pass, bad lists are refused', () => {
    for (const list of [[], [{ id: 'git', required: true }], [{ id: 'python', version: '3.13.1' }, { id: 'node' }]]) {
        assert.deepEqual(prerequisiteErrors(list), [], JSON.stringify(list));
    }
    for (const list of ['git', [null], [{ id: 'ruby' }], [{ id: 'git' }, { id: 'git' }],
        [{ id: 'git', required: 'yes' }], [{ id: 'python', version: '3.13' }], [{ id: 'git', url: 'x' }]]) {
        assert.ok(prerequisiteErrors(list).length > 0, `accepted ${JSON.stringify(list)}`);
    }
});
