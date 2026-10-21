import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {stat} from 'node:fs/promises';
import {AgentRunner, agentEnvironment, claudeWriterArgs} from './agent-runner.mjs';

const SOURCE = {id: '1234567890123456789', url: 'https://x.com/agent_test/status/1234567890123456789',
  author: '@agent_test', text: '太好了，又加班到凌晨两点。', quote: '', hasMedia: false};
const REPLY = {contextStatus: 'sufficient', missingContext: '', candidates: [
  {style: 'witty', text: '加班到这个点，连抱怨都得省着点力气了。'},
  {style: 'humor', text: '再待会儿就能直接打早班的卡了。'},
  {style: 'insight', text: '白天排不开的工作最后都挤进晚上，最先该改的是排期。'},
  {style: 'story', text: '这个点还在工位上，明天又怎么有精神把活做好。'},
]};
const FLAGS = claudeWriterArgs('haiku').join(' ');
const absent = async () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; };

function setup(options = {}) {
  const probes = [];
  const runner = new AgentRunner({model: 'haiku', version: 'fixture', env: {HOME: '/fixture/home', PATH: '/fixture/bin'},
    resolveAgentPathImpl: async () => '/fixture/claude', statImpl: absent,
    execFileImpl: async (path, args, settings) => { probes.push({path, args, settings}); return {stdout: args[0] === '--version' ? '2.1.140 (Claude Code)' : FLAGS}; }, ...options});
  return {runner, probes};
}

