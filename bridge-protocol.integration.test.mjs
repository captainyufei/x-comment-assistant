import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBridge, PORT} from './bridge.mjs';

const TOKEN = 'protocol-fixture-private-bridge-token';
const REVIEW_TOKEN = 'protocol-fixture-private-review-token';
const EXTENSION_A = `chrome-extension://${'a'.repeat(32)}`;
const EXTENSION_B = `chrome-extension://${'b'.repeat(32)}`;
const LOCAL_ORIGIN = `http://127.0.0.1:${PORT}`;
const NEW_PROTOCOL = {'x-reply-protocol': '4'};
const SOURCE = {
  id: '1234567890123456789',
  url: 'https://x.com/protocol_test/status/1234567890123456789',
  author: '@protocol_test', authorName: '接口测试素材',
  text: '太好了，又加班到凌晨两点。', quote: '', hasMedia: false,
};
const UNDERSTANDING = {
  meaning: '作者用正面措辞反讽加班到深夜，表达不满。',
  signals: ['反讽', '吐槽'], evidence: ['太好了', '加班到凌晨两点'],
  contextStatus: 'sufficient', missingContext: '', replyAction: '接住加班吐槽，避免误当成庆祝。',
};
const STRUCTURED_REPLY = {
  understanding: UNDERSTANDING,
  candidates: [{style: 'humor', label: '接住吐槽', text: '再上会儿就能直接打早班的卡了。'}],
  timings: {totalMs: 1200},
};
const MISSING_REPLY = {
  understanding: {
    meaning: '正文未说明视频中发生的事。', signals: ['语境不足'], evidence: ['只看到正文，未读取对白'],
    contextStatus: 'missing', missingContext: '需要视频对白或关键画面的说明。', replyAction: '先补充视频语境。',
  },
  candidates: [], timings: {totalMs: 900},
};
const body = (changes = {}) => ({context: {...SOURCE, ...changes}, preferences: {style: 'mix', tone: '自然接话'}});

// Use the real handler and controlled writer promises. No listening socket,
// account access, extension installation or paid model request is involved.
async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reply-protocol-test-'));
  const reviewDataPath = join(dir, 'review-data.json');
  const reviewFeedbackPath = join(dir, 'review-feedback.json');
  await writeFile(reviewDataPath, JSON.stringify({version: 1, items: [{
    id: 'review_fixture', source: {type: 'unknown', url: '', text: '仅用于本机意见接口测试。'},
    generation: {status: 'pending'},
  }]}));
  const calls = [];
  const runner = {
    // Deliberately omit replyProtocol: the bridge advertises its own protocol,
    // independently of a writer implementation or model health snapshot.
    health: {service: 'yufei-x-reply-codex', version: 'fixture', authenticated: true, authentication: 'ChatGPT'},
    run(context, preferences, signal) {
      return new Promise((resolve, reject) => calls.push({context, preferences, signal, resolve, reject}));
    },
  };
  const bridge = createBridge({runner, token: TOKEN, reviewToken: REVIEW_TOKEN, reviewDataPath, reviewFeedbackPath, ...options});
  t.after(async () => {
    for (const call of calls) call.resolve(STRUCTURED_REPLY);
    await bridge.stop();
    await rm(dir, {recursive: true, force: true});
  });
  const request = ({method = 'GET', path = '/health', input, headers = {}, authenticated = true, rawHeaders} = {}) => {
    const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]);
    req.method = method; req.url = path;
    req.headers = {
      host: `127.0.0.1:${PORT}`,
      ...(input === undefined ? {} : {'content-type': 'application/json'}),
      ...(authenticated ? {'x-reply-bridge-token': TOKEN} : {}),
      ...headers,
    };
    req.rawHeaders = rawHeaders ?? Object.entries(req.headers).flatMap(([name, value]) => Array.isArray(value) ? value.flatMap(entry => [name, entry]) : [name, String(value)]);
    return new Promise((resolve, reject) => {
      const responseHeaders = new Map();
      let status;
      const res = {
        setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); },
        writeHead(code, extra = {}) {
          if (status !== undefined) throw new Error('headers were sent twice');
          status = code;
          for (const [name, value] of Object.entries(extra)) responseHeaders.set(name.toLowerCase(), value);
        },
        end(value = '') {
          const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
          let data;
          try { data = text ? JSON.parse(text) : null; } catch { data = text; }
          resolve({status, data, text, headers: responseHeaders});
        },
      };
      try { bridge.server.emit('request', req, res); } catch (error) { reject(error); }
    });
  };
  return {...bridge, request, calls};
}

