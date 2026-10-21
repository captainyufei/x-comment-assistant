import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html = await readFile(new URL('./extension/setup.html', import.meta.url), 'utf8');
const script = await readFile(new URL('./extension/setup.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(t, respond) {
  const dom = new JSDOM(html, {url: `https://extension-fixture.test/setup.html`, runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.chrome = {runtime: {async sendMessage(message) { calls.push(structuredClone(message)); return respond(message); }}};
  dom.window.eval(script);
  return {dom, calls, doc: dom.window.document};
}

function assertSimpleConnectionPage(h) {
  assert.equal(h.doc.querySelectorAll('button').length, 1);
  assert.equal(h.doc.querySelectorAll('input, textarea').length, 0);
  assert.equal(h.doc.querySelector('a[href*="/connect"]'), null);
  assert.equal(h.calls.some(call => ['saveSettings', 'inlinePair', 'inlineOpenSetup'].includes(call.type)), false);
  return h.doc.querySelector('button');
}

test('the legacy setup entry automatically checks connection without a pairing field or another page', async t => {
  const fixtureCredential = 'fixture-local-private-auto-credential';
  const h = setup(t, async message => {
    assert.equal(message.type, 'checkBridge');
    return {ok: true, paired: true, health: {authenticated: true, token: fixtureCredential}};
  });
  await settle();
  assert.deepEqual(h.calls, [{type: 'checkBridge'}]);
  const button = assertSimpleConnectionPage(h);
  assert.equal(button.disabled, false);
  assert.match(h.doc.getElementById('status').textContent, /连接成功/);
  assert.match(h.doc.getElementById('status').textContent, /X 回复框/);
  assert.equal(h.doc.body.textContent.includes(fixtureCredential), false);
  assert.equal(JSON.stringify(h.calls).includes(fixtureCredential), false);
});

test('one setup connection click uses automatic background connection and returns users to their existing reply', async t => {
  let connected = false;
  const h = setup(t, async message => {
    assert.equal(message.type, 'checkBridge');
    return {ok: true, paired: connected, health: {authenticated: true}};
  });
  await settle();
  const button = assertSimpleConnectionPage(h);
  assert.equal(button.disabled, false);
  connected = true; button.click();
  await settle();
  assert.deepEqual(h.calls, [{type: 'checkBridge'}, {type: 'checkBridge'}]);
  assert.match(h.doc.getElementById('status').textContent, /连接成功/);
  assert.match(h.doc.getElementById('status').textContent, /X 回复框/);
  assert.equal(button.disabled, false);
  assertSimpleConnectionPage(h);
});

test('an offline local service leaves the single setup action usable and recovers without credentials', async t => {
  let online = false;
  const h = setup(t, async message => {
    assert.equal(message.type, 'checkBridge');
    return online ? {ok: true, paired: true, health: {authenticated: true}} : {ok: false, code: 'BRIDGE_UNAVAILABLE', error: '本机 Codex 服务未启动，请启动服务后重试。'};
  });
  await settle();
  const button = assertSimpleConnectionPage(h);
  assert.match(h.doc.getElementById('status').textContent, /本机 Codex 服务未启动/);
  assert.equal(button.disabled, false);
  online = true; button.click();
  await settle();
  assert.match(h.doc.getElementById('status').textContent, /连接成功/);
  assert.equal(button.disabled, false);
  assert.equal(h.calls.length, 2);
  assertSimpleConnectionPage(h);
});

test('the single setup action prevents duplicate connection requests and unlocks after the check completes', async t => {
  let complete;
  const h = setup(t, message => {
    assert.equal(message.type, 'checkBridge');
    if (!complete) return new Promise(resolve => { complete = resolve; });
    return {ok: true, paired: true, health: {authenticated: true}};
  });
  await settle();
  const button = assertSimpleConnectionPage(h);
  assert.equal(button.disabled, true);
  button.click(); button.click();
  assert.equal(h.calls.length, 1);
  complete({ok: true, paired: true, health: {authenticated: true}});
  await settle();
  assert.equal(button.disabled, false);
  assert.match(h.doc.getElementById('status').textContent, /连接成功/);
  button.click(); await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(button.disabled, false);
});
