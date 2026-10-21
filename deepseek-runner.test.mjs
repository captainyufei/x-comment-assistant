import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekRunner} from './deepseek-runner.mjs';
import {readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const KEY = 'TEST_ONLY_DEEPSEEK_KEY_NOT_REAL';
class TestBridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const UNDERSTANDING = {meaning: '讨论节约时间之后如何安排工作。', signals: ['讨论'], evidence: ['省下来的时间'],
  contextStatus: 'sufficient', missingContext: '', replyAction: '回应具体用途并补一个原因。'};
const CANDIDATES = [{style: 'insight', label: '时间去向', text: '可以先把最费时间的重复工作缩短一点。省出来的时间能不能用好，还得看原本最想完成哪件事。'}];
const CONTEXT = {text: 'AI 省下来的时间会用在哪里？', author: '@fixture', url: 'https://x.com/fixture/status/123456789', quote: '', hasMedia: false};
const POSTER = {kind: 'video-poster', url: 'https://pbs.twimg.com/ext_tw_video_thumb/abc/pu/img/xyz.jpg', alt: '平台提供的视频说明'};
const IMAGE = {kind: 'image', url: 'https://pbs.twimg.com/media/abc.jpg', alt: '作者提供的图片说明'};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=', 'base64');
const mediaDirectories = async () => new Set((await readdir(tmpdir())).filter(name => name.startsWith('x-reply-deepseek-')));

function reply(overrides = {}) { return {understanding: structuredClone(UNDERSTANDING), candidates: structuredClone(CANDIDATES), ...overrides}; }
function envelope(data = reply(), overrides = {}) {
  return {choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: JSON.stringify(data)}}], ...overrides};
}
function response(data = envelope(), options = {}) {
  return new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}, ...options});
}
function setup({fetchImpl, ...options} = {}) {
  const calls = [], diagnostics = [];
  const runner = new DeepSeekRunner({apiKey: KEY, model: 'deepseek-flash', version: 'fixture', BridgeError: TestBridgeError,
    onDiagnostic: entry => diagnostics.push(entry), fetchImpl: fetchImpl ?? (async (...args) => { calls.push(args); return response(); }), ...options});
  return {runner, calls, diagnostics};
}
async function run(runner, context = structuredClone(CONTEXT), preferences = {style: 'mix'}, signal = new AbortController().signal) {
  return runner.run(context, preferences, signal);
}
function errorCode(code) { return error => error instanceof TestBridgeError && error.code === code; }

test('initialization validates local configuration and exposes the selected provider without an API request or key', async () => {
  const {runner, calls} = setup();
  assert.equal(runner.health.authenticated, false);
  assert.deepEqual(await runner.initialize(), {service: 'yufei-x-reply-codex', version: 'fixture', codexVersion: '', authenticated: true,
    authentication: 'DeepSeek API', writerProvider: 'deepseek', writerModel: 'deepseek-flash', writerReasoningEffort: 'disabled'});
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(runner).includes(KEY), false);
  assert.equal(Object.keys(runner).includes('apiKey'), false);
});

test('invalid or header-injecting credentials and invalid model/settings fail locally', async () => {
  for (const options of [{apiKey: ''}, {apiKey: 'sk-fixture\r\nX-Leak: secret'}, {apiKey: 'has whitespace in api key'}]) {
    const {runner, calls} = setup(options);
    await assert.rejects(runner.initialize(), errorCode('DEEPSEEK_AUTH_REQUIRED'));
    assert.equal(runner.health.authenticated, false);
    assert.equal(calls.length, 0);
  }
  for (const options of [{model: 'https://attacker.example'}, {timeoutMs: 0}]) {
    await assert.rejects(setup(options).runner.initialize(), errorCode('DEEPSEEK_CONFIG'));
  }
  await assert.rejects(new DeepSeekRunner({apiKey: KEY, fetchImpl: null, BridgeError: TestBridgeError}).initialize(), errorCode('DEEPSEEK_CONFIG'));
});

