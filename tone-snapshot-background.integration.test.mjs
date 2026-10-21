import test from 'node:test';
import assert from 'node:assert/strict';

const runtimeId = 'a'.repeat(32), token = 'tone-fixture-private-token-0123456789';
const popup = {id: runtimeId, url: `chrome-extension://${runtimeId}/popup.html`};
const content = {id: runtimeId, tab: {id: 7}, frameId: 0, documentId: 'tone-reply-document', url: 'https://x.com/home'};
const context = {id: '1234567890123456789', url: 'https://x.com/demo_user/status/1234567890123456789', text: '把自己的观察说清楚。'};
const candidates = ['witty', 'humor', 'insight', 'story'].map((style, i) => ({style, replyStyle: 'professional', label: '上游不可信标签', text: `中文候选 ${i}`}));

async function harness(t, {beforeJobResponse} = {}) {
  const session = {}, local = {replyPreferences: {style: 'all', tone: '私人口吻不得投影到页面', personalExperience: '私密经历不得投影到页面'}};
  const callbacks = {}, requests = [], jobs = new Map(); let nextJob = 0;
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  const area = data => ({async get(key) {return structuredClone({[key]: data[key]});}, async set(values) {Object.assign(data, structuredClone(values));}, async setAccessLevel() {}});
  globalThis.chrome = {
    storage: {session: area(session), local: area(local)},
    runtime: {id: runtimeId, getURL: path => `chrome-extension://${runtimeId}/${path}`, onMessage: {addListener(cb) {callbacks.message = cb;}}, onInstalled: {addListener() {}}, async sendMessage() {}},
    action: {openPopup() {return Promise.resolve();}},
    contextMenus: {async removeAll() {}, create() {}, onClicked: {addListener() {}}},
    tabs: {onRemoved: {addListener() {}}}
  };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return Response.json({authenticated: true, writerProvider: 'deepseek', writerModel: 'deepseek-flash'});
    if (path === '/extension/connect') return Response.json({paired: true, token});
    assert.equal(options.headers['X-Reply-Bridge-Token'], token);
    if (path === '/jobs') {
      requests.push(JSON.parse(options.body));
      await beforeJobResponse?.(requests.at(-1));
      const job = {id: `tone-job-${++nextJob}`, status: 'running'}; jobs.set(job.id, job); return Response.json({job});
    }
    const job = jobs.get(path.slice('/jobs/'.length));
    if (job) return Response.json({job});
    throw new Error(`Unexpected endpoint ${path}`);
  };
  t.after(() => {globalThis.chrome = oldChrome; globalThis.fetch = oldFetch;});
  const restore = () => import(`./extension/background.js?tone-test=${Date.now()}-${Math.random()}`);
  await restore();
  const message = (value, sender = popup) => new Promise(resolve => callbacks.message(value, sender, resolve));
  return {session, local, requests, jobs, message, restore};
}

test('tone snapshot belongs to the explicit generation and survives settings changes, polls and worker restore', async t => {
  const h = await harness(t);
  await h.message({type: 'savePopupPreferences', tonePreset: 'professional'});
  const initialized = await h.message({type: 'inlineInit', context}, content);
  const started = await h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  assert.equal(started.job.tonePreset, 'professional');
  assert.equal(started.job.hasCustomTone, true);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].preferences.style, 'all');
  assert.equal(h.requests[0].preferences.tonePreset, 'professional');
  assert.match(h.requests[0].preferences.tone, /观点清楚，理由具体/);
  assert.match(h.requests[0].preferences.tone, /^本次选择语气（优先）：/);
  assert.match(h.requests[0].preferences.tone, /补充偏好（不冲突时参考）：私人口吻/);
  const original = structuredClone(h.session.replySessionState.inlineSessions[initialized.sessionId].job);
  await h.message({type: 'savePopupPreferences', tonePreset: 'sharp'});
  assert.deepEqual(h.session.replySessionState.inlineSessions[initialized.sessionId].job, original);
  assert.equal(h.requests.length, 1);
  Object.assign(h.jobs.get(started.job.id), {status: 'completed', candidates, contextStatus: 'sufficient', missingContext: '', tonePreset: 'chat'});
  const completed = await h.message({type: 'inlinePoll', sessionId: initialized.sessionId, id: started.job.id}, content);
  assert.equal(completed.job.tonePreset, 'professional', 'upstream metadata cannot relabel the local snapshot');
  assert.equal(completed.job.hasCustomTone, true);
  assert.equal(completed.job.candidates.length, 4);
  assert.ok(completed.job.candidates.every(item => item.replyStyle === 'professional' && item.label === '理性专业'));
  assert.equal(Object.hasOwn(completed.job, 'preferences'), false);
  assert.equal(JSON.stringify(completed).includes('私密'), false); assert.equal(JSON.stringify(completed).includes('私人口吻'), false);
  await h.restore();
  const restored = await h.message({type: 'inlinePoll', sessionId: initialized.sessionId, id: started.job.id}, content);
  assert.equal(restored.job.tonePreset, 'professional');
  assert.equal(restored.job.hasCustomTone, true);
  assert.deepEqual(restored.job.candidates, completed.job.candidates);
  const next = await h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  assert.equal(next.job.tonePreset, 'sharp'); assert.equal(h.requests.length, 2);
});

