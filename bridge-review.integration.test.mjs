import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBridge, PORT, REPLY_PROTOCOL} from './bridge.mjs';

const BRIDGE_TOKEN = 'fixture-job-credential-0123456789';
const REVIEW_TOKEN = 'fixture-review-credential-9876543210';
const LOCAL_ORIGIN = `http://127.0.0.1:${PORT}`;
const EXTENSION = `chrome-extension://${'a'.repeat(32)}`;
const understanding = {meaning: '作者是在自嘲加班，不是真的觉得开心。', signals: ['反讽', '吐槽'], evidence: ['开心用语与凌晨加班形成反差。'], contextStatus: 'sufficient', missingContext: '', replyAction: '接住加班的疲惫，不祝贺。'};
const candidates = [{style: 'witty', label: '接一句', text: '太好了，明天的困意提前到账。'}, {style: 'humor', label: '另一句', text: '又是公司省电、你费电的一晚。'}];
const SOURCE = {id: '1234567890123456789', url: 'https://x.com/example/status/1234567890123456789', text: '太好了，又加班到凌晨两点。', authorName: '测试作者'};
const INPUT = {context: SOURCE, preferences: {style: 'mix', tone: '', personalExperience: ''}};
const REVIEW_ITEMS = [{id: 'sample-one', source: {type: 'historical-screenshot', url: SOURCE.url, author: '@example', text: SOURCE.text, capturedAt: '2026-10-12T01:00:00.000Z'}, generation: {status: 'succeeded', summary: understanding.meaning, tags: understanding.signals, gaps: [], candidates: candidates.map(({text}) => ({text})), durationMs: 1234}},
  {id: 'sample-missing', source: {type: 'historical-screenshot', url: '', author: '@video', text: '这个声音绝了。', capturedAt: '2026-10-12T01:00:00.000Z'}, generation: {status: 'succeeded', summary: '缺少视频声音，暂时无法理解夸赞还是反讽。', tags: [], gaps: ['缺少视频对白和语气。'], candidates: []}}];

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jieyiju-review-http-'));
  const dataPath = join(directory, 'review-data.json'), feedbackPath = join(directory, 'review-feedback.json');
  await writeFile(dataPath, JSON.stringify({version: 1, items: REVIEW_ITEMS}));
  const calls = [];
  const runner = {health: {authenticated: true, authentication: 'ChatGPT', service: 'fixture'}, run(context, preferences, signal) { return new Promise((resolve, reject) => calls.push({context, preferences, signal, resolve, reject})); }};
  const bridge = createBridge({runner, token: BRIDGE_TOKEN, reviewToken: REVIEW_TOKEN, reviewDataPath: dataPath, reviewFeedbackPath: feedbackPath});
  t.after(async () => { for (const call of calls) call.resolve({understanding, candidates}); await bridge.stop(); await rm(directory, {recursive: true, force: true}); });
  function request({method = 'GET', path = '/review-data', body, headers = {}} = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method; req.url = path;
    req.headers = {host: `127.0.0.1:${PORT}`, ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers};
    return new Promise((resolve, reject) => {
      const responseHeaders = new Map(); let status;
      const res = {
        get headersSent() { return status !== undefined; },
        setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); },
        writeHead(code, extra = {}) { if (status !== undefined) throw new Error('duplicate response headers'); status = code; for (const [name, value] of Object.entries(extra)) responseHeaders.set(name.toLowerCase(), value); },
        end(value = '') { const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value); let data; try { data = JSON.parse(text); } catch { data = text; } resolve({status, data, text, headers: responseHeaders}); },
        destroy(error) { reject(error ?? new Error('response was destroyed')); }
      };
      bridge.server.emit('request', req, res);
    });
  }
  const reviewHeaders = {'x-review-token': REVIEW_TOKEN, 'sec-fetch-site': 'same-origin'};
  return {...bridge, request, reviewHeaders, calls, dataPath, feedbackPath};
}