async function processFixture(t, options = {}) {
  const controller = new AbortController(), calls = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const spawnImpl = (path, args, settings) => {
    const child = new EventEmitter(), call = {path, args, settings, child, signals: [], input: '', closed: false};
    calls.push(call);
    child.pid = 2_147_483_647; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    call.close = (code = 0) => { if (call.closed) return; call.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    child.kill = signal => { call.signals.push(signal); if (options.autoCloseOnKill !== false) queueMicrotask(() => call.close(1)); return true; };
    child.stdin = new Writable({write(chunk, _encoding, next) { call.input += chunk.toString('utf8'); next(); }, final(next) { next(); started(call); }});
    call.event = (event, {newline = true, splitBytes = false} = {}) => {
      const bytes = Buffer.from(`${JSON.stringify(event)}${newline ? '\n' : ''}`);
      if (splitBytes) for (const byte of bytes) child.stdout.write(Buffer.from([byte])); else child.stdout.write(bytes);
    };
    if (options.abortDuringSpawn) controller.abort();
    return child;
  };
  const {runner} = setup({spawnImpl, timeoutMs: options.timeoutMs ?? 1000});
  await runner.initialize();
  const promise = runner.run({...SOURCE}, {style: 'all'}, controller.signal);
  const outcome = promise.then(value => ({value}), error => ({error}));
  t.after(async () => { controller.abort(); for (const call of calls) call.close(1); await outcome; });
  return {runner, calls, controller, promise, outcome, ready};
}

test('Claude initialization is a local version/help probe, never a login or generation call', async () => {
  const {runner, probes} = setup();
  const health = await runner.initialize();
  assert.deepEqual(probes.map(call => call.args), [['--version'], ['--help']]);
  assert.equal(health.writerProvider, 'claude'); assert.equal(health.writerModel, 'haiku');
  assert.equal(health.authenticationVerified, false); assert.equal(health.checkScope, 'local');
  assert.equal(health.authentication.includes('未验证'), true);
  assert.equal(probes.every(call => call.settings.timeout <= 10_000), true);
});

test('missing, incompatible, Gemini and system-managed agents fail before generation', async () => {
  await assert.rejects(setup({resolveAgentPathImpl: async () => null}).runner.initialize(), {code: 'AGENT_UNAVAILABLE'});
  await assert.rejects(setup({execFileImpl: async () => ({stdout: 'legacy'})}).runner.initialize(), {code: 'AGENT_UNSUPPORTED'});
  await assert.rejects(setup({agent: 'gemini'}).runner.initialize(), {code: 'AGENT_UNSUPPORTED'});
  await assert.rejects(setup({statImpl: async () => ({})}).runner.initialize(), {code: 'AGENT_UNSUPPORTED'});
});

test('writer flags remove tools, MCP, hooks, skills, persistence and project settings without bypassing permissions', () => {
  const args = claudeWriterArgs('haiku');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks, true);
  assert.equal(args.includes('--bare'), false); assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.throws(() => claudeWriterArgs('haiku; unsafe'), {code: 'AGENT_CONFIG'});
  const env = agentEnvironment({HOME: '/fixture/home', PATH: '/bin', HTTPS_PROXY: 'http://127.0.0.1:7890',
    ANTHROPIC_API_KEY: 'PRIVATE', CODEX_APP_TOOLS_PIPE_PATH: 'PRIVATE', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1'});
  assert.equal(env.HOME, '/fixture/home'); assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(JSON.stringify(env).includes('PRIVATE'), false); assert.equal(env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1'); assert.equal(env.CLAUDE_CODE_DISABLE_ATTACHMENTS, '1');
});

test('one no-tools subprocess returns four parsed choices and cleans its private cwd', async t => {
  const f = await processFixture(t), call = await f.ready;
  assert.equal(call.settings.shell, false); assert.equal(call.settings.detached, true);
  assert.equal(call.input.includes(SOURCE.text), true); assert.equal(call.args.includes(SOURCE.text), false);
  call.event({type: 'system', subtype: 'init', tools: [], mcp_servers: []});
  call.event({type: 'assistant', message: {content: [{type: 'text', text: JSON.stringify(REPLY)}]}}, {splitBytes: true});
  call.event({type: 'result', subtype: 'success', result: JSON.stringify(REPLY)}, {newline: false, splitBytes: true});
  call.close(0);
  const result = await f.promise;
  assert.equal(result.candidates.length, 4); assert.equal(f.calls.length, 1);
  assert.equal(f.runner.health.authenticationVerified, true);
  await assert.rejects(stat(call.settings.cwd), {code: 'ENOENT'});
});

for (const event of [
  {type: 'assistant', message: {content: [{type: 'tool_use', name: 'Bash', input: {command: 'must never run'}}]}},
  {type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: []},
  {type: 'system', subtype: 'init', tools: [], mcp_servers: [{name: 'fixture'}]},
  {type: 'system', subtype: 'hook_started'},
]) {
  test(`tool/hook boundary rejects ${JSON.stringify(event)}`, async t => {
    const f = await processFixture(t), call = await f.ready;
    call.event(event);
    const {error} = await f.outcome;
    assert.equal(error.code, 'TOOL_BLOCKED'); assert.equal(call.signals.includes('SIGTERM'), true);
    await assert.rejects(stat(call.settings.cwd), {code: 'ENOENT'});
  });
}

test('unknown JSON events and provider output never become user-visible diagnostics', async t => {
  const f = await processFixture(t), call = await f.ready;
  call.event({type: 'unknown_new_event', secret: 'PRIVATE_PROVIDER_TEXT'});
  const {error} = await f.outcome;
  assert.equal(error.code, 'EVENT_FORMAT'); assert.equal(error.message.includes('PRIVATE'), false);
});

test('output limits terminate one subprocess without a retry', async t => {
  const f = await processFixture(t), call = await f.ready;
  call.child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const {error} = await f.outcome;
  assert.equal(error.code, 'OUTPUT_LIMIT'); assert.equal(f.calls.length, 1);
});

test('timeout kills the process group and waits for close before freeing the cwd', async t => {
  const f = await processFixture(t, {timeoutMs: 20}), call = await f.ready;
  const {error} = await f.outcome;
  assert.equal(error.code, 'TIMEOUT'); assert.equal(call.signals.includes('SIGTERM'), true);
  await assert.rejects(stat(call.settings.cwd), {code: 'ENOENT'});
});

for (const abortDuringSpawn of [false, true]) {
  test(`cancellation handles ${abortDuringSpawn ? 'spawn race' : 'running child'} without retrying`, async t => {
    const f = await processFixture(t, {abortDuringSpawn}), call = await f.ready;
    f.controller.abort();
    const {error} = await f.outcome;
    assert.equal(error.code, 'CANCELLED'); assert.equal(f.calls.length, 1);
    await assert.rejects(stat(call.settings.cwd), {code: 'ENOENT'});
  });
}

test('CLI login errors are sanitized and image-only requests cannot pretend to read media', async t => {
  const f = await processFixture(t), call = await f.ready;
  call.child.stderr.write('401 authentication failure PRIVATE_LOGIN_DETAIL'); call.close(1);
  const {error} = await f.outcome;
  assert.equal(error.code, 'AGENT_AUTH_REQUIRED'); assert.equal(error.message.includes('PRIVATE'), false);
  await assert.rejects(f.runner.run({...SOURCE, text: '', hasMedia: true}, {style: 'all'}, new AbortController().signal), {code: 'MEDIA_UNAVAILABLE'});
  assert.equal(f.calls.length, 1);
});

test('already cancelled jobs cannot probe or spawn an agent', async () => {
  const {runner, probes} = setup(), controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.run(SOURCE, {style: 'all'}, controller.signal), {code: 'CANCELLED'});
  assert.equal(probes.length, 0);
});

test('native spawn failures settle and do not expose executable paths', async () => {
  const {runner} = setup({spawnImpl() { throw new Error('/private/fixture/secret'); }});
  await runner.initialize();
  await assert.rejects(runner.run(SOURCE, {style: 'all'}, new AbortController().signal), error => {
    assert.equal(error.code, 'AGENT_UNAVAILABLE'); assert.equal(error.message.includes('/private'), false); return true;
  });
});

test('cancellation waits for native close before releasing files or job ownership', async t => {
  const f = await processFixture(t, {autoCloseOnKill: false}), call = await f.ready;
  f.controller.abort();
  assert.equal(call.signals.includes('SIGTERM'), true);
  assert.equal((await stat(call.settings.cwd)).isDirectory(), true);
  call.close(1);
  const {error} = await f.outcome;
  assert.equal(error.code, 'CANCELLED');
  await assert.rejects(stat(call.settings.cwd), {code: 'ENOENT'});
});

test('a malformed final JSONL event cannot hide behind a successful result', async t => {
  const f = await processFixture(t), call = await f.ready;
  call.event({type: 'result', subtype: 'success', result: JSON.stringify(REPLY)});
  call.child.stdout.write('{malformed PRIVATE_STREAM'); call.close(0);
  const {error} = await f.outcome;
  assert.equal(error.code, 'EVENT_FORMAT'); assert.equal(error.message.includes('PRIVATE'), false);
  assert.deepEqual(call.signals, [], 'never signal a process group after native close');
});

test('text with attached media carries an explicit evidence limitation into the prompt', async t => {
  const f = await processFixture(t), first = await f.ready;
  first.event({type: 'result', subtype: 'success', result: JSON.stringify(REPLY)}); first.close(0); await f.promise;
  const promise = f.runner.run({...SOURCE, hasMedia: true}, {style: 'all'}, f.controller.signal);
  while (f.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  const call = f.calls[1];
  assert.equal(call.input.includes('未读取图片、视频画面或声音'), true);
  call.event({type: 'result', subtype: 'success', result: JSON.stringify(REPLY)}); call.close(0);
  await promise;
});

const retryNotice = (values = {}) => ({type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10,
  retry_delay_ms: 555.876, error_status: 503, error: 'server_error', ...values});

test('official system/api_retry progress keeps the same no-tools process through a successful result', async t => {
  const f = await processFixture(t), call = await f.ready;
  call.event({type: 'system', subtype: 'init', tools: [], mcp_servers: []});
  call.event(retryNotice(), {splitBytes: true});
  call.event(retryNotice({attempt: 2, error_status: null, error: 'unknown'}));
  assert.deepEqual(call.signals, []);
  call.event({type: 'result', subtype: 'success', result: JSON.stringify(REPLY)}); call.close(0);
  assert.equal((await f.promise).candidates.length, 4); assert.equal(f.calls.length, 1);
});

for (const [values, code] of [
  [{error_status: 401, error: 'authentication_failed'}, 'AGENT_AUTH_REQUIRED'],
  [{error_status: 403, error: 'oauth_org_not_allowed'}, 'AGENT_AUTH_REQUIRED'],
  [{error_status: 402, error: 'billing_error'}, 'AGENT_USAGE_LIMIT'],
  [{error_status: 404, error: 'model_not_found'}, 'AGENT_CONFIG'],
  [{error: 'PRIVATE_UNRECOGNIZED_CATEGORY'}, 'EVENT_FORMAT'],
  [{attempt: -1}, 'EVENT_FORMAT'],
]) {
  test(`retry event handles ${code} without leaking provider content`, async t => {
    const f = await processFixture(t), call = await f.ready;
    call.event(retryNotice(values));
    const {error} = await f.outcome;
    assert.equal(error.code, code); assert.equal(error.message.includes('PRIVATE'), false);
    assert.equal(call.signals.includes('SIGTERM'), true);
  });
}

test('retry progress never bypasses tool, permission, hook or unknown-event guards', async t => {
  const f = await processFixture(t), call = await f.ready;
  call.event(retryNotice());
  call.event(retryNotice({embedded: {type: 'tool_use', name: 'Bash'}}));
  assert.equal((await f.outcome).error.code, 'TOOL_BLOCKED');
});

test('protocol diagnostics contain bounded event metadata only, never event bodies or credentials', async t => {
  const entries = [], f = await processFixture(t), call = await f.ready;
  f.runner.onDiagnostic = entry => entries.push(entry);
  call.event({type: 'system', subtype: 'init', tools: [], mcp_servers: [], apiKey: 'PRIVATE_AUTH', cwd: '/private/fixture'});
  call.event({type: 'result', subtype: 'success', result: JSON.stringify(REPLY)}); call.close(0);
  await f.promise;
  assert.deepEqual(entries, [{event: 'agent_protocol_event', type: 'system', subtype: 'init'},
    {event: 'agent_protocol_event', type: 'result', subtype: 'success'}]);
  assert.equal(JSON.stringify(entries).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(entries).includes('/private'), false);
  assert.equal(JSON.stringify(entries).includes(REPLY.candidates[0].text), false);
});
