import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createNetServer} from 'node:net';
import {createBridge, createWriterRunnerFromConfig, initializeWriterForBridge, BridgeError, CodexRunner,
  VERSION, REPLY_PROTOCOL} from './bridge.mjs';
import {ApiRunner, DeepSeekRunner} from './deepseek-runner.mjs';
import {AgentRunner} from './agent-runner.mjs';
import {PROVIDERS} from './extension/provider-catalog.js';

const KEY = 'model-integration-fixture-api-key';
const TOKEN = 'model-integration-fixture-bridge-token';
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const FOREIGN = `chrome-extension://${'b'.repeat(32)}`;
const SOURCE = {id: '1234567890123456789', url: 'https://x.com/model_fixture/status/1234567890123456789',
  author: '@model_fixture', text: '新工具终于把重复填表这件事解决了。', hasMedia: false};
const REPLY = {contextStatus: 'sufficient', missingContext: '', candidates: [
  {style: 'witty', text: '少填一次表，就能把那点精力留给真正要想的事情。'},
  {style: 'humor', text: '这次终于轮到表格自己加班了。'},
  {style: 'insight', text: '重复录入能省掉以后，最好把核对数据的那一步也安排好。'},
  {style: 'story', text: '工具值不值得用，往往就看明天还会不会想再打开它。'},
]};

test('runner factory explicitly dispatches all API and local-model providers without probing or invoking a CLI', async () => {
  let remoteCalls = 0, cliCalls = 0;
  const fetchImpl = async () => { remoteCalls++; throw new Error('fixture must not contact an API during initialization'); };
  const options = {env: {}, apiOptions: {fetchImpl}, deepseekOptions: {fetchImpl},
    codexOptions: {spawnImpl() { cliCalls++; throw new Error('API selection must not invoke Codex'); }},
    agentOptions: {spawnImpl() { cliCalls++; throw new Error('API selection must not invoke an agent'); }}};
  for (const descriptor of PROVIDERS.filter(item => item.kind !== 'agent')) {
    const model = descriptor.defaultModel || 'fixture-local-model:latest';
    const runner = createWriterRunnerFromConfig({provider: descriptor.id, model,
      ...(descriptor.kind === 'api' ? {apiKey: KEY} : {})}, options);
    assert.ok(runner instanceof ApiRunner);
    assert.equal(runner instanceof DeepSeekRunner, descriptor.id === 'deepseek');
    assert.equal(runner.health.writerProvider, descriptor.id);
    assert.equal(runner.health.writerModel, model);
    assert.equal(runner.health.version, VERSION);
    await runner.initialize();
    assert.equal(runner.health.authenticated, true);
    assert.equal(JSON.stringify(runner.health).includes(KEY), false);
  }
  assert.equal(remoteCalls, 0); assert.equal(cliCalls, 0);
});

test('runner factory keeps Codex and Claude adapters separate and rejects unknown providers instead of falling back', () => {
  const codex = createWriterRunnerFromConfig({provider: 'codex'}, {env: {JIEYIJU_CODEX_PATH: '/fixture/codex'}});
  assert.ok(codex instanceof CodexRunner); assert.equal(codex.codexPath, '/fixture/codex');
  const claude = createWriterRunnerFromConfig({provider: 'claude'}, {env: {PATH: '/fixture/bin'}});
  assert.ok(claude instanceof AgentRunner); assert.equal(claude.agent, 'claude');
  assert.equal(claude.model, '', 'local agent keeps its own model configuration');
  assert.equal(claude.health.writerProvider, 'claude');
  assert.equal(claude.health.authenticationVerified, false);
  const gemini = createWriterRunnerFromConfig({provider: 'gemini'}, {env: {}});
  assert.ok(gemini instanceof AgentRunner); assert.equal(gemini.agent, 'gemini');
  for (const provider of ['unknown', 'openai-compatible-arbitrary-host', '', null, undefined]) {
    assert.throws(() => createWriterRunnerFromConfig({provider}, {env: {}}), error =>
      error instanceof BridgeError && error.code === 'WRITER_CONFIG');
  }
});

