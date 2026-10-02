/**
 * Stands in for collect-tiering.ps1. The behaviour comes from FAKE_MODE, the
 * arguments are the collector's own (-Passes, -OutFile, -Domain).
 */

'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const outFile = arg('-OutFile');
const facts = (extra = {}) => JSON.stringify({ schema: 1, domain: arg('-Domain') || 'corp.local', passes: Number(arg('-Passes')), ...extra });

// The failing modes write a facts file first, as a collector that dies late
// would: the runner must remove it whatever the outcome.
switch (process.env.FAKE_MODE) {
    case 'ok':
        process.stdout.write('pass 1\r\npass 2\r\n');
        fs.writeFileSync(outFile, '﻿' + facts());
        break;
    case 'sample':
        // What collect-tiering.ps1 writes, BOM included, as 5.1 would.
        process.stdout.write('pass 1/3\r\n');
        fs.writeFileSync(outFile, '﻿' + fs.readFileSync(require('path').join(__dirname, 'fixtures', 'collector-sample.json'), 'utf8'));
        break;
    case 'partial':
        fs.writeFileSync(outFile, '﻿' + facts({ unreadable: [{ dn: 'OU=X', reason: 'denied' }] }));
        break;
    case 'unreachable':
        fs.writeFileSync(outFile, '﻿' + facts());
        process.stdout.write('AT-ERROR domain_unreachable\r\n');
        process.exit(2);
        break;
    case 'exit2':
        process.exit(2);
        break;
    case 'amsi':
        fs.writeFileSync(outFile, '﻿' + facts());
        process.stderr.write("Ce script contient du contenu malveillant.\r\n    + FullyQualifiedErrorId : ScriptContainedMaliciousContent\r\n");
        process.exit(1);
        break;
    case 'flood':
        // More than the runner's 10 MB maxBuffer, then wait to be killed.
        process.stdout.write('x'.repeat(11 * 1024 * 1024) + '\n');
        setTimeout(() => {}, 60000);
        break;
    case 'long-line':
        process.stdout.write('y'.repeat(200 * 1024));
        fs.writeFileSync(outFile, '﻿' + facts());
        break;
    case 'garbage':
        fs.writeFileSync(outFile, 'not json');
        break;
    case 'unknown-code':
        process.stdout.write('AT-ERROR rm_rf\r\n');
        process.exit(1);
        break;
    case 'hang':
        fs.writeFileSync(outFile, '﻿' + facts());
        setTimeout(() => {}, 60000);
        break;
    default:
        process.exit(9);
}
