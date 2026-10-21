import test from 'node:test';
import assert from 'node:assert/strict';

const runtimeId = 'a'.repeat(32);
const fixtureToken = 'automatic-session-token-123456789';
const oldToken = 'expired-session-token-123456789';
const source = {contextKind: 'composer-visible', id: null, url: null, author: '@0xyouyu', authorName: '有鱼', text: '回复弹窗中的原文。', quote: '', hasMedia: false, capturedAt: '2026-10-10T12:00:00.000Z'};
const content = {id: runtimeId, tab: {id: 1}, frameId: 0, documentId: 'document-a', url: 'https://x.com/compose/post'};
const sibling = {...content, tab: {id: 2}, documentId: 'document-b'};
const setup = {id: runtimeId, tab: {id: 3}, frameId: 0, documentId: 'setup-document', url: `chrome-extension://${runtimeId}/setup.html`};
const candidates = ['witty', 'humor', 'insight', 'story'].map((style, i) => ({style, label: '中文角度', text: `中文候选 ${i}`, token: fixtureToken}));

async function harness(t, {saved = {}, autoResponse = {paired: true, token: fixtureToken}, autoStatus = 200, authenticated = true} = {}) {
  const session = {replySessionState: structuredClone(saved)};
  const local = {};
  const callbacks = {};
  const calls = [];
  const jobs = new Map();
  let jobNumber = 0;
  const chromePrevious = globalThis.chrome;
  const fetchPrevious = globalThis.fetch;
  const storageArea = data => ({
    async get(key) { return structuredClone({[key]: data[key]}); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); }
  });
  globalThis.chrome = {
    storage: {session: storageArea(session), local: storageArea(local)},
    runtime: {
      id: runtimeId, getURL(path) { return `chrome-extension://${runtimeId}/${path}`; },
      onMessage: {addListener(callback) { callbacks.message = callback; }},
      onInstalled: {addListener() {}}, async sendMessage() {}
    },
    action: {onClicked: {addListener() {}}},
    sidePanel: {async open() {}},
    contextMenus: {async removeAll() {}, create() {}, onClicked: {addListener() {}}},
    tabs: {async query() { return []; }, async create() { throw new Error('Automatic connection must not open a pairing page'); }, onRemoved: {addListener() {}}},
    scripting: {async executeScript() { throw new Error('Unexpected page capture'); }}
  };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, 'http://127.0.0.1:8769');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Origin, undefined);
    assert.equal(options.headers.origin, undefined);
    calls.push({path, method: options.method, body: options.body ? JSON.parse(options.body) : null});
    if (path === '/health') {
      assert.equal(options.headers['X-Reply-Bridge-Token'], undefined);
      assert.equal(options.headers['X-Reply-Protocol'], undefined);
      return Response.json({authenticated, authentication: 'ChatGPT', token: fixtureToken, pairingToken: fixtureToken});
    }
    if (path === '/extension/connect') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {extensionId: runtimeId});
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.headers['X-Reply-Bridge-Token'], undefined);
      assert.equal(options.headers['X-Reply-Protocol'], undefined);
      return Response.json(autoResponse, {status: autoStatus});
    }
    if (path === '/pair') {
      assert.equal(options.headers['X-Reply-Protocol'], '4');
      const valid = options.headers['X-Reply-Bridge-Token'] === fixtureToken;
      return valid ? Response.json({paired: true}) : Response.json({code: 'UNPAIRED', error: `stale ${oldToken}`}, {status: 401});
    }
    assert.equal(options.headers['X-Reply-Bridge-Token'], fixtureToken);
    assert.equal(options.headers['X-Reply-Protocol'], '4');
    if (path === '/jobs') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.context, source);
      assert.equal(body.preferences.style, 'all');
      assert.equal(Object.hasOwn(body.preferences, 'contextNote'), false);
      const job = {id: `auto-job-${++jobNumber}`, status: 'running', contextStatus: 'sufficient', missingContext: '', context: {...source, author: '@wrong'}, candidates: []};
      jobs.set(job.id, job);
      return Response.json({job});
    }
    const job = jobs.get(path.slice('/jobs/'.length));
    if (!job) return Response.json({code: 'JOB_NOT_FOUND', error: 'missing'}, {status: 404});
    if (options.method === 'DELETE') job.status = 'cancelled';
    return Response.json({job});
  };
  t.after(() => { globalThis.chrome = chromePrevious; globalThis.fetch = fetchPrevious; });
  const restore = () => import(`./extension/background.js?automatic-test=${Date.now()}-${Math.random()}`);
  await restore();
  const message = (value, sender = content) => new Promise(resolve => callbacks.message(value, sender, resolve));
  return {message, restore, session, local, calls, jobs};
}

