/**
 * The model's accounts as CSV, one row per account.
 *
 * The file opens in Excel, and Excel runs a cell that starts with `=`, `+`,
 * `-` or `@` as a formula. Account names come from the directory, where anyone
 * allowed to create an account picks the name, so a leading quote neutralises
 * those cells. The separator is a comma, and a cell holding a comma, a
 * semicolon (the French Excel separator), a quote or a line break is quoted.
 */

'use strict';

const COLUMNS = ['sid', 'sam', 'name', 'kind', 'enabled', 'planned', 'effective', 'status', 'severity', 'path', 'remediationProposed'];

function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function pathText(path) {
    return path.map((e) => `${e.kind}>${e.to}`).join(' | ');
}

function toCsv(model) {
    const rows = [COLUMNS.join(',')];
    for (const a of model.accounts) {
        rows.push(COLUMNS.map((c) => csvCell(c === 'path' ? pathText(a.path) : a[c])).join(','));
    }
    // A BOM so Excel reads the file as UTF-8 and keeps the accents in names.
    return '﻿' + rows.join('\r\n') + '\r\n';
}

module.exports = { toCsv, csvCell };