function assertNoPrivateData(response, extra = []) {
  for (const value of [TOKEN, REVIEW_TOKEN, SOURCE.text, SOURCE.url, SOURCE.author, ...extra]) {
    assert.equal(response.text.includes(value), false, `denied response leaked ${value}`);
  }
  assert.equal('job' in (response.data ?? {}), false);
  assert.equal('context' in (response.data ?? {}), false);
  assert.equal('candidates' in (response.data ?? {}), false);
}

function assertUpdateRequired(response, extra = []) {
  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'EXTENSION_UPDATE_REQUIRED');
  assertNoPrivateData(response, extra);
}

async function createJob(h) {
  const created = await h.request({method: 'POST', path: '/jobs', input: body(), headers: NEW_PROTOCOL});
  assert.equal(created.status, 202);
  assert.equal(h.calls.length, 1);
  return created.data.job.id;
}

test('public health advertises protocol 4 without requiring client protocol or exposing credentials or job data', async t => {
  const h = await harness(t);
  for (const headers of [{}, {'x-reply-protocol': '1'}, {'x-reply-protocol': '2'}]) {
    const health = await h.request({authenticated: false, headers});
    assert.equal(health.status, 200);
    assert.equal(health.data.replyProtocol, '4');
    assert.equal(health.data.busy, false);
    for (const value of [TOKEN, REVIEW_TOKEN, SOURCE.text, SOURCE.url]) assert.equal(health.text.includes(value), false);
  }
  const id = await createJob(h);
  const running = await h.request({authenticated: false});
  assert.equal(running.data.replyProtocol, '4');
  assert.equal(running.data.busy, true);
  for (const value of [TOKEN, REVIEW_TOKEN, SOURCE.text, SOURCE.url, id]) assert.equal(running.text.includes(value), false);
});

test('legacy and multivalue POST clients receive update-required before any writer or job is created', async t => {
  const h = await harness(t);
  const invalidHeaders = [
    {}, {'x-reply-protocol': ''}, {'x-reply-protocol': '1'}, {'x-reply-protocol': '2'}, {'x-reply-protocol': '3'}, {'x-reply-protocol': '5'},
    {'x-reply-protocol': '4,4'}, {'x-reply-protocol': '4, 4'}, {'x-reply-protocol': ['4', '4']},
  ];
  for (const headers of invalidHeaders) {
    assertUpdateRequired(await h.request({method: 'POST', path: '/jobs', input: body(), headers}));
    assert.equal(h.calls.length, 0);
    assert.equal(h.jobs.size, 0);
  }
  // Node normalizes duplicate incoming custom headers to a comma-joined value.
  const duplicate = await h.request({method: 'POST', path: '/jobs', input: body(), headers: {'x-reply-protocol': '4, 4'}, rawHeaders: [
    'Host', `127.0.0.1:${PORT}`, 'X-Reply-Bridge-Token', TOKEN,
    'Content-Type', 'application/json', 'X-Reply-Protocol', '4', 'X-Reply-Protocol', '4',
  ]});
  assertUpdateRequired(duplicate);
  assert.equal(h.calls.length, 0);
});

test('unauthenticated job creation and reads remain 401 before protocol checks, without leaking a task or its source', async t => {
  const h = await harness(t);
  const id = await createJob(h);
  for (const path of ['/jobs', `/jobs/${id}`]) {
    for (const protocol of [undefined, '1', '2', '3', '4, 4', '4']) {
      for (const credential of [null, 'incorrect-token']) {
        const denied = await h.request({
          method: path === '/jobs' ? 'POST' : 'GET', path,
          ...(path === '/jobs' ? {input: body()} : {}), authenticated: false,
          headers: {...(protocol === undefined ? {} : {'x-reply-protocol': protocol}), ...(credential === null ? {} : {'x-reply-bridge-token': credential})},
        });
        assert.equal(denied.status, 401);
        assert.equal(denied.data.code, 'UNPAIRED');
        assertNoPrivateData(denied, [id]);
      }
    }
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.jobs.get(id).status, 'running');
});