test('approved-extension automatic connection remains private and source-bound across simultaneous reply windows', async t => {
  const h = await harness(t);
  for (const sender of [{...content, id: 'b'.repeat(32)}, {...content, url: 'https://attacker.test/'}, {...content, frameId: 1}, {...content, documentId: ''}]) {
    assert.equal((await h.message({type: 'inlineHealth'}, sender)).code, 'UNTRUSTED_SENDER');
  }
  assert.equal((await h.message({type: 'checkBridge'}, content)).code, 'UNTRUSTED_SENDER');
  assert.equal(h.calls.length, 0);
  const secondSource = {...source, author: '@other', text: '第二条弹窗原文。'};
  const initialized = await Promise.all([
    h.message({type: 'inlineInit', context: source, extensionId: 'b'.repeat(32)}),
    h.message({type: 'inlineInit', context: secondSource}, sibling)
  ]);
  assert.ok(initialized.every(reply => reply.ok && reply.paired));
  assert.notEqual(initialized[0].sessionId, initialized[1].sessionId);
  assert.equal(h.calls.filter(call => call.path === '/extension/connect').length, 1);
  assert.equal(JSON.stringify(initialized).includes(fixtureToken), false);
  assert.equal(h.session.replySessionState.pairingToken, fixtureToken);
  assert.equal(JSON.stringify(h.local).includes(fixtureToken), false);
  const firstSession = initialized[0].sessionId;
  assert.equal((await h.message({type: 'inlineGenerate', sessionId: firstSession}, sibling)).code, 'INLINE_SESSION_EXPIRED');
  const generated = await h.message({type: 'inlineGenerate', sessionId: firstSession});
  assert.equal(generated.ok, true);
  assert.deepEqual(generated.job.context, source);
  assert.equal(JSON.stringify(generated).includes(fixtureToken), false);
  h.jobs.get(generated.job.id).status = 'completed';
  h.jobs.get(generated.job.id).candidates = candidates;
  const completed = await h.message({type: 'inlinePoll', sessionId: firstSession, id: generated.job.id});
  assert.ok(completed.job.candidates.every(candidate => candidate.context.author === source.author));
  assert.equal(JSON.stringify(completed).includes(fixtureToken), false);
  assert.equal((await h.message({type: 'inlinePoll', sessionId: initialized[1].sessionId, id: generated.job.id}, sibling)).code, 'JOB_NOT_FOUND');
  const checked = await h.message({type: 'checkBridge'}, setup);
  assert.equal(checked.paired, true);
  assert.equal(JSON.stringify(checked).includes(fixtureToken), false);
});

