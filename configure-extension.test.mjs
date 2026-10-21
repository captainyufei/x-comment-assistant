import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureExtension, ExtensionConfigurationError, runConfigurationCommand} from './configure-extension.mjs';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'x-reply-extension-identity-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const path = join(root, 'extension-trust.json');
  return {root, path, read:() => fs.readFile(path, 'utf8')};
}

test('explicit first setup publishes only the requested public ID and no staging file', async t => {
  const f = await fixture(t);
  const result = await configureExtension({extensionId:ID_A, sourceRoot:f.root});
  assert.deepEqual(result, {ok:true, changed:true, extensionId:ID_A, path:f.path});
  assert.deepEqual(JSON.parse(await f.read()), {extensionId:ID_A});
  assert.deepEqual(await fs.readdir(f.root), ['extension-trust.json']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600);
});

test('same ID is idempotent and a different ID requires an explicit replace', async t => {
  const f = await fixture(t);
  await configureExtension({extensionId:ID_A, sourceRoot:f.root});
  const bytes = await f.read();
  const before = await fs.stat(f.path);
  assert.equal((await configureExtension({extensionId:ID_A, sourceRoot:f.root})).changed, false);
  assert.equal((await fs.stat(f.path)).mtimeMs, before.mtimeMs);
  await assert.rejects(configureExtension({extensionId:ID_B, sourceRoot:f.root}), {code:'EXTENSION_ID_EXISTS'});
  assert.equal(await f.read(), bytes);
  assert.equal((await configureExtension({extensionId:ID_B, sourceRoot:f.root, replace:true})).changed, true);
  assert.deepEqual(JSON.parse(await f.read()), {extensionId:ID_B});
});

test('malformed IDs and roots fail before writing configuration', async t => {
  const f = await fixture(t);
  for (const extensionId of [undefined, '', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'q'.repeat(32), ` ${ID_A}`, `${ID_A}\n`, 'chrome-extension://' + ID_A]) {
    await assert.rejects(configureExtension({extensionId, sourceRoot:f.root}), {code:'INVALID_EXTENSION_ID'});
  }
  for (const sourceRoot of ['relative', `${f.root}\n`, null]) {
    await assert.rejects(configureExtension({extensionId:ID_A, sourceRoot}), {code:'INVALID_SOURCE_ROOT'});
  }
  await assert.rejects(configureExtension({extensionId:ID_A, sourceRoot:f.root, replace:'yes'}), {code:'INVALID_REPLACE'});
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('linked, non-file, oversized and malformed existing configs are never overwritten', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'preserved.txt');
  await fs.writeFile(outside, 'preserve');
  if (process.platform !== 'win32') {
    await fs.symlink(outside, f.path);
    await assert.rejects(configureExtension({extensionId:ID_A, sourceRoot:f.root, replace:true}), {code:'UNSAFE_TRUST_FILE'});
    assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
    await fs.rm(f.path);
  }
  await fs.mkdir(f.path);
  await assert.rejects(configureExtension({extensionId:ID_A, sourceRoot:f.root, replace:true}), {code:'UNSAFE_TRUST_FILE'});
  await fs.rm(f.path, {recursive:true});
  for (const value of ['not-json', '{}', JSON.stringify({extensionId:ID_A, extra:'not allowed'}), JSON.stringify({extensionId:'invalid'}), ' '.repeat(1025)]) {
    await fs.writeFile(f.path, value);
    await assert.rejects(configureExtension({extensionId:ID_A, sourceRoot:f.root, replace:true}), {code:'INVALID_TRUST_FILE'});
    assert.equal(await f.read(), value);
  }
});

test('first creation cannot overwrite a config concurrently created before atomic publication', async t => {
  const f = await fixture(t);
  const fsImpl = {...fs, async link(from, to) {
    await fs.writeFile(to, `${JSON.stringify({extensionId:ID_B})}\n`, {flag:'wx'});
    return fs.link(from, to);
  }};
  await assert.rejects(configureExtension({extensionId:ID_A, sourceRoot:f.root, fsImpl}), {code:'TRUST_FILE_CHANGED'});
  assert.deepEqual(JSON.parse(await f.read()), {extensionId:ID_B});
  assert.deepEqual(await fs.readdir(f.root), ['extension-trust.json']);
});

test('explicit replacement detects a concurrent content change and preserves the newer config', async t => {
  const f = await fixture(t);
  await configureExtension({extensionId:ID_A, sourceRoot:f.root});
  const updated = `${JSON.stringify({extensionId:'c'.repeat(32)})}\n`;
  const fsImpl = {...fs, async open(path, ...args) {
    if (path.endsWith('.tmp')) await fs.writeFile(f.path, updated);
    return fs.open(path, ...args);
  }};
  await assert.rejects(configureExtension({extensionId:ID_B, sourceRoot:f.root, replace:true, fsImpl}), {code:'TRUST_FILE_CHANGED'});
  assert.equal(await f.read(), updated);
  assert.deepEqual(await fs.readdir(f.root), ['extension-trust.json']);
});

test('write failures clean staging files, preserve existing configuration and hide raw errors', async t => {
  const f = await fixture(t);
  await configureExtension({extensionId:ID_A, sourceRoot:f.root});
  const original = await f.read();
  const fsImpl = {...fs, async rename() { throw new Error('fixture-sensitive-system-error'); }};
  await assert.rejects(configureExtension({extensionId:ID_B, sourceRoot:f.root, replace:true, fsImpl}), failure => {
    assert.equal(failure.code, 'TRUST_FILE_WRITE_FAILED');
    assert.doesNotMatch(failure.message, /fixture-sensitive/);
    return true;
  });
  assert.equal(await f.read(), original);
  assert.deepEqual(await fs.readdir(f.root), ['extension-trust.json']);
});

test('CLI help and invalid arguments never call setup; explicit arguments are forwarded once', async () => {
  const calls = [], output = [], errors = [];
  const dependencies = {configure:async input => { calls.push(input); return {changed:true, extensionId:input.extensionId, path:'/fixture/extension-trust.json'}; }, write:text => output.push(text), error:text => errors.push(text)};
  assert.equal(await runConfigurationCommand(['--help'], dependencies), 0);
  for (const args of [[], ['--extension-id'], ['--unknown', ID_A], ['--extension-id', ID_A, '--extension-id', ID_B], ['--extension-id', ID_A, '--replace', '--replace']]) {
    assert.equal(await runConfigurationCommand(args, dependencies), 1);
  }
  assert.deepEqual(calls, []);
  assert.equal(await runConfigurationCommand(['--extension-id', ID_A, '--replace'], dependencies), 0);
  assert.deepEqual(calls, [{extensionId:ID_A, replace:true}]);
  assert.match(output.at(-1), /不会自动安装或重启服务/);
});

test('CLI prints only controlled failure messages', async () => {
  const messages = [];
  for (const failure of [new Error('fixture-secret'), new ExtensionConfigurationError('EXTENSION_ID_EXISTS', '已有不同的扩展 ID，未覆盖。')]) {
    assert.equal(await runConfigurationCommand(['--extension-id', ID_A], {configure:async () => { throw failure; }, error:text => messages.push(text)}), 1);
  }
  assert.doesNotMatch(messages.join('\n'), /fixture-secret/);
  assert.match(messages[0], /CONFIGURATION_FAILED/);
  assert.match(messages[1], /EXTENSION_ID_EXISTS/);
});
