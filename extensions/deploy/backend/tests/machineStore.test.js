/**
 * Machine-level build account secret storage.
 *
 * Build account passwords are encrypted at rest with AES-256-GCM to protect
 * against accidental exposure in backups or screenshots. Tests verify:
 * - Passwords are encrypted, not stored plaintext
 * - Retrieval and decryption work correctly
 * - Nonexistent accounts return null
 * - Multiple accounts coexist without collision
 * - Re-saving an account overwrites, does not duplicate
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test gets its own isolated temp directory for machine.json and machine.key
function createTestContext() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-machinestore-'));
    const oldEnv = process.env.AEGIS_DATA_ROOT;
    process.env.AEGIS_DATA_ROOT = tempDir;
    return { tempDir, oldEnv };
}

function cleanupTestContext(ctx) {
    process.env.AEGIS_DATA_ROOT = ctx.oldEnv;
    // Clean up the temp directory
    if (fs.existsSync(ctx.tempDir)) {
        fs.rmSync(ctx.tempDir, { recursive: true, force: true });
    }
}

test('saveBuildAccountSecret stores and encrypts a password', () => {
    const ctx = createTestContext();
    try {
        // Import after setting AEGIS_DATA_ROOT so storeDir() resolves correctly
        // We need to clear the require cache to ensure storeDir() is called fresh
        delete require.cache[require.resolve('../machineStore')];
        const machineStore = require('../machineStore');

        const accountName = 'builder1';
        const plainPassword = 'MyP@ssw0rd123!';

        machineStore.saveBuildAccountSecret(accountName, plainPassword);

        // Verify the file exists
        const storeFile = path.join(ctx.tempDir, 'deploy', 'machine.json');
        assert.ok(fs.existsSync(storeFile), 'machine.json must exist after save');

        // Read the raw file to verify encryption
        const rawData = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        assert.ok(rawData.buildAccounts, 'buildAccounts must exist in stored data');
        assert.ok(rawData.buildAccounts[accountName], 'account must exist');

        const stored = rawData.buildAccounts[accountName];
        // Encrypted format is "iv.tag.ciphertext" (base64-encoded parts separated by dots)
        assert.ok(typeof stored === 'string', 'encrypted value must be a string');
        assert.ok(stored.includes('.'), 'encrypted format must contain dots');
        assert.notStrictEqual(stored, plainPassword, 'stored value must NOT be plaintext');
    } finally {
        cleanupTestContext(ctx);
    }
});

test('getBuildAccountSecret retrieves and decrypts correctly', () => {
    const ctx = createTestContext();
    try {
        delete require.cache[require.resolve('../machineStore')];
        const machineStore = require('../machineStore');

        const accountName = 'builder2';
        const plainPassword = 'SecurePassword123$';

        // Save
        machineStore.saveBuildAccountSecret(accountName, plainPassword);

        // Retrieve
        const retrieved = machineStore.getBuildAccountSecret(accountName);

        assert.strictEqual(retrieved, plainPassword, 'retrieved password must match original');
    } finally {
        cleanupTestContext(ctx);
    }
});

test('getBuildAccountSecret returns null for nonexistent accounts', () => {
    const ctx = createTestContext();
    try {
        delete require.cache[require.resolve('../machineStore')];
        const machineStore = require('../machineStore');

        const result = machineStore.getBuildAccountSecret('nonexistent-account');

        assert.strictEqual(result, null, 'nonexistent account must return null');
    } finally {
        cleanupTestContext(ctx);
    }
});

test('multiple build accounts coexist without collision', () => {
    const ctx = createTestContext();
    try {
        delete require.cache[require.resolve('../machineStore')];
        const machineStore = require('../machineStore');

        const accounts = {
            'builder1': 'Password1!',
            'builder2': 'Password2@',
            'builder3': 'Password3#'
        };

        // Save all accounts
        for (const [name, pwd] of Object.entries(accounts)) {
            machineStore.saveBuildAccountSecret(name, pwd);
        }

        // Retrieve and verify each account independently
        for (const [name, pwd] of Object.entries(accounts)) {
            const retrieved = machineStore.getBuildAccountSecret(name);
            assert.strictEqual(retrieved, pwd, `account ${name} password must match original`);
        }

        // Verify all accounts exist in the raw file
        const rawData = JSON.parse(
            fs.readFileSync(path.join(ctx.tempDir, 'deploy', 'machine.json'), 'utf8')
        );
        for (const name of Object.keys(accounts)) {
            assert.ok(rawData.buildAccounts[name], `${name} must exist in stored data`);
        }
    } finally {
        cleanupTestContext(ctx);
    }
});

test('re-saving a build account overwrites, does not duplicate', () => {
    const ctx = createTestContext();
    try {
        delete require.cache[require.resolve('../machineStore')];
        const machineStore = require('../machineStore');

        const accountName = 'builder4';
        const password1 = 'FirstPassword123!';
        const password2 = 'UpdatedPassword456@';

        // Save first time
        machineStore.saveBuildAccountSecret(accountName, password1);
        let rawData = JSON.parse(
            fs.readFileSync(path.join(ctx.tempDir, 'deploy', 'machine.json'), 'utf8')
        );
        const entriesAfterFirst = Object.keys(rawData.buildAccounts).length;

        // Save again with different password
        machineStore.saveBuildAccountSecret(accountName, password2);
        rawData = JSON.parse(
            fs.readFileSync(path.join(ctx.tempDir, 'deploy', 'machine.json'), 'utf8')
        );
        const entriesAfterSecond = Object.keys(rawData.buildAccounts).length;

        // Entry count must not increase
        assert.strictEqual(entriesAfterSecond, entriesAfterFirst, 're-save must not duplicate entry');

        // Retrieve and verify the new password is stored
        const retrieved = machineStore.getBuildAccountSecret(accountName);
        assert.strictEqual(retrieved, password2, 'retrieved password must be the updated one');
        assert.notStrictEqual(retrieved, password1, 'old password must not be retrievable');
    } finally {
        cleanupTestContext(ctx);
    }
});

test('stored build account data is encrypted, not plaintext', () => {
    const ctx = createTestContext();
    try {
        delete require.cache[require.resolve('../machineStore')];
        const machineStore = require('../machineStore');

        const accountName = 'builder5';
        const plainPassword = 'VerySecretPassword!@#$%';

        machineStore.saveBuildAccountSecret(accountName, plainPassword);

        // Read raw JSON file
        const rawData = JSON.parse(
            fs.readFileSync(path.join(ctx.tempDir, 'deploy', 'machine.json'), 'utf8')
        );
        const storedEncrypted = rawData.buildAccounts[accountName];

        // The encrypted format is "iv.tag.ciphertext", all base64
        // Verify it is NOT the plaintext
        assert.notStrictEqual(storedEncrypted, plainPassword, 'stored value must not be plaintext');

        // Verify it contains the expected format (3 base64-encoded parts)
        const parts = storedEncrypted.split('.');
        assert.strictEqual(parts.length, 3, 'encrypted value must have 3 parts (iv.tag.ciphertext)');

        // Verify each part is valid base64 (no plaintext bytes)
        for (let i = 0; i < parts.length; i++) {
            const decoded = Buffer.from(parts[i], 'base64').toString('utf8');
            // Decoded bytes should not contain readable plaintext password
            assert.ok(!decoded.includes(plainPassword), `part ${i} must not contain plaintext password`);
        }
    } finally {
        cleanupTestContext(ctx);
    }
});

test('machineKey refuses to return a key when protect fails, with no fallback read', () => {
    const keyAcl = require('../keyAcl');
    const realProtect = keyAcl.protect;
    const ctx = createTestContext();
    try {
        keyAcl.protect = () => {
            const e = new Error('icacls failed');
            e.code = 'key_acl_failed';
            throw e;
        };
        const store = require('../machineStore');
        assert.throws(() => store.encrypt('x'), (e) => e.code === 'key_acl_failed');
        // Once the failure window has passed and protect works, the next call succeeds.
        keyAcl.protect = () => {};
        const realNow = Date.now;
        Date.now = () => realNow() + 61000;
        try {
            assert.ok(store.decrypt(store.encrypt('x')) === 'x');
        } finally {
            Date.now = realNow;
        }
    } finally {
        keyAcl.protect = realProtect;
        cleanupTestContext(ctx);
    }
});

test('machineKey protects an existing key once, before the first read', () => {
    const keyAcl = require('../keyAcl');
    const realProtect = keyAcl.protect;
    const ctx = createTestContext();
    try {
        const calls = [];
        keyAcl.protect = (f) => calls.push(f);
        fs.mkdirSync(path.join(ctx.tempDir, 'deploy'), { recursive: true });
        fs.writeFileSync(path.join(ctx.tempDir, 'deploy', 'machine.key'), Buffer.alloc(32, 7));
        const store = require('../machineStore');
        store.encrypt('a');
        store.encrypt('b');
        assert.deepStrictEqual(calls, [path.join(ctx.tempDir, 'deploy', 'machine.key')]);
    } finally {
        keyAcl.protect = realProtect;
        cleanupTestContext(ctx);
    }
});

function withStubbedProtect(fn, impl) {
    const keyAcl = require('../keyAcl');
    const realProtect = keyAcl.protect;
    const realError = console.error;
    const ctx = createTestContext();
    const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    keyAcl.protect = impl;
    try {
        return fn(require('../machineStore'), ctx, logged);
    } finally {
        keyAcl.protect = realProtect;
        console.error = realError;
        cleanupTestContext(ctx);
    }
}

function aclFailure(msg = 'Access is denied.') {
    const e = new Error(`icacls failed: ${msg}`);
    e.code = 'key_acl_failed';
    e.stderr = msg;
    return e;
}

test('a new key is protected while still empty, then written', () => {
    const seen = [];
    withStubbedProtect((store, ctx) => {
        store.encrypt('x');
        const keyPath = path.join(ctx.tempDir, 'deploy', 'machine.key');
        assert.deepStrictEqual(seen, [0]);
        assert.strictEqual(fs.statSync(keyPath).size, 32);
    }, (f) => { seen.push(fs.statSync(f).size); });
});

test('a new key whose protect fails is deleted, not left behind', () => {
    withStubbedProtect((store, ctx) => {
        assert.throws(() => store.encrypt('x'), (e) => e.code === 'key_acl_failed');
        assert.ok(!fs.existsSync(path.join(ctx.tempDir, 'deploy', 'machine.key')));
    }, () => { throw aclFailure(); });
});

test('an existing key that is not exactly 32 bytes is refused after a bounded wait', () => {
    withStubbedProtect((store, ctx) => {
        fs.mkdirSync(path.join(ctx.tempDir, 'deploy'), { recursive: true });
        fs.writeFileSync(path.join(ctx.tempDir, 'deploy', 'machine.key'), Buffer.alloc(5));
        const t0 = Date.now();
        assert.throws(() => store.encrypt('x'), /machine\.key/);
        assert.ok(Date.now() - t0 < 5000, 'bounded');
    }, () => {});
});

test('decrypt rethrows key_acl_failed instead of answering null', () => {
    withStubbedProtect((store) => {
        assert.throws(() => store.decrypt('aaa.bbb.ccc'), (e) => e.code === 'key_acl_failed');
    }, () => { throw aclFailure(); });
});

test('a protect failure is cached for 60 s, logged once, and retried after', () => {
    let calls = 0;
    const realNow = Date.now;
    withStubbedProtect((store, ctx, logged) => {
        const t = realNow();
        try {
            Date.now = () => t;
            assert.throws(() => store.encrypt('x'), (e) => e.code === 'key_acl_failed');
            Date.now = () => t + 30000;
            assert.throws(() => store.encrypt('x'), (e) => e.code === 'key_acl_failed');
            assert.strictEqual(calls, 1, 'no second spawn inside the window');
            assert.strictEqual(logged.length, 1);
            assert.ok(/machine\.key/.test(logged[0]) && /Access is denied/.test(logged[0]));
            Date.now = () => t + 61000;
            assert.throws(() => store.encrypt('x'), (e) => e.code === 'key_acl_failed');
            assert.strictEqual(calls, 2, 'retried after the window');
            assert.strictEqual(logged.length, 2);
        } finally {
            Date.now = realNow;
        }
    }, () => { calls += 1; throw aclFailure(); });
});

test('ensureKeyProtected creates and protects the key', () => {
    const calls = [];
    withStubbedProtect((store, ctx) => {
        store.ensureKeyProtected();
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(fs.statSync(path.join(ctx.tempDir, 'deploy', 'machine.key')).size, 32);
    }, (f) => calls.push(f));
});