test('foreign sites may navigate only to the credential-free review shell, never data, scripts or job endpoints', async t => {
  const h = await harness(t);
  const navigation = {'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'};
  const shell = await h.request({path: '/review', headers: navigation});
  assert.equal(shell.status, 200); assert.match(shell.headers.get('content-type'), /text\/html/);
  for (const value of [BRIDGE_TOKEN, REVIEW_TOKEN, SOURCE.text, 'sample-one']) assert.equal(shell.text.includes(value), false);
  assert.match(shell.text, /review-session\.js/);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/review-data', '/review-feedback', '/review-session.js', '/review.js', '/review.css', '/health', '/jobs']) {
    const denied = await h.request({path, headers: {...navigation, 'x-review-token': REVIEW_TOKEN, 'x-reply-bridge-token': BRIDGE_TOKEN}});
    assert.equal(denied.status, 403); assert.equal(denied.data.code, 'BAD_ORIGIN');
    assert.equal(denied.text.includes(BRIDGE_TOKEN), false); assert.equal(denied.text.includes(REVIEW_TOKEN), false);
  }
  for (const changed of [{'sec-fetch-dest': 'iframe'}, {'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty'}]) assert.equal((await h.request({path: '/review', headers: {...navigation, ...changed}})).status, 403);
  assert.equal((await h.request({method: 'POST', path: '/review', headers: navigation})).status, 403);
  assert.equal(h.calls.length, 0);
});