test('one fixed official API request disables thinking, requires JSON, omits tools and carries the existing quality prompt', async () => {
  const {runner, calls} = setup();
  const result = await run(runner);
  assert.deepEqual(result.candidates, CANDIDATES);
  const [url, request] = calls[0];
  assert.equal(calls.length, 1);
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  const data = JSON.parse(request.body);
  assert.equal(data.model, 'deepseek-flash');
  assert.deepEqual(data.thinking, {type: 'disabled'});
  assert.deepEqual(data.response_format, {type: 'json_object'});
  assert.equal(data.stream, false);
  assert.equal(data.max_tokens, 1536);
  assert.equal(Object.hasOwn(data, 'tools'), false);
  assert.equal(Object.hasOwn(data, 'reasoning_effort'), false);
  assert.match(data.messages[0].content, /事实准确优先/u);
  assert.match(data.messages[0].content, /不得添加材料未给出的量化效果/u);
  assert.match(data.messages[0].content, /不能擅自补成投资/u);
  assert.match(data.messages[0].content, /不得给出买卖时机/u);
  assert.match(data.messages[0].content, /顶层恰好 understanding 和 candidates/u);
  assert.match(data.messages[0].content, /只有 missing 才允许 candidates 为 \[\]/u);
  assert.match(data.messages[0].content, /默认每条最多 140/u);
  assert.match(data.messages[1].content, /原帖|原推文/u);
  assert.match(data.messages[1].content, /AI 省下来的时间会用在哪里/u);
  assert.match(data.messages[1].content, /不(?:能|得).*编|虚构/u);
  assert.equal(JSON.stringify(data).includes(KEY), false);
  for (const name of ['mediaPreparationMs', 'responseHeadersMs', 'responseBodyMs', 'responseParseMs', 'processAndModelMs', 'totalMs']) {
    assert.ok(Number.isInteger(result.timings[name]) && result.timings[name] >= 0, name);
  }
  assert.equal(result.timings.cliReconnects, 0);
});

test('explicit selected style receives a sufficient token budget and still enforces requested style', async () => {
  const {runner, calls} = setup({fetchImpl: undefined});
  await run(runner, structuredClone(CONTEXT), {style: 'insight'});
  assert.equal(JSON.parse(calls[0][1].body).max_tokens, 2048);
  await assert.rejects(run(runner, structuredClone(CONTEXT), {style: 'humor'}), errorCode('INVALID_CANDIDATES'));
});

const FOUR_REPLIES = [
  {style: 'witty', text: '先问这个很有必要。省下时间以后还要知道想做什么，否则很容易又被别的琐事填满，忙了一天却没完成最想做的事。'},
  {style: 'humor', text: '工具说替人省时间，手机说正好再刷一会儿。要是没先安排好，省下来的半小时可能又在下一条视频里花回去了。'},
  {style: 'insight', text: '可以先留给一直被推后的事情，比如检查关键数据、和使用者聊聊。比起把任务越排越满，给这些事留位置可能更有用。'},
  {style: 'story', text: '比如一个人提前写完了方案，终于能请同事试着用一下。省下来的时间没换成更多页文档，却可能让一个没想到的问题早点出现。'},
];
const compact = (overrides = {}) => ({contextStatus: 'sufficient', missingContext: '', candidates: structuredClone(FOUR_REPLIES), ...overrides});

test('all uses one compact request and returns four fixed types without interpretation, context input or model labels', async () => {
  const calls = [];
  const {runner} = setup({fetchImpl: async (...args) => { calls.push(args); return response(envelope(compact())); }});
  const result = await run(runner, structuredClone(CONTEXT), {style: 'all', contextNote: 'retired-context-do-not-send'});
  assert.equal(calls.length, 1);
  assert.equal(result.contextStatus, 'sufficient');
  assert.equal(Object.hasOwn(result, 'understanding'), false);
  assert.deepEqual(result.candidates.map(item => item.label), ['认可并展开', '幽默接梗', '补充观点', '换个角度']);
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.thinking.type, 'disabled');
  assert.equal(request.temperature, 0.6, 'focused writing remains in the same non-thinking request');
  assert.match(request.messages[0].content, /每项候选仅 style、text/u);
  assert.equal(JSON.stringify(request).includes('retired-context-do-not-send'), false);
  assert.equal(JSON.stringify(request).includes('understanding'), false);
  assert.ok(request.messages[1].content.length < 1500);
});

test('all accepts an explicit missing-media result and rejects incomplete or duplicate types without another model call', async () => {
  for (const data of [compact({candidates: FOUR_REPLIES.slice(0, 3)}), compact({candidates: [...FOUR_REPLIES.slice(0, 3), FOUR_REPLIES[0]]})]) {
    let calls = 0;
    const {runner} = setup({fetchImpl: async () => { calls++; return response(envelope(data)); }});
    await assert.rejects(run(runner, structuredClone(CONTEXT), {style: 'all'}), errorCode('INVALID_CANDIDATES'));
    assert.equal(calls, 1);
  }
  const missing = compact({contextStatus: 'missing', missingContext: '没有读取到视频对白，无法判断作者是在夸奖还是反讽。', candidates: []});
  const {runner} = setup({fetchImpl: async () => response(envelope(missing))});
  assert.deepEqual((await run(runner, structuredClone(CONTEXT), {style: 'all'})).candidates, []);
});

