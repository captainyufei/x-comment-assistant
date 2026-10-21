import test from 'node:test';
import assert from 'node:assert/strict';

const runtimeId = 'a'.repeat(32), fixtureToken = 'test-local-credential-0123456789';
const source = {id: '1234567890123456789', url: 'https://x.com/demo_user/status/1234567890123456789', text: '太好了，又加班到凌晨两点。', authorName: '示例用户'};
const sender = {id: runtimeId, tab: {id: 1}, frameId: 0, documentId: 'document-a', url: 'https://x.com/compose/post'};
const panel = {id: runtimeId, url: `chrome-extension://${runtimeId}/panel.html`};
const setup = {id: runtimeId, tab: {id: 4}, frameId: 0, documentId: 'setup-document', url: `chrome-extension://${runtimeId}/setup.html`};
const understanding = {meaning: '作者在反讽加班，想有人接住吐槽。', signals: ['反讽', '吐槽'], evidence: ['太好了与凌晨加班形成反差。'], contextStatus: 'sufficient', missingContext: '', replyAction: '顺着加班的吐槽接一句，不祝贺。'};
const candidates = [
  {style: 'witty', label: '认可并展开', text: '凌晨两点还在加班，确实很难高兴起来。难受的可能不只是少睡几个小时，还有第二天照常上班的无力感。'},
  {style: 'humor', label: '幽默接梗', text: '太好了，明天的困意提前到账。觉还没睡，欠账先记上了。'},
  {style: 'insight', label: '补充观点', text: '偶尔赶一次还好，要是经常拖到凌晨，可能得看看哪些需求是真的急，哪些只是一直没排好。'},
  {style: 'story', label: '小故事', text: '比如刚合上电脑，手机又弹出一条“明早再看也行”。最难受的可能就是这句本可以早点说的话。'},
];
const compact = {contextStatus: 'sufficient', missingContext: ''};

async function harness(t) {
  const session = {}, local = {replyTransport: "bridge"}, callbacks = {}, calls = [], submitted = [], jobs = new Map(), openedTabs = [];
  const protocol = {rejectCreate: false, rejectRead: false};
  let jobCount = 0;
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  const area = data => ({
    async get(key) { return structuredClone({[key]: data[key]}); },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); }
  });
  globalThis.chrome = {
    storage: {session: area(session), local: area(local)},
    runtime: {id: runtimeId, getURL(path) { return `chrome-extension://${runtimeId}/${path}`; }, onMessage: {addListener(fn) { callbacks.message = fn; }}, onInstalled: {addListener() {}}, async sendMessage() {}},
    action: {onClicked: {addListener() {}}}, sidePanel: {async open() {}},
    contextMenus: {async removeAll() {}, create() {}, onClicked: {addListener() {}}},
    tabs: {async query() { return []; }, async create(options) { openedTabs.push(options.url); }, onRemoved: {addListener() {}}}, scripting: {async executeScript() { throw new Error('No browser access expected'); }}
  };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname; calls.push(path);
    assert.equal(new URL(url).origin, 'http://127.0.0.1:8769', 'protocol and credentials never go to X');
    if (path === '/health' || path === '/extension/connect') {
      assert.equal(options.headers['X-Reply-Protocol'], undefined);
      assert.equal(options.headers['X-Reply-Bridge-Token'], undefined);
      return Response.json(path === '/health' ? {authenticated: true, replyProtocol: '4'} : {paired: true, token: fixtureToken});
    }
    assert.equal(options.headers['X-Reply-Protocol'], '4');
    if (path === '/pair') return Response.json({paired: true});
    assert.equal(options.headers['X-Reply-Bridge-Token'], fixtureToken);
    if ((path === '/jobs' && protocol.rejectCreate) || (path.startsWith('/jobs/') && options.method === 'GET' && protocol.rejectRead)) return Response.json({error: '本机服务已更新，请在扩展页重新加载“X Comment Assistant”，刷新 X 后再生成。', code: 'EXTENSION_UPDATE_REQUIRED'}, {status: 409});
    if (path === '/jobs') {
      submitted.push(JSON.parse(options.body));
      const job = {id: `job-${++jobCount}`, status: 'running'}; jobs.set(job.id, job); return Response.json({job});
    }
    const job = jobs.get(path.slice('/jobs/'.length));
    if (options.method === 'DELETE') job.status = 'cancelled';
    return Response.json({job});
  };
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  const restore = () => import(`./extension/background.js?understanding-test=${Date.now()}-${Math.random()}`);
  await restore();
  const message = (value, owner = sender) => new Promise(resolve => callbacks.message(value, owner, resolve));
  const initialize = async (context = source, owner = sender) => (await message({type: 'inlineInit', context}, owner)).sessionId;
  const complete = async (sessionId, fields = {}, owner = sender) => {
    const started = await message({type: 'inlineGenerate', sessionId, preferences: {contextNote: '顺着吐槽接话。'}}, owner);
    Object.assign(jobs.get(started.job.id), {status: 'completed', candidates, ...compact}, fields);
    return message({type: 'inlinePoll', sessionId, id: started.job.id}, owner);
  };
  return {message, restore, initialize, complete, session, local, calls, submitted, jobs, openedTabs, protocol};
}