test('changing tone while a job POST is pending keeps payload and batch label aligned', async t => {
  let releasePost, announcePost;
  const pendingPost = new Promise(resolve => {releasePost = resolve;});
  const posted = new Promise(resolve => {announcePost = resolve;});
  const h = await harness(t, {beforeJobResponse: async () => {announcePost(); await pendingPost;}});
  await h.message({type: 'savePopupPreferences', tonePreset: 'professional'});
  const initialized = await h.message({type: 'inlineInit', context}, content);
  const generating = h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  await posted;
  let changeApplied = false;
  const changing = h.message({type: 'savePopupPreferences', tonePreset: 'sharp'}).then(result => {changeApplied = true; return result;});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(changeApplied, false, 'popup changes serialize behind the in-flight job creation');
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].preferences.tone, /^本次选择语气（优先）：观点清楚/);
  releasePost();
  const [started, changed] = await Promise.all([generating, changing]);
  assert.equal(started.job.tonePreset, 'professional');
  assert.equal(changed.tonePreset, 'sharp');
  assert.equal(h.requests.length, 1, 'changing tone cannot start an extra generation');
  Object.assign(h.jobs.get(started.job.id), {status: 'completed', candidates, contextStatus: 'sufficient', missingContext: ''});
  const next = await h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  assert.equal(next.job.tonePreset, 'sharp');
  assert.match(h.requests[1].preferences.tone, /^本次选择语气（优先）：点出关键矛盾/);
});

test('restored old or corrupt job snapshots remain unknown rather than using current popup tone', async t => {
  const h = await harness(t);
  const initialized = await h.message({type: 'inlineInit', context}, content);
  const started = await h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  Object.assign(h.jobs.get(started.job.id), {status: 'completed', candidates, contextStatus: 'sufficient', missingContext: ''});
  await h.message({type: 'inlinePoll', sessionId: initialized.sessionId, id: started.job.id}, content);
  const saved = h.session.replySessionState.inlineSessions[initialized.sessionId].job;
  delete saved.tonePreset;
  await h.message({type: 'savePopupPreferences', tonePreset: 'sharp'});
  await h.restore();
  const legacy = await h.message({type: 'inlinePoll', sessionId: initialized.sessionId, id: started.job.id}, content);
  assert.equal(Object.hasOwn(legacy.job, 'tonePreset'), false);
  h.session.replySessionState.inlineSessions[initialized.sessionId].job.tonePreset = 'private-invalid-tone';
  await h.restore();
  const invalid = await h.message({type: 'inlinePoll', sessionId: initialized.sessionId, id: started.job.id}, content);
  assert.equal(Object.hasOwn(invalid.job, 'tonePreset'), false);
});


test('automatic requests preserve each actual unified style through a later manual selection and worker restore', async t => {
  const h = await harness(t);
  const initialized = await h.message({type: 'inlineInit', context}, content);
  const started = await h.message({type: 'inlineGenerate', sessionId: initialized.sessionId}, content);
  assert.equal(h.requests[0].preferences.tonePreset, 'auto');
  const replyStyles = ['chat', 'agree', 'practical', 'empathetic'];
  const batch = candidates.map((candidate, i) => ({...candidate, replyStyle: replyStyles[i]}));
  Object.assign(h.jobs.get(started.job.id), {status: 'completed', candidates: batch, contextStatus: 'sufficient', missingContext: '', tonePreset: 'sharp'});
  await h.message({type: 'savePopupPreferences', tonePreset: 'sharp'});
  const completed = await h.message({type: 'inlinePoll', sessionId: initialized.sessionId, id: started.job.id}, content);
  assert.equal(completed.job.tonePreset, 'auto');
  assert.deepEqual(completed.job.candidates.map(candidate => candidate.replyStyle), replyStyles);
  assert.deepEqual(completed.job.candidates.map(candidate => candidate.label), ['日常聊天', '认可共鸣', '实用建议', '温和共情']);
  await h.restore();
  const restored = await h.message({type: 'inlinePoll', sessionId: initialized.sessionId, id: started.job.id}, content);
  assert.equal(restored.job.tonePreset, 'auto');
  assert.deepEqual(restored.job.candidates, completed.job.candidates);
  assert.equal(h.requests.length, 1, 'a popup change and worker restore cannot trigger another generation');
});