test('review static resources require same-origin script/style fetches and never reveal the job credential', async t => {
  const h = await harness(t);
  for (const path of ['/review-session.js', '/review.js', '/review.css']) {
    const destination = path.endsWith('.css') ? 'style' : 'script';
    for (const headers of [{}, {'sec-fetch-site': 'same-site', 'sec-fetch-dest': destination}, {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document'}, {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': destination, origin: EXTENSION}, {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': destination, origin: 'https://attacker.test'}]) {
      const denied = await h.request({path, headers}); assert.equal(denied.status, 403); assert.equal(denied.text.includes(BRIDGE_TOKEN), false); assert.equal(denied.text.includes(REVIEW_TOKEN), false);
    }
    const allowed = await h.request({path, headers: {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': destination}});
    assert.equal(allowed.status, 200); assert.equal(allowed.text.includes(BRIDGE_TOKEN), false);
    assert.equal(allowed.text.includes(REVIEW_TOKEN), path === '/review-session.js');
    assert.match(allowed.headers.get('content-type'), destination === 'style' ? /text\/css/ : /text\/javascript/);
    assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('review APIs require their independent token and same-origin metadata; that token cannot create/read/cancel jobs', async t => {
  const h = await harness(t);
  for (const headers of [{}, {'x-review-token': REVIEW_TOKEN}, {'x-review-token': BRIDGE_TOKEN, 'sec-fetch-site': 'same-origin'}, {'x-reply-bridge-token': BRIDGE_TOKEN, 'sec-fetch-site': 'same-origin'}, {...h.reviewHeaders, 'sec-fetch-site': 'same-site'}, {...h.reviewHeaders, origin: EXTENSION}, {...h.reviewHeaders, origin: 'https://attacker.test'}]) {
    const denied = await h.request({headers}); assert.equal(denied.status, 403); assert.equal(denied.text.includes(SOURCE.text), false);
  }
  const data = await h.request({headers: {...h.reviewHeaders, origin: LOCAL_ORIGIN}});
  assert.equal(data.status, 200); assert.equal(data.data.items.length, 2);
  assert.equal(data.text.includes(BRIDGE_TOKEN), false); assert.equal(data.text.includes(REVIEW_TOKEN), false);
  assert.deepEqual(data.data.items[1].generation.candidates, []); assert.match(data.data.items[1].generation.gaps[0], /视频对白/);
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  for (const config of [{method: 'POST', path: '/jobs', body: INPUT}, {path: `/jobs/${id}`}, {method: 'DELETE', path: `/jobs/${id}`}, {method: 'POST', path: '/pair'}]) {
    for (const headers of [h.reviewHeaders, {...h.reviewHeaders, 'x-reply-bridge-token': REVIEW_TOKEN}]) {
      const denied = await h.request({...config, headers}); assert.equal(denied.status, 401); assert.equal(denied.data.code, 'UNPAIRED');
    }
  }
  assert.equal(h.calls.length, 0);
});

test('review feedback accepts only known items and candidate indices and remains readable after bridge restart', async t => {
  const h = await harness(t);
  const note = {itemId: 'sample-one', rating: 'unlike-me', opinion: '我不这样说，这句话像在卖文案。', ownReply: '又得拿明天的觉来还了。', selectedCandidate: 0};
  const rejected = await h.request({method: 'POST', path: '/review-feedback', body: {...note, itemId: 'unknown-item'}, headers: h.reviewHeaders});
  assert.equal(rejected.status, 404); assert.equal(rejected.data.code, 'REVIEW_ITEM');
  for (const body of [{...note, selectedCandidate: 2}, {...note, source: SOURCE}, {...note, rating: 'auto-approved'}, {...note, itemId: 'sample-missing', selectedCandidate: 0}]) assert.equal((await h.request({method: 'POST', path: '/review-feedback', body, headers: h.reviewHeaders})).status, 400);
  assert.equal((await h.request({method: 'POST', path: '/review-feedback', body: note, headers: {'sec-fetch-site': 'same-origin', 'x-review-token': BRIDGE_TOKEN}})).status, 403);
  const saved = await h.request({method: 'POST', path: '/review-feedback', body: note, headers: h.reviewHeaders});
  assert.equal(saved.status, 200); assert.deepEqual({...saved.data.feedback, updatedAt: undefined}, {...note, updatedAt: undefined});
  assert.ok(Number.isFinite(Date.parse(saved.data.feedback.updatedAt)));
  const disk = JSON.parse(await readFile(h.feedbackPath, 'utf8'));
  assert.deepEqual(disk.feedback['sample-one'], saved.data.feedback);
  assert.equal((await stat(h.feedbackPath)).mode & 0o777, 0o600);
  const loaded = await h.request({headers: h.reviewHeaders}); assert.deepEqual(loaded.data.feedback['sample-one'], saved.data.feedback);
  const restarted = createBridge({runner: {health: {authenticated: true}, run() { throw new Error('No model should run'); }}, token: 'new-job-token', reviewToken: 'new-review-token', reviewDataPath: h.dataPath, reviewFeedbackPath: h.feedbackPath});
  t.after(() => restarted.stop());
  // Drive a fresh handler using the same persisted files without a TCP listener.
  const req = Readable.from([]); req.method = 'GET'; req.url = '/review-data'; req.headers = {host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'x-review-token': 'new-review-token'};
  const result = await new Promise(resolve => restarted.server.emit('request', req, {setHeader() {}, writeHead(code) { assert.equal(code, 200); }, end(text) { resolve(JSON.parse(text)); }}));
  assert.deepEqual(result.feedback['sample-one'], saved.data.feedback); assert.equal(h.calls.length, 0);
});

test('the HTTP feedback limit accepts maximum valid Chinese fields and preserves clear size/content-type errors', async t => {
  const h = await harness(t);
  const valid = {itemId: 'sample-one', rating: 'okay', opinion: '中'.repeat(4000), ownReply: '文'.repeat(2000), selectedCandidate: null};
  assert.ok(Buffer.byteLength(JSON.stringify(valid)) > 16 * 1024);
  const saved = await h.request({method: 'POST', path: '/review-feedback', body: valid, headers: h.reviewHeaders});
  assert.equal(saved.status, 200); assert.equal(saved.data.feedback.opinion.length, 4000); assert.equal(saved.data.feedback.ownReply.length, 2000);
  const huge = await h.request({method: 'POST', path: '/review-feedback', body: {...valid, opinion: '中'.repeat(12000)}, headers: h.reviewHeaders});
  assert.equal(huge.status, 413); assert.equal(huge.data.code, 'BODY_LIMIT');
  const wrongType = await h.request({method: 'POST', path: '/review-feedback', body: valid, headers: {...h.reviewHeaders, 'content-type': 'text/plain'}});
  assert.equal(wrongType.status, 415); assert.equal(wrongType.data.code, 'CONTENT_TYPE');
  assert.equal((await h.request({method: 'DELETE', path: '/review-feedback', headers: h.reviewHeaders})).status, 405);
  assert.equal(h.calls.length, 0);
});

test('structured runner understanding passes through completed jobs including a real zero-candidate result', async t => {
  const h = await harness(t), headers = {'x-reply-bridge-token': BRIDGE_TOKEN, 'x-reply-protocol': REPLY_PROTOCOL};
  for (const result of [{understanding, candidates}, {understanding: {...understanding, contextStatus: 'missing', missingContext: '缺少视频对白和语气。', replyAction: '先补视频内容，暂不生成。'}, candidates: []}]) {
    const created = await h.request({method: 'POST', path: '/jobs', body: INPUT, headers});
    assert.equal(created.status, 202); h.calls.at(-1).resolve(result); await h.jobs.get(created.data.job.id).settlement;
    const completed = await h.request({path: `/jobs/${created.data.job.id}`, headers});
    assert.equal(completed.status, 200); assert.equal(completed.data.job.status, 'completed');
    assert.deepEqual(completed.data.job.understanding, result.understanding); assert.deepEqual(completed.data.job.candidates, result.candidates);
    assert.equal(completed.text.includes(BRIDGE_TOKEN), false); assert.equal(completed.text.includes(REVIEW_TOKEN), false);
  }
  assert.equal(h.calls.length, 2);
});