test('new completed jobs preserve compact status and a missing-context zero result across worker restoration', async t => {
  const h = await harness(t), sessionId = await h.initialize();
  assert.equal(h.jobs.size, 0, 'opening a reply session never starts generation');
  assert.equal(h.calls.filter(path => path === '/jobs').length, 0);
  const completed = await h.complete(sessionId, {timings: {totalMs: 2100, providerMs: 2000, token: fixtureToken, secret: {token: fixtureToken}, invalid: -1}});
  assert.equal(completed.ok, true);
  assert.equal(completed.job.contextStatus, 'sufficient');
  assert.equal(completed.job.missingContext, '');
  assert.equal(completed.job.understanding, undefined);
  assert.equal(completed.job.candidates.length, 4);
  assert.deepEqual(completed.job.timings, {totalMs: 2100, providerMs: 2000});
  assert.equal(h.submitted[0].preferences.style, 'all');
  assert.equal(h.submitted.length, 1, 'all four replies belong to a single explicit generation request');
  assert.equal(Object.hasOwn(h.submitted[0].preferences, 'contextNote'), false, 'retired context notes are never forwarded');
  assert.equal(JSON.stringify(completed).includes(fixtureToken), false);
  await h.restore();
  const restored = await h.message({type: 'inlinePoll', sessionId, id: completed.job.id});
  assert.equal(restored.job.understanding, undefined);
  assert.equal(restored.job.contextStatus, 'sufficient');
  assert.equal(restored.job.candidates.length, 4);
  const missing = {contextStatus: 'missing', missingContext: '缺少视频对白，仅封面不足以确定含义。'};
  const empty = await h.complete(sessionId, {candidates: [], ...missing});
  assert.equal(empty.ok, true); assert.deepEqual(empty.job.candidates, []); assert.equal(empty.job.contextStatus, missing.contextStatus); assert.equal(empty.job.missingContext, missing.missingContext);
  await h.restore();
  assert.deepEqual((await h.message({type: 'inlinePoll', sessionId, id: empty.job.id})).job.candidates, []);
});

test('legacy interpretation cache retains one or two natural choices without regeneration', async t => {
  const h = await harness(t), sessionId = await h.initialize();
  for (const count of [1, 2]) {
    const legacy = {id: `legacy-${count}`, status: 'completed', candidates: candidates.slice(0, count), understanding: {...understanding, token: fixtureToken}, preferences: {style: 'mix', personalExperience: '', tone: ''}};
    h.session.replySessionState.inlineSessions[sessionId].job = legacy;
    await h.restore();
    const before = h.calls.length;
    const restored = await h.message({type: 'inlinePoll', sessionId, id: legacy.id});
    assert.equal(restored.ok, true);
    assert.equal(restored.job.candidates.length, count);
    assert.deepEqual(restored.job.understanding, understanding);
    assert.equal(JSON.stringify(restored).includes(fixtureToken), false);
    assert.equal(h.calls.length, before, 'reading a legacy completed cache does not invoke the bridge');
    assert.equal(h.submitted.length, 0, 'restoring legacy replies does not generate another result');
  }
});

test('the protocol-three extension accepts fuller replies without pinning the former eighty-character limit', async t => {
  const h = await harness(t);
  h.local.replyPreferences = {style: 'mix', maxChars: 80};
  await h.restore();
  const sessionId = await h.initialize();
  const fuller = [{style: 'witty', label: '完整接话', text: '中'.repeat(119) + '🙂'}, ...candidates.slice(1)];
  const completed = await h.complete(sessionId, {candidates: fuller});
  assert.equal(h.submitted.length, 1);
  assert.equal(Object.hasOwn(h.submitted[0].preferences, 'maxChars'), false, 'old extension requests leave the backend default available');
  assert.equal(completed.ok, true);
  assert.equal(completed.job.candidates[0].text, fuller[0].text, 'a 120-character reply is neither truncated nor rejected');
  assert.deepEqual(h.openedTabs, [], 'generation and polling never open a publishing flow');
  await h.restore();
  const restored = await h.message({type: 'inlinePoll', sessionId, id: completed.job.id});
  assert.equal(restored.job.candidates[0].text, fuller[0].text);
  assert.equal(h.submitted.length, 1, 'restoring a worker does not regenerate a completed reply');
});