test('automatic reconnect replaces expired credentials without mixing restored sessions or stale running jobs', async t => {
  const oldSessionId = 'restored-session';
  const h = await harness(t, {saved: {
    pairingToken: oldToken, pairingVerified: true,
    inlineSessions: {[oldSessionId]: {owner: {tabId: 1, frameId: 0, documentId: 'document-a'}, context: source,
      job: {id: 'expired-job', status: 'running', preferences: {style: 'mix', personalExperience: '', tone: ''}}}}
  }});
  const connected = await h.message({type: 'inlineHealth'});
  assert.equal(connected.paired, true);
  assert.deepEqual(h.calls.map(call => call.path), ['/health', '/pair', '/extension/connect']);
  assert.equal(h.session.replySessionState.pairingToken, fixtureToken);
  assert.equal(h.session.replySessionState.inlineSessions[oldSessionId].job.status, 'failed');
  assert.equal(JSON.stringify(connected).includes(fixtureToken), false);
  assert.equal(JSON.stringify(connected).includes(oldToken), false);
  assert.equal((await h.message({type: 'inlineGenerate', sessionId: oldSessionId}, {...content, documentId: 'replacement'})).code, 'INLINE_SESSION_EXPIRED');
  const resumed = await h.message({type: 'inlineGenerate', sessionId: oldSessionId});
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.job.context, source);
  await h.restore();
  const before = h.calls.length;
  assert.equal((await h.message({type: 'inlineHealth'})).paired, true);
  assert.deepEqual(h.calls.slice(before).map(call => call.path), ['/health', '/pair']);
  assert.equal(h.calls.filter(call => call.path === '/extension/connect').length, 1);
});

test('malformed automatic success responses never store or expose the proposed credential', async t => {
  let fixtureNumber = 0;
  for (const autoResponse of [
    null, [], {}, {paired: true}, {paired: true, token: 'short'},
    {paired: true, token: 'x'.repeat(257)}, {paired: true, token: `${fixtureToken} secret`},
    {paired: false, token: fixtureToken}, {paired: 'true', token: fixtureToken}, {token: fixtureToken}
  ]) await t.test(`reject malformed fixture ${++fixtureNumber}`, async sub => {
    const h = await harness(sub, {autoResponse});
    const result = await h.message({type: 'inlineInit', context: source});
    assert.equal(result.code, 'INVALID_RESPONSE');
    assert.equal(JSON.stringify(result).includes(fixtureToken), false);
    assert.equal(h.session.replySessionState.pairingToken, undefined);
    assert.equal(Object.keys(h.session.replySessionState.inlineSessions ?? {}).length, 0);
    assert.equal(JSON.stringify(h.local).includes(fixtureToken), false);
  });
});

test('automatic Origin rejection is preserved as a trust error and cannot turn into manual pairing instructions', async t => {
  const h = await harness(t, {autoStatus: 403, autoResponse: {code: 'EXTENSION_NOT_TRUSTED', error: '该插件尚未获得本机服务授权。'}});
  const denied = await h.message({type: 'inlineHealth'});
  assert.equal(denied.code, 'EXTENSION_NOT_TRUSTED');
  assert.match(denied.error, /尚未获得.*授权/);
  assert.doesNotMatch(denied.error, /配对码|复制/);
  assert.equal(h.session.replySessionState.pairingToken, undefined);
});

test('older services without automatic connection clearly require an update rather than copied credentials', async t => {
  for (const [autoStatus, autoResponse] of [[401, {code: 'UNPAIRED', error: '配对码无效'}], [404, {code: 'NOT_FOUND', error: 'unknown'}]]) {
    await t.test(`old service ${autoStatus}`, async sub => {
      const h = await harness(sub, {autoStatus, autoResponse});
      const result = await h.message({type: 'checkBridge'}, setup);
      assert.equal(result.code, 'BRIDGE_UPDATE_REQUIRED');
      assert.match(result.error, /更新并重新启动本机 Codex 服务/);
      assert.doesNotMatch(result.error, /配对码|复制/);
      assert.equal(h.session.replySessionState.pairingToken, undefined);
    });
  }
});

test('automatic connection does not obtain credentials while Codex is not authenticated', async t => {
  const h = await harness(t, {authenticated: false});
  const result = await h.message({type: 'inlineInit', context: source});
  assert.equal(result.code, 'AUTH_REQUIRED');
  assert.deepEqual(h.calls.map(call => call.path), ['/health']);
  assert.equal(h.session.replySessionState.pairingToken, undefined);
});
