'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const hostTools = require('../build/hostTools');

const ENV_Q = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment /v Path';
const PY_Q = 'HKLM\\SOFTWARE\\Python\\PythonCore /s /reg:64';

function io({ reg = {}, dirs = [], files = [], env = { SystemRoot: 'C:\\Windows' } } = {}) {
    const d = new Set(dirs.map((x) => x.toLowerCase()));
    const f = new Set(files.map((x) => x.toLowerCase()));
    return {
        reg: (args) => reg[args.join(' ')] || '',
        isDir: (p) => d.has(p.toLowerCase()),
        exists: (p) => f.has(p.toLowerCase()),
        env
    };
}

test('the machine PATH, expanded, and the registered Python folders come first', () => {
    const m = io({
        reg: {
            [ENV_Q]: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n'
                + '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs\\;C:\\Gone;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\r\n',
            [PY_Q]: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Python\\PythonCore\\3.13\\InstallPath\r\n'
                + '    ExecutablePath    REG_SZ    D:\\Py313\\python.exe\r\n'
        },
        dirs: ['D:\\Py313', 'D:\\Py313\\Scripts', 'C:\\Windows\\system32', 'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\nodejs',
            'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps']
    });
    assert.deepStrictEqual(hostTools.toolDirs(m), [
        'D:\\Py313', 'D:\\Py313\\Scripts', 'C:\\Windows\\system32', 'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\nodejs'
    ]);
});

test('an unreadable registry gives no folders rather than an error', () => {
    assert.deepStrictEqual(hostTools.toolDirs(io()), []);
});

test('withToolPath leaves one Path key, tool folders first', () => {
    const env = hostTools.withToolPath({ PATH: 'C:\\old', Path: 'C:\\old', TEMP: 'C:\\t' }, ['D:\\Py313', 'C:\\Program Files\\nodejs']);
    assert.deepStrictEqual(Object.keys(env).filter((k) => k.toLowerCase() === 'path'), ['Path']);
    assert.strictEqual(env.Path, 'D:\\Py313;C:\\Program Files\\nodejs;C:\\old');
    assert.strictEqual(env.TEMP, 'C:\\t');
    assert.strictEqual(hostTools.withToolPath({ TEMP: 'x' }, []).Path, '');
});

test('missingTool names the runtime a command needs and cannot find', () => {
    const m = io({ files: ['C:\\Program Files\\nodejs\\node.exe'] });
    const dirs = ['C:\\Program Files\\nodejs', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps'];
    const cases = [
        [['python -m pip install -r requirements.txt --target .', ''], 'python'],
        [['pip install x', ''], 'python'],
        [['npm ci', 'npm run build'], null],
        [['cd web && python build.py', ''], 'python'],
        [['', 'node build.js'], null],
        [['dotnet build', ''], null],
        [['', ''], null],
    ];
    for (const [commands, expected] of cases) {
        assert.strictEqual(hostTools.missingTool(commands, dirs, m), expected, JSON.stringify(commands));
    }
    const withStoreAlias = io({ files: ['C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'] });
    assert.strictEqual(hostTools.missingTool(['python app.py'], dirs, withStoreAlias), 'python', 'the Store alias is not Python');
});