test('response reader joins split UTF-8 Chinese bytes exactly and diagnoses malformed envelopes without body disclosure', async () => {
  const bytes = Buffer.from(JSON.stringify(envelope(compact())));
  const body = new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
    controller.close();
  }});
  const {runner} = setup({fetchImpl: async () => new Response(body, {headers: {'content-type': 'application/json'}})});
  assert.equal((await run(runner, structuredClone(CONTEXT), {style: 'all'})).candidates[0].text, FOUR_REPLIES[0].text);
  const bad = setup({fetchImpl: async () => new Response(`not-json-${KEY}`, {headers: {'content-type': 'application/json'}})});
  await assert.rejects(run(bad.runner, structuredClone(CONTEXT), {style: 'all'}), errorCode('INVALID_CANDIDATES'));
  const diagnostic = bad.diagnostics.find(item => item.event === 'reply_validation_failed');
  assert.equal(diagnostic.subtype, 'RESPONSE_JSON');
  assert.equal(diagnostic.errorKind, 'SyntaxError');
  assert.equal(diagnostic.responseBytes, Buffer.byteLength(`not-json-${KEY}`));
  assert.equal(JSON.stringify(bad.diagnostics).includes(KEY), false);
});

test('pro remains text-only and cannot reuse a prior visual-evidence claim', async () => {
  const {runner, calls} = setup({model: 'deepseek-v4-pro'});
  const context = {...structuredClone(CONTEXT), hasMedia: true, media: [IMAGE, POSTER],
    mediaEvidence: {images: 1, videoPosters: 1, videoFrames: 0, attachments: [{index: 1, kind: 'image'}, {index: 2, kind: 'video-poster'}]}};
  await run(runner, context, {style: 'mix', contextNote: '我补充：图中只是产品清单，不代表视频剧情。'});
  assert.deepEqual(context.mediaEvidence.attachments, []);
  assert.equal(context.mediaEvidence.images + context.mediaEvidence.videoFrames + context.mediaEvidence.videoPosters, 0);
  assert.deepEqual(context.mediaEvidence.altTexts, [IMAGE.alt, POSTER.alt]);
  assert.match(context.mediaEvidence.limitations.join(''), /未读取.*图片.*视频/u);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0][1].body);
  assert.equal(typeof body.messages[1].content, 'string');
  assert.match(body.messages[1].content, /我补充：图中只是产品清单/u);
  assert.equal(calls.some(call => call[0].includes('pbs.twimg.com')), false);
  assert.equal(body.messages.some(message => Array.isArray(message.content)), false);
});

test('media-only without text or user context defers before making a request', async () => {
  const {runner, calls} = setup({model: 'deepseek-v4-pro'});
  await assert.rejects(run(runner, {...CONTEXT, text: '', hasMedia: true, media: [IMAGE]}), errorCode('MEDIA_UNAVAILABLE'));
  assert.equal(calls.length, 0);
});

test('a user-supplied media description is preserved and a specific missing-media decision with zero replies is accepted', async () => {
  const missing = reply({understanding: {...UNDERSTANDING, contextStatus: 'missing', missingContext: '没有读取视频，无法判断这句话是在反讽哪段画面。'}, candidates: []});
  const {runner, calls} = setup({model: 'deepseek-v4-pro', fetchImpl: async (...args) => { calls.push(args); return response(envelope(missing)); }});
  const result = await run(runner, {...CONTEXT, text: '', hasMedia: true, media: [POSTER]}, {style: 'mix', contextNote: '视频里有人说反话，具体对白还未补充。'});
  assert.equal(result.understanding.contextStatus, 'missing');
  assert.deepEqual(result.candidates, []);
  assert.match(JSON.parse(calls[0][1].body).messages[1].content, /具体对白还未补充/u);
});