test('protocol rejection retains the update code and never silently starts another generation', async t => {
  const h = await harness(t), sessionId = await h.initialize();
  h.protocol.rejectCreate = true;
  const createError = await h.message({type: 'inlineGenerate', sessionId});
  assert.equal(createError.ok, false); assert.equal(createError.code, 'EXTENSION_UPDATE_REQUIRED');
  assert.match(createError.error, /重新加载“X Comment Assistant”/); assert.equal(h.jobs.size, 0);
  assert.equal(h.calls.filter(path => path === '/jobs').length, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.filter(path => path === '/jobs').length, 1, 'there is no automatic retry or fallback');
  h.protocol.rejectCreate = false;
  const started = await h.message({type: 'inlineGenerate', sessionId});
  assert.equal(started.ok, true); assert.equal(h.jobs.size, 1);
  h.protocol.rejectRead = true;
  const pollError = await h.message({type: 'inlinePoll', sessionId, id: started.job.id});
  assert.equal(pollError.code, 'EXTENSION_UPDATE_REQUIRED');
  const createCalls = h.calls.filter(path => path === '/jobs').length;
  const nextError = await h.message({type: 'inlineGenerate', sessionId});
  assert.equal(nextError.code, 'EXTENSION_UPDATE_REQUIRED');
  assert.equal(h.calls.filter(path => path === '/jobs').length, createCalls, 'failed reconciliation cannot open another AI job');
  assert.equal(h.jobs.size, 1);
});

test('a restored failed update job keeps its code and opening X sends no protocol or credential HTTP request', async t => {
  const h = await harness(t), sessionId = await h.initialize();
  const started = await h.message({type: 'inlineGenerate', sessionId});
  Object.assign(h.jobs.get(started.job.id), {status: 'failed', code: 'EXTENSION_UPDATE_REQUIRED', error: '本机服务已更新，请重新加载 X Comment Assistant。'});
  const failed = await h.message({type: 'inlinePoll', sessionId, id: started.job.id});
  assert.equal(failed.job.status, 'failed'); assert.equal(failed.job.code, 'EXTENSION_UPDATE_REQUIRED');
  await h.restore();
  const restored = await h.message({type: 'inlinePoll', sessionId, id: started.job.id});
  assert.equal(restored.job.code, 'EXTENSION_UPDATE_REQUIRED');
  const before = h.calls.length;
  const opened = await h.message({type: 'openReply', context: source, draftText: '又得拿明天的觉来还了。'}, panel);
  assert.equal(opened.opened, true); assert.equal(h.calls.length, before);
  assert.equal(new URL(h.openedTabs.at(-1)).origin, 'https://x.com');
  assert.equal(JSON.stringify(h.openedTabs).includes(fixtureToken), false);
  assert.equal(JSON.stringify(h.openedTabs).includes('X-Reply-Protocol'), false);
});

test('malformed context status, optional legacy understanding and contradictory counts cannot become completed inline jobs', async t => {
  const h = await harness(t), sessionId = await h.initialize();
  for (const fields of [
    {understanding: null}, {understanding: {...understanding, meaning: '中'.repeat(201)}},
    {contextStatus: 'unknown'}, {contextStatus: 'missing', missingContext: '', candidates: []},
    {contextStatus: 'missing', missingContext: '缺少视频对白。'},
    {contextStatus: 'sufficient', candidates: []}, {candidates: candidates.slice(0, 2)},
    {candidates: [...candidates, {style: 'insight', label: '第五句', text: '第五个不同候选。'}]},
    {candidates: [...candidates.slice(0, 3), {...candidates[3], style: 'insight'}]}
  ]) {
    const started = await h.message({type: 'inlineGenerate', sessionId});
    Object.assign(h.jobs.get(started.job.id), {status: 'completed', candidates, ...compact}, fields);
    const invalid = await h.message({type: 'inlinePoll', sessionId, id: started.job.id});
    assert.equal(invalid.ok, false); assert.equal(h.session.replySessionState.inlineSessions[sessionId].job.status, 'running');
    h.jobs.get(started.job.id).status = 'cancelled';
    await h.message({type: 'inlinePoll', sessionId, id: started.job.id});
  }
});