async function freePort() {
  const reservation = createNetServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

async function liveBridge(t, options) {
  const port = await freePort();
  const bridge = createBridge({...options, port, token: TOKEN, autoConnectOrigin: ORIGIN});
  await new Promise((resolve, reject) => {
    bridge.server.once('error', reject); bridge.server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => bridge.stop());
  const request = async (path, {method = 'GET', body, origin = ORIGIN, token = TOKEN, protocol = REPLY_PROTOCOL} = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {method, redirect: 'error',
      headers: {...(origin === undefined ? {} : {origin}), ...(token === undefined ? {} : {'x-reply-bridge-token': token}),
        ...(protocol === undefined ? {} : {'x-reply-protocol': protocol}), ...(body === undefined ? {} : {'content-type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json(), allowOrigin: response.headers.get('access-control-allow-origin')};
  };
  return {...bridge, request};
}

test('failed CLI initialization keeps live HTTP health and authorized settings reads available, then swaps to an API without restarting', async t => {
  let initializationCalls = 0, oldRunCalls = 0, apiCalls = 0, writes = 0;
  const unavailable = {health: {service: 'fixture', version: VERSION, writerProvider: 'codex', writerModel: 'fixture-codex-model', authenticated: true},
    async initialize() { initializationCalls++; throw new BridgeError('CODEX_UNAVAILABLE', 'PRIVATE_CLI_FAILURE_DETAIL', 503); },
    async run() { oldRunCalls++; throw new Error('uninitialized CLI must never run'); }};
  const initial = await initializeWriterForBridge(unavailable);
  assert.equal(initial, unavailable); assert.equal(initializationCalls, 1);
  assert.equal(initial.health.authenticated, false);
  assert.equal(JSON.stringify(initial.health).includes('PRIVATE'), false);
  await assert.rejects(initial.run(SOURCE, {style: 'all'}, new AbortController().signal), error =>
    error instanceof BridgeError && error.code === 'CODEX_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  assert.equal(oldRunCalls, 0);

  let settings = {provider: 'codex', model: '', keyConfigured: false, checkScope: 'local'};
  const controller = {
    async read() { return {...settings}; },
    async write(input) {
      writes++;
      assert.equal(input.provider, 'openai'); assert.equal(input.apiKey, KEY);
      const runner = createWriterRunnerFromConfig(input, {env: {}, apiOptions: {fetchImpl: async () => {
        apiCalls++; return Response.json({choices: [{finish_reason: 'stop', message: {role: 'assistant', content: JSON.stringify(REPLY)}}]});
      }}});
      await runner.initialize();
      settings = {provider: 'openai', model: input.model, keyConfigured: true, checkScope: 'local'};
      return {runner, settings: {...settings, saved: true}};
    },
  };
  const h = await liveBridge(t, {runner: initial, writerSettings: controller});
  const health = await h.request('/health');
  assert.equal(health.status, 200); assert.equal(health.body.authenticated, false);
  assert.equal(health.body.writerProvider, 'codex'); assert.equal(health.body.busy, false);
  assert.equal((await h.request('/extension/connect', {method: 'POST', body: {extensionId: 'a'.repeat(32)}})).status, 200);
  const read = await h.request('/writer-settings/read', {method: 'POST', body: {}});
  assert.equal(read.status, 200); assert.deepEqual(read.body, settings);
  assert.equal(writes, 0); assert.equal(apiCalls, 0); assert.equal(oldRunCalls, 0);
  assert.equal((await h.request('/writer-settings/read', {method: 'POST', body: {}, origin: FOREIGN})).status, 403);
  assert.equal((await h.request('/writer-settings/read', {method: 'POST', body: {}, token: 'incorrect'})).status, 401);
  assert.equal((await h.request('/writer-settings/read', {method: 'POST', body: {}, protocol: '2'})).status, 409);
  assert.equal(writes, 0);

  const saved = await h.request('/writer-settings', {method: 'POST', body: {provider: 'openai', model: 'gpt-5.4-mini', apiKey: KEY}});
  assert.equal(saved.status, 200); assert.equal(saved.body.saved, true); assert.equal(saved.body.checkScope, 'local');
  assert.equal(saved.body.provider, 'openai'); assert.equal(JSON.stringify(saved.body).includes(KEY), false);
  assert.equal(writes, 1); assert.equal(apiCalls, 0);
  const after = await h.request('/health');
  assert.equal(after.body.writerProvider, 'openai'); assert.equal(after.body.authenticated, true);
  assert.equal(after.body.busy, false); assert.equal(after.body.replyProtocol, REPLY_PROTOCOL);
  assert.equal((await h.request('/writer-settings/read', {method: 'POST', body: {}})).body.provider, 'openai');

  const submitted = await h.request('/jobs', {method: 'POST', body: {context: SOURCE, preferences: {style: 'all'}}});
  assert.equal(submitted.status, 202);
  const job = h.jobs.get(submitted.body.job.id);
  await job.settlement;
  const completed = await h.request(`/jobs/${submitted.body.job.id}`);
  assert.equal(completed.status, 200); assert.equal(completed.body.job.status, 'completed');
  assert.equal(completed.body.job.candidates.length, 4);
  assert.equal(apiCalls, 1); assert.equal(oldRunCalls, 0); assert.equal(initializationCalls, 1);
  assert.equal(JSON.stringify(completed.body).includes(KEY), false);
});

test('unknown CLI initialization errors are sanitized while preserving local settings recovery', async () => {
  const runner = {health: {writerProvider: 'claude', authenticated: true},
    initialize: async () => { const error = new Error('PRIVATE_UNTRUSTED_DETAIL'); error.code = 'malformed/private-code'; throw error; },
    run: async () => { throw new Error('unavailable'); }};
  await initializeWriterForBridge(runner);
  assert.equal(runner.health.authenticated, false);
  await assert.rejects(runner.run(SOURCE, {style: 'all'}, new AbortController().signal), error =>
    error instanceof BridgeError && error.code === 'WRITER_UNAVAILABLE' && !error.message.includes('PRIVATE'));
});