test('flash sends original image bytes as bounded data URLs with truthful image/poster order and cleans temporary files', async () => {
  const before = await mediaDirectories();
  const calls = [];
  const {runner} = setup({fetchImpl: async (url, request) => {
    calls.push([url, request]);
    if (url.startsWith('https://pbs.twimg.com/')) return new Response(PNG, {headers: {'content-type': 'image/png'}});
    return response();
  }});
  const context = {...structuredClone(CONTEXT), hasMedia: true, media: [IMAGE, POSTER]};
  await run(runner, context);
  const api = calls.filter(call => call[0] === 'https://api.deepseek.com/chat/completions');
  assert.equal(api.length, 1);
  assert.equal(calls.length, 3);
  const content = JSON.parse(api[0][1].body).messages[1].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content.length, 3);
  for (const item of content.slice(1)) {
    assert.equal(item.type, 'image_url');
    assert.equal(item.image_url.detail, undefined);
    assert.equal(item.image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
  }
  assert.equal(context.mediaEvidence.images, 1);
  assert.equal(context.mediaEvidence.videoPosters, 1);
  assert.equal(context.mediaEvidence.videoFrames, 0);
  assert.deepEqual(context.mediaEvidence.attachments, [{index: 1, kind: 'image'}, {index: 2, kind: 'video-poster'}]);
  assert.match(context.mediaEvidence.limitations.join(''), /视频仅读取封面/u);
  assert.deepEqual(await mediaDirectories(), before);
});

test('flash can reply to an image-only post after actually preparing the image pixels', async () => {
  const {runner} = setup({fetchImpl: async url => url.startsWith('https://pbs.twimg.com/')
    ? new Response(PNG, {headers: {'content-type': 'image/png'}}) : response()});
  const context = {...CONTEXT, text: '', hasMedia: true, media: [IMAGE]};
  assert.equal((await run(runner, context)).candidates.length, 1);
  assert.equal(context.mediaEvidence.images, 1);
});

test('failed flash media downloads keep zero attachments and never claim an unread image', async () => {
  let apiRequests = 0;
  const {runner} = setup({fetchImpl: async url => {
    if (url.startsWith('https://pbs.twimg.com/')) return new Response('bad bytes', {headers: {'content-type': 'image/png'}});
    apiRequests++; return response();
  }});
  const context = {...structuredClone(CONTEXT), hasMedia: true, media: [IMAGE]};
  await run(runner, context);
  assert.equal(apiRequests, 1);
  assert.equal(context.mediaEvidence.images, 0);
  assert.deepEqual(context.mediaEvidence.attachments, []);
  assert.match(context.mediaEvidence.limitations.join(''), /未能读取/u);
  await assert.rejects(run(runner, {...context, text: ''}), errorCode('MEDIA_UNAVAILABLE'));
  assert.equal(apiRequests, 1);
});

test('flash media cancellation and deadline stop before any API call and clean the temporary directory', async () => {
  const before = await mediaDirectories();
  for (const userCancel of [true, false]) {
    let mediaRequested;
    const started = new Promise(resolve => { mediaRequested = resolve; });
    let apiRequests = 0;
    const {runner} = setup({timeoutMs: 30, fetchImpl: async url => {
      if (url.startsWith('https://pbs.twimg.com/')) { mediaRequested(); return new Promise(() => {}); }
      apiRequests++; return response();
    }});
    const abort = new AbortController();
    const task = run(runner, {...CONTEXT, media: [IMAGE]}, {style: 'mix'}, abort.signal);
    await started;
    if (userCancel) abort.abort();
    await assert.rejects(task, errorCode(userCancel ? 'CANCELLED' : 'TIMEOUT'));
    assert.equal(apiRequests, 0);
    assert.deepEqual(await mediaDirectories(), before);
  }
});

test('flash removes its image files even when the API later returns invalid candidates', async () => {
  const before = await mediaDirectories();
  const {runner} = setup({fetchImpl: async url => url.startsWith('https://pbs.twimg.com/')
    ? new Response(PNG, {headers: {'content-type': 'image/png'}}) : response({error: 'invalid-output'})});
  await assert.rejects(run(runner, {...CONTEXT, media: [IMAGE]}), errorCode('INVALID_CANDIDATES'));
  assert.deepEqual(await mediaDirectories(), before);
});

test('invalid media cannot cause a request to arbitrary origins', async () => {
  const {runner, calls} = setup();
  await assert.rejects(run(runner, {...CONTEXT, media: [{...IMAGE, url: 'http://127.0.0.1:9999/secret'}]}), errorCode('INVALID_INPUT'));
  assert.equal(calls.length, 0);
});