test('explicit notes bind to the owned completed job and are read only by the extension panel', async t => {
  const h = await harness(t), sessionId = await h.initialize();
  const started = await h.message({type: 'inlineGenerate', sessionId});
  const note = {type: 'inlineFeedback', sessionId, id: started.job.id, feedback: {category: 'voice', note: '我不会说“困意提前到账”。'} };
  assert.equal((await h.message(note)).code, 'JOB_NOT_FOUND');
  Object.assign(h.jobs.get(started.job.id), {status: 'completed', candidates, ...compact});
  await h.message({type: 'inlinePoll', sessionId, id: started.job.id});
  assert.equal(h.local.replyInlineFeedback, undefined, 'generation/reading never records approval');
  const before = h.calls.length;
  for (const owner of [{...sender, tab: {id: 2}}, {...sender, documentId: 'new-document'}, {...sender, frameId: 1}]) assert.equal((await h.message(note, owner)).ok, false);
  for (const altered of [{...note, id: 'other-job'}, {...note, context: source}, {...note, feedback: {...note.feedback, context: source}}, {...note, feedback: {category: 'voice', note: ''}}, {...note, feedback: {category: 'voice', note: '中'.repeat(1201)}}]) assert.equal((await h.message(altered)).ok, false);
  assert.equal(h.local.replyInlineFeedback, undefined);
  const saved = await h.message(note);
  assert.deepEqual(saved, {ok: true, saved: true, count: 1});
  assert.equal(h.calls.length, before, 'saving feedback never calls model or bridge');
  const [record] = h.local.replyInlineFeedback;
  assert.equal(record.jobId, started.job.id); assert.equal(record.context.id, source.id); assert.equal(record.understanding, undefined);
  assert.deepEqual(record.candidates, candidates); assert.equal(record.contextNote, '');
  assert.equal(record.note, note.feedback.note); assert.equal(record.category, 'voice');
  assert.equal(JSON.stringify(h.local).includes(fixtureToken), false);
  assert.equal((await h.message({type: 'getFeedback'})).code, 'UNTRUSTED_SENDER');
  assert.equal((await h.message({type: 'getFeedback'}, setup)).code, 'UNTRUSTED_SENDER');
  assert.deepEqual((await h.message({type: 'getFeedback'}, panel)).feedback, [record]);
  await h.restore();
  assert.deepEqual((await h.message({type: 'getFeedback'}, panel)).feedback, [record]);
  const next = await h.message({type: 'inlineGenerate', sessionId});
  assert.notEqual(next.job.id, started.job.id); assert.equal((await h.message(note)).code, 'JOB_NOT_FOUND');
  assert.equal(h.local.replyInlineFeedback.length, 1);
});

test('local opinion retention is bounded and malformed stored records or secret extra fields are discarded', async t => {
  const h = await harness(t), sessionId = await h.initialize(), completed = await h.complete(sessionId);
  const note = {type: 'inlineFeedback', sessionId, id: completed.job.id, feedback: {category: 'other', note: '这句可以再短一点。'}};
  await h.message(note);
  const seed = h.local.replyInlineFeedback[0];
  h.local.replyInlineFeedback = Array.from({length: 350}, (_, i) => ({...seed, id: `note-${i}`, token: fixtureToken, context: {...seed.context, token: fixtureToken}}));
  h.local.replyInlineFeedback.push({...seed, note: '中'.repeat(1201)}, {...seed, context: {url: 'https://attacker.test/'}}, {id: 'broken', token: fixtureToken});
  const saved = await h.message(note);
  assert.equal(saved.count, 298); // Only the last 300 records are inspected, including 3 corrupt records.
  assert.equal(h.local.replyInlineFeedback.length, 298);
  assert.equal(JSON.stringify(h.local.replyInlineFeedback).includes(fixtureToken), false);
  assert.ok(h.local.replyInlineFeedback.every(record => record.note.length <= 1200 && record.candidates.length <= 4));
  h.local.replyInlineFeedback = Array.from({length: 350}, (_, i) => ({...seed, id: `valid-${i}`}));
  assert.equal((await h.message(note)).count, 300); assert.equal(h.local.replyInlineFeedback.length, 300);
});
