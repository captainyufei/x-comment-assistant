import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createBridge, BridgeError, REPLY_PROTOCOL} from './bridge.mjs';

const extensionId = 'a'.repeat(32);
const origin = `chrome-extension://${extensionId}`;
const token = 'transport-fixture-token-0123456789';
const popup = {id: extensionId, url: `${origin}/popup.html`};
const content = {id: extensionId, tab: {id: 7}, frameId: 0, documentId: 'transport-document', url: 'https://x.com/home'};
const context = {id: '1234567890123456789', url: 'https://x.com/example/status/1234567890123456789', text: '把自己的观察说清楚。'};
const publicSettings = {provider: 'deepseek', model: 'deepseek-flash', keyConfigured: true, checkScope: 'local'};
const candidates = ['witty', 'humor', 'insight', 'story'].map((style, i) => ({style, label: '回复角度', text: `这是中文回复候选内容 ${i}。`}));

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function harness(t) {
  const port = await freePort();
  const session = {}, local = {replyTransport: "bridge"}, callbacks = {}, calls = [];
  let reads = 0, writes = 0, runs = 0, readError = null;
  const releases = [];
  const runner = {
    health: {authenticated: true, writerProvider: 'deepseek', writerModel: 'deepseek-flash'},
    run() { runs++; return new Promise(resolve => releases.push(resolve)); }
  };
  const bridge = createBridge({port, token, runner, autoConnectOrigin: origin, writerSettings: {
    read() { reads++; if (readError) throw readError; return publicSettings; },
    async write() { writes++; return {runner, settings: publicSettings}; }
  }});
  bridge.server.listen(port, '127.0.0.1');
  await once(bridge.server, 'listening');
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  const area = data => ({async get(key) { return structuredClone({[key]: data[key]}); }, async set(values) { Object.assign(data, structuredClone(values)); }, async setAccessLevel() {}});
  globalThis.chrome = {
    storage: {session: area(session), local: area(local)},
    runtime: {id: extensionId, getURL: path => `${origin}/${path}`, onMessage: {addListener(fn) { callbacks.message = fn; }}, onInstalled: {addListener() {}}, async sendMessage() {}},
    action: {}, contextMenus: {onClicked: {addListener() {}}}, tabs: {onRemoved: {addListener() {}}}
  };
  // Chromium's privileged extension requests with host_permissions are basic
  // responses: GET does not attach Origin; POST does. This uses real HTTP and
  // the real bridge/background, not a stubbed endpoint response.
  // Primary browser regression: chrome/browser/extensions/fetch_apitest.cc,
  // FetchResponseType and OriginOnPostWithPermissions.
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const headers = new Headers(options.headers);
    if (!['GET', 'HEAD'].includes(options.method)) headers.set('Origin', origin);
    const response = await originalFetch(`http://127.0.0.1:${port}${path}`, {...options, headers});
    calls.push({path, method: options.method, origin: headers.get('Origin'), status: response.status});
    return response;
  };
  t.after(async () => {
    globalThis.fetch = originalFetch; globalThis.chrome = originalChrome;
    for (const release of releases) release({contextStatus: 'sufficient', missingContext: '', candidates});
    await bridge.stop();
  });
  await import(`./extension/background.js?transport=${Date.now()}-${Math.random()}`);
  const message = (data, sender = popup) => new Promise(resolve => callbacks.message(data, sender, resolve));
  const request = async (path, {method = 'POST', requestOrigin = origin, requestToken = token, protocol = REPLY_PROTOCOL, body = {}} = {}) => {
    const headers = {'Content-Type': 'application/json', ...(requestOrigin ? {Origin: requestOrigin} : {}), ...(requestToken ? {'X-Reply-Bridge-Token': requestToken} : {}), 'X-Reply-Protocol': protocol};
    const response = await originalFetch(`http://127.0.0.1:${port}${path}`, {method, headers, ...(!['GET', 'HEAD'].includes(method) ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, data: await response.json()};
  };
  return {message, request, session, calls, bridge, setReadError(error) { readError = error; }, counts() { return {reads, writes, runs}; }};
}

test('popup and inline generation agree through real HTTP with Chromium extension GET/POST Origin semantics', async t => {
  const h = await harness(t);
  const result = await h.message({type: 'popupState'});
  t.diagnostic(JSON.stringify({connectionStatus: result.connectionStatus, code: result.code, calls: h.calls}));
  assert.equal(result.connectionStatus, 'connected');
  assert.deepEqual(result.writerSettings, publicSettings);
  assert.ok(h.calls.some(call => call.path === '/health' && call.origin === null));
  assert.ok(h.calls.some(call => call.path === '/writer-settings/read' && call.method === 'POST' && call.origin === origin));
  assert.equal(h.session.replySessionState.pairingVerified, true);
  const initialized = await h.message({type: 'inlineInit', context}, content);
  const generated = await h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  assert.equal(generated.ok, true);
  assert.equal(h.counts().runs, 1);
  const settings = await h.message({type: 'getWriterSettings'});
  assert.equal(settings.ok, true);
  assert.deepEqual(settings.writerSettings, publicSettings);
  assert.equal(h.counts().writes, 0);
});

test('settings read errors never relabel a healthy connection, clear its token, or fail an active draft job', async t => {
  const h = await harness(t);
  const initialized = await h.message({type: 'inlineInit', context}, content);
  const generated = await h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  assert.equal(generated.ok, true);
  h.setReadError(new BridgeError('WRITER_SETTINGS_ORIGIN', '模型设置读取被拒绝。', 403));
  const state = await h.message({type: 'popupState'});
  assert.equal(state.connectionStatus, 'connected');
  assert.equal(state.health.authenticated, true);
  assert.equal(state.writerSettingsError.code, 'WRITER_SETTINGS_ORIGIN');
  assert.equal(h.session.replySessionState.pairingToken, token);
  assert.equal(h.session.replySessionState.pairingVerified, true);
  assert.equal(h.session.replySessionState.inlineSessions[initialized.sessionId].job.status, 'running');
  assert.equal(h.counts().writes, 0);
  assert.equal(JSON.stringify(state).includes(token), false);
  h.setReadError(null);
  const recovered = await h.message({type: 'popupState'});
  assert.equal(recovered.connectionStatus, 'connected');
  assert.equal(recovered.writerSettingsError, null);
  assert.deepEqual(recovered.writerSettings, publicSettings);
  h.setReadError(new BridgeError('UNPAIRED', '连接凭据已失效。', 401));
  const expired = await h.message({type: 'popupState'});
  assert.equal(expired.connectionStatus, 'auth-required');
  assert.equal(expired.writerSettingsError.code, 'PAIRING_EXPIRED');
  assert.equal(h.session.replySessionState.pairingToken, '');
  assert.equal(h.session.replySessionState.inlineSessions[initialized.sessionId].job.status, 'failed');
});

test('settings POST read keeps exact extension Origin, credential and protocol boundaries without changing writer', async t => {
  const h = await harness(t);
  const allowed = await h.request('/writer-settings/read');
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.data, publicSettings);
  for (const requestOrigin of [null, 'https://x.com', 'chrome-extension://' + 'b'.repeat(32)]) {
    assert.equal((await h.request('/writer-settings/read', {requestOrigin})).status, 403);
  }
  assert.equal((await h.request('/writer-settings/read', {requestToken: null})).status, 401);
  assert.equal((await h.request('/writer-settings/read', {protocol: '2'})).status, 409);
  assert.equal((await h.request('/writer-settings/read', {method: 'GET'})).status, 405);
  // Preserve the old endpoint's strict policy; don't fix the browser by
  // weakening Origin checks for arbitrary originless callers.
  assert.equal((await h.request('/writer-settings', {method: 'GET', requestOrigin: null})).status, 403);
  assert.deepEqual(h.counts(), {reads: 1, writes: 0, runs: 0});
});