test('host and paired-extension Origin checks take precedence over protocol negotiation', async t => {
  const h = await harness(t);
  assert.equal((await h.request({method: 'POST', path: '/pair', headers: {origin: EXTENSION_A}})).status, 200);
  for (const headers of [
    {host: 'attacker.example:8769'}, {origin: 'https://x.com'}, {origin: EXTENSION_B}, {'sec-fetch-site': 'cross-site'},
  ]) {
    const denied = await h.request({method: 'POST', path: '/jobs', input: body(), headers});
    assert.equal(denied.status, 403);
    assert.ok(['BAD_HOST', 'BAD_ORIGIN'].includes(denied.data.code));
    assertNoPrivateData(denied);
    assert.equal(denied.headers.has('access-control-allow-origin'), false);
  }
  assert.equal(h.calls.length, 0);
});

test('legacy GET clients cannot read task results or distinguish existing tasks before updating', async t => {
  const h = await harness(t);
  const id = await createJob(h);
  h.calls[0].resolve(STRUCTURED_REPLY);
  await h.jobs.get(id).settlement;
  for (const path of [`/jobs/${id}`, '/jobs/00000000-0000-0000-0000-000000000000']) {
    for (const headers of [{}, {'x-reply-protocol': '1'}, {'x-reply-protocol': '2'}, {'x-reply-protocol': '3'}, {'x-reply-protocol': '4, 4'}, {'x-reply-protocol': ['4', '4']}]) {
      const denied = await h.request({path, headers});
      assertUpdateRequired(denied, [id, STRUCTURED_REPLY.candidates[0].text, UNDERSTANDING.meaning]);
    }
  }
  assert.equal(h.calls.length, 1);
});

test('protocol 4 preserves an explicitly requested legacy mix candidate and repeated polling never starts another writer', async t => {
  const h = await harness(t);
  const id = await createJob(h);
  for (let i = 0; i < 3; i++) {
    const poll = await h.request({path: `/jobs/${id}`, headers: NEW_PROTOCOL});
    assert.equal(poll.status, 200);
    assert.equal(poll.data.job.status, 'running');
    assert.equal(h.calls.length, 1);
  }
  const legacyRetry = await h.request({method: 'POST', path: '/jobs', input: body()});
  assertUpdateRequired(legacyRetry, [id]);
  const duplicateNew = await h.request({method: 'POST', path: '/jobs', input: body(), headers: NEW_PROTOCOL});
  assert.equal(duplicateNew.status, 409);
  assert.equal(duplicateNew.data.code, 'BUSY');
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(STRUCTURED_REPLY);
  await h.jobs.get(id).settlement;
  for (let i = 0; i < 3; i++) {
    const result = await h.request({path: `/jobs/${id}`, headers: NEW_PROTOCOL});
    assert.equal(result.status, 200);
    assert.equal(result.data.job.id, id);
    assert.equal(result.data.job.status, 'completed');
    assert.deepEqual(result.data.job.understanding, UNDERSTANDING);
    assert.deepEqual(result.data.job.candidates, STRUCTURED_REPLY.candidates);
    assert.deepEqual(result.data.job.timings, STRUCTURED_REPLY.timings);
    assert.equal(result.data.job.context.text, SOURCE.text);
  }
  assert.equal(h.calls.length, 1);
});

test('protocol 4 preserves legacy missing-context understanding with zero candidates without inventing a reply', async t => {
  const h = await harness(t);
  const id = await createJob(h);
  h.calls[0].resolve(MISSING_REPLY);
  await h.jobs.get(id).settlement;
  const result = await h.request({path: `/jobs/${id}`, headers: NEW_PROTOCOL});
  assert.equal(result.status, 200);
  assert.equal(result.data.job.status, 'completed');
  assert.deepEqual(result.data.job.understanding, MISSING_REPLY.understanding);
  assert.deepEqual(result.data.job.candidates, []);
  assert.deepEqual(result.data.job.timings, MISSING_REPLY.timings);
  assert.equal(h.calls.length, 1);
});

