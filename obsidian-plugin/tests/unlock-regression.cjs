// Self-contained KDBX regression. Uses a synthetic database; no user password or vault data is committed.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const bundle = path.resolve(__dirname, '../dist/main.js');
const source = fs.readFileSync(bundle, 'utf8') + '\nmodule.exports.__kdbxTest = { Kdbx, Credentials: KdbxCredentials, ProtectedValue };';
const mock = { Plugin: class {}, ItemView: class {}, Modal: class {}, Setting: class {}, Notice: class {}, TFile: class {} };
const moduleObject = { exports: {} };
const requireFromHere = Module.createRequire(__filename);
new Function('module', 'exports', 'require', source)(moduleObject, moduleObject.exports,
    name => name === 'obsidian' ? mock : requireFromHere(name));
const { Kdbx, Credentials, ProtectedValue } = moduleObject.exports.__kdbxTest;
const credentials = password => new Credentials(ProtectedValue.fromString(password));
async function run() {
    const password = 'synthetic-ci-password-only';
    const original = Kdbx.create(credentials(password), 'Argon2 regression');
    const encrypted = await original.save();
    const reopened = await Kdbx.load(encrypted, credentials(password));
    assert.ok(reopened.groups.length > 0, 'synthetic database must open');
    // Optional private fixture, supplied only locally. Never commit its password or bytes.
    if (process.env.KDBX_TEST_FILE && process.env.KDBX_TEST_PASSWORD) {
        const bytes = fs.readFileSync(process.env.KDBX_TEST_FILE);
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const real = await Kdbx.load(data, credentials(process.env.KDBX_TEST_PASSWORD));
        assert.ok(real.groups.length > 0, 'private fixture must open');
        console.log('Private KDBX fixture: PASS');
    }
    console.log('Synthetic KDBX roundtrip: PASS');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