test('provider HTTP failures map to fixed Chinese messages with no raw body, secret or automatic retry', async () => {
  const statuses = [[401, 'DEEPSEEK_AUTH_REQUIRED'], [403, 'DEEPSEEK_AUTH_REQUIRED'], [402, 'DEEPSEEK_QUOTA'],
    [429, 'DEEPSEEK_RATE_LIMIT'], [400, 'DEEPSEEK_CONFIG'], [404, 'DEEPSEEK_CONFIG'], [422, 'DEEPSEEK_CONFIG'],
    [500, 'DEEPSEEK_NETWORK'], [503, 'DEEPSEEK_NETWORK'], [302, 'DEEPSEEK_NETWORK']];
  for (const [status, code] of statuses) {
    let requests = 0;
    const {runner, diagnostics} = setup({fetchImpl: async () => { requests++; return response({error: {message: `${KEY} upstream-secret-detail`}}, {status}); }});
    await assert.rejects(run(runner), error => {
      assert.equal(error.code, code);
      assert.match(error.message, /DeepSeek/u);
      assert.equal(error.message.includes(KEY), false);
      assert.equal(error.message.includes('upstream-secret-detail'), false);
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(JSON.stringify(diagnostics).includes(KEY), false);
  }
});

test('a thrown fetch error is sanitized and cannot leak the key through errors or diagnostics', async () => {
  const {runner, diagnostics} = setup({fetchImpl: async () => { throw new Error(`Authorization: Bearer ${KEY}`); }});
  await assert.rejects(run(runner), error => {
    assert.equal(error.code, 'DEEPSEEK_NETWORK');
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.equal(JSON.stringify(diagnostics).includes(KEY), false);
});

test('already-aborted jobs make no request', async () => {
  const {runner, calls} = setup();
  const abort = new AbortController(); abort.abort(new Error(KEY));
  await assert.rejects(run(runner, structuredClone(CONTEXT), {style: 'mix'}, abort.signal), errorCode('CANCELLED'));
  assert.equal(calls.length, 0);
});

test('user cancellation interrupts a fetch that ignores AbortSignal and cancels a late arriving body', async () => {
  let resolveFetch, canceled = false;
  const {runner} = setup({fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; })});
  const abort = new AbortController();
  const task = run(runner, structuredClone(CONTEXT), {style: 'mix'}, abort.signal);
  abort.abort(new Error(KEY));
  await assert.rejects(task, errorCode('CANCELLED'));
  resolveFetch({body: {cancel() { canceled = true; }}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canceled, true);
});

test('deadline interrupts a fetch that ignores AbortSignal and never retries', async () => {
  let requests = 0;
  const {runner} = setup({timeoutMs: 20, fetchImpl: () => { requests++; return new Promise(() => {}); }});
  await assert.rejects(run(runner), errorCode('TIMEOUT'));
  assert.equal(requests, 1);
});

test('user cancellation and deadline also cover a stalled response reader', async () => {
  for (const shouldCancel of [true, false]) {
    let canceled = false, released = false;
    const reader = {read: () => new Promise(() => {}), cancel() { canceled = true; }, releaseLock() { released = true; }};
    const {runner} = setup({timeoutMs: 20, fetchImpl: async () => ({ok: true, headers: new Headers({'content-type': 'application/json'}), body: {getReader: () => reader}})});
    const abort = new AbortController();
    const task = run(runner, structuredClone(CONTEXT), {style: 'mix'}, abort.signal);
    if (shouldCancel) setTimeout(() => abort.abort(), 5);
    await assert.rejects(task, errorCode(shouldCancel ? 'CANCELLED' : 'TIMEOUT'));
    assert.equal(canceled, true);
    assert.equal(released, true);
  }
});

test('response bytes are bounded both by content length and actual streamed size', async () => {
  for (const declared of [true, false]) {
    const huge = 'x'.repeat(128 * 1024 + 1);
    const {runner} = setup({fetchImpl: async () => new Response(huge, {headers: {'content-type': 'application/json', ...(declared ? {'content-length': String(huge.length)} : {})}})});
    await assert.rejects(run(runner), errorCode('OUTPUT_LIMIT'));
  }
});

test('rejects non-JSON content type and missing response body', async () => {
  for (const res of [new Response('gateway-html'), {ok: true, headers: new Headers({'content-type': 'application/json'}), body: null}]) {
    const {runner} = setup({fetchImpl: async () => res});
    await assert.rejects(run(runner), errorCode('DEEPSEEK_FORMAT'));
  }
});

test('empty upstream body is a transport response failure, not invalid reply content, and never triggers a retry', async () => {
  let calls = 0;
  const {runner, diagnostics} = setup({fetchImpl: async () => { calls++; return new Response('', {headers: {'content-type': 'application/json'}}); }});
  await assert.rejects(run(runner, structuredClone(CONTEXT), {style: 'all'}), errorCode('DEEPSEEK_EMPTY'));
  assert.equal(calls, 1);
  assert.equal(diagnostics.some(item => item.event === 'reply_validation_failed'), false);
  assert.equal(diagnostics[0].stage, 'response');
});

test('rejects malformed JSON, truncation, refusal, tools and unexpected multi-choice output without exposing provider text', async () => {
  const cases = [
    {choices: []},
    {choices: [envelope().choices[0], envelope().choices[0]]},
    {choices: [{...envelope().choices[0], finish_reason: 'length'}]},
    {choices: [{...envelope().choices[0], finish_reason: 'tool_calls'}]},
    {choices: [{...envelope().choices[0], message: {...envelope().choices[0].message, tool_calls: [{type:'function',function:{name:'unexpected_tool'}}]}}]},
    {choices: [{...envelope().choices[0], message: {...envelope().choices[0].message, refusal: KEY}}]},
    {choices: [{...envelope().choices[0], message: {...envelope().choices[0].message, reasoning_content: KEY}}]},
    {choices: [{...envelope().choices[0], message: {...envelope().choices[0].message, role: 'tool'}}]},
    {choices: [{...envelope().choices[0], message: {role: 'assistant', content: KEY}}]},
  ];
  for (const data of cases) {
    const {runner} = setup({fetchImpl: async () => response(data)});
    await assert.rejects(run(runner), error => error.code === 'INVALID_CANDIDATES' && !error.message.includes(KEY));
  }
  const {runner} = setup({fetchImpl: async () => new Response(`not-json-${KEY}`, {headers: {'content-type': 'application/json'}})});
  await assert.rejects(run(runner), error => error.code === 'INVALID_CANDIDATES' && !error.message.includes(KEY));
});

test('existing Chinese, length, personal-history and duplicate checks still reject unacceptable candidates', async () => {
  for (const candidates of [
    [{...CANDIDATES[0], text: 'English only.'}],
    [{...CANDIDATES[0], text: '中'.repeat(141)}],
    [{...CANDIDATES[0], text: '我昨天买了一个新键盘，省下来的时间全用来折腾它了。'}],
    [...CANDIDATES, ...CANDIDATES],
    [{...CANDIDATES[0], style: 'story', text: '比如有人只会省时间，却没有打算。'}],
  ]) {
    const {runner} = setup({fetchImpl: async () => response(envelope(reply({candidates})))});
    await assert.rejects(run(runner), errorCode('INVALID_CANDIDATES'));
  }
});

test('validation diagnostics distinguish only allowlisted failure categories without including the rejected content', async () => {
  const cases = [
    [reply({candidates: [{...CANDIDATES[0], text: `English ${KEY}`}]}), 'LANGUAGE'],
    [reply({candidates: [{...CANDIDATES[0], text: '中'.repeat(141)}]}), 'TEXT_LENGTH'],
    [reply({candidates: [{...CANDIDATES[0], text: `我昨天买了一个键盘。${KEY}`}]}), 'INVENTED_PERSONAL_HISTORY'],
    [reply({candidates: [...CANDIDATES, ...CANDIDATES]}), 'DUPLICATE_CANDIDATE'],
    [reply({unexpected: KEY}), 'REPLY_FIELDS'],
  ];
  for (const [data, expected] of cases) {
    const {runner, diagnostics} = setup({fetchImpl: async () => response(envelope(data))});
    await assert.rejects(run(runner), errorCode('INVALID_CANDIDATES'));
    assert.equal(diagnostics.find(item => item.event === 'reply_validation_failed')?.subtype, expected);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes(KEY), false);
    assert.equal(serialized.includes(CANDIDATES[0].text), false);
  }
  const {runner, diagnostics} = setup({fetchImpl: async () => response({choices: [{...envelope().choices[0], finish_reason: 'length'}]})});
  await assert.rejects(run(runner), errorCode('INVALID_CANDIDATES'));
  assert.equal(diagnostics[0].subtype, 'OUTPUT_TRUNCATED');
});

test('diagnostic callbacks cannot turn a safe provider failure into a leaked exception', async () => {
  const {runner} = setup({fetchImpl: async () => response({}, {status: 429}), onDiagnostic: () => { throw new Error(KEY); }});
  await assert.rejects(run(runner), error => error.code === 'DEEPSEEK_RATE_LIMIT' && !error.message.includes(KEY));
});