test('legacy cancellation remains authenticated and Origin-bound, cancels only its existing task, and ignores late results', async t => {
  const h = await harness(t);
  await h.request({method: 'POST', path: '/pair', headers: {origin: EXTENSION_A}});
  const created = await h.request({method: 'POST', path: '/jobs', input: body(), headers: {...NEW_PROTOCOL, origin: EXTENSION_A}});
  assert.equal(created.status, 202);
  const id = created.data.job.id;
  for (const config of [
    {authenticated: false, headers: {origin: EXTENSION_A}},
    {headers: {origin: EXTENSION_A, 'x-reply-bridge-token': 'other-client-token'}},
    {headers: {origin: EXTENSION_B}},
  ]) {
    const denied = await h.request({method: 'DELETE', path: `/jobs/${id}`, ...config});
    assert.equal(denied.status, config.headers.origin === EXTENSION_B ? 403 : 401);
    assertNoPrivateData(denied, [id]);
    assert.equal(h.calls[0].signal.aborted, false);
  }
  const unknown = await h.request({method: 'DELETE', path: '/jobs/00000000-0000-0000-0000-000000000000', headers: {origin: EXTENSION_A}});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, 'JOB_EXPIRED');
  assertNoPrivateData(unknown, [id]);
  assert.equal(h.calls[0].signal.aborted, false);
  const cancelled = await h.request({method: 'DELETE', path: `/jobs/${id}`, headers: {origin: EXTENSION_A}});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.job.status, 'cancelled');
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls.length, 1);
  for (const protocol of ['1', '2', '3']) {
    const staleCancel = await h.request({method: 'DELETE', path: `/jobs/${id}`, headers: {origin: EXTENSION_A, 'x-reply-protocol': protocol}});
    assert.equal(staleCancel.status, 200);
    assert.equal(staleCancel.data.job.status, 'cancelled');
    assert.equal(h.calls.length, 1);
  }
  h.calls[0].resolve(STRUCTURED_REPLY);
  await h.jobs.get(id).settlement;
  const result = await h.request({path: `/jobs/${id}`, headers: {...NEW_PROTOCOL, origin: EXTENSION_A}});
  assert.equal(result.data.job.status, 'cancelled');
  assert.deepEqual(result.data.job.candidates, []);
  assert.equal(result.data.job.understanding, undefined);
  assert.equal(h.calls.length, 1);
});

test('pairing, automatic connect, and local review routes need their own credentials but no reply protocol', async t => {
  const h = await harness(t, {autoConnectOrigin: EXTENSION_A});
  const paired = await h.request({method: 'POST', path: '/pair', headers: {origin: EXTENSION_A}});
  assert.equal(paired.status, 200);
  const connect = await h.request({method: 'POST', path: '/extension/connect', authenticated: false, input: {extensionId: 'a'.repeat(32)}, headers: {origin: EXTENSION_A}});
  assert.equal(connect.status, 200);
  assert.equal(connect.data.token, TOKEN);
  const shell = await h.request({path: '/connect', authenticated: false, headers: {'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'}});
  assert.equal(shell.status, 200);
  const review = await h.request({path: '/review', authenticated: false, headers: {'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'}});
  assert.equal(review.status, 200);
  const reviewHeaders = {origin: LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin', 'x-review-token': REVIEW_TOKEN};
  const samples = await h.request({path: '/review-data', authenticated: false, headers: reviewHeaders});
  assert.equal(samples.status, 200);
  assert.equal(samples.data.items.length, 1);
  const saved = await h.request({method: 'POST', path: '/review-feedback', authenticated: false, headers: reviewHeaders, input: {itemId: 'review_fixture', rating: 'okay', opinion: '接口测试的意见。', ownReply: '', selectedCandidate: null}});
  assert.equal(saved.status, 200);
  assert.equal(saved.data.feedback.opinion, '接口测试的意见。');
  assert.equal(h.calls.length, 0);
});

test('CORS preflight allows the new protocol header without authorizing untrusted origins', async t => {
  const h = await harness(t);
  await h.request({method: 'POST', path: '/pair', headers: {origin: EXTENSION_A}});
  const allowed = await h.request({method: 'OPTIONS', path: '/jobs', authenticated: false, headers: {
    origin: EXTENSION_A, 'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type,x-reply-bridge-token,x-reply-protocol',
  }});
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), EXTENSION_A);
  assert.match(allowed.headers.get('access-control-allow-headers'), /(?:^|,\s*)X-Reply-Protocol(?:\s*,|$)/iu);
  for (const origin of [EXTENSION_B, 'https://attacker.example']) {
    const denied = await h.request({method: 'OPTIONS', path: '/jobs', authenticated: false, headers: {origin}});
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.has('access-control-allow-origin'), false);
    assertNoPrivateData(denied);
  }
  assert.equal(h.calls.length, 0);
});
