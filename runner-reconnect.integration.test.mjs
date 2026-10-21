import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {readFile, writeFile, stat} from 'node:fs/promises';
import {CodexRunner, BridgeError} from './bridge.mjs';

const SOURCE = {
  id: '1234567890123456789', url: 'https://x.com/reconnect_test/status/1234567890123456789',
  author: '@reconnect_test', authorName: '重连测试素材',
  text: '太好了，又加班到凌晨两点。', quote: '', hasMedia: false,
};
const REPLY = {
  understanding: {
    meaning: '作者用正面措辞反讽加班到深夜，表达不满。',
    signals: ['反讽', '吐槽'], evidence: ['太好了', '加班到凌晨两点'],
    contextStatus: 'sufficient', missingContext: '', replyAction: '接住吐槽，不当成庆祝。',
  },
  candidates: [{style: 'humor', label: '接住吐槽', text: '再上会儿就能直接打早班的卡了。'}],
};
const reconnect = (attempt = 2, reason = 'stream disconnected before completion: websocket closed by server before response.completed') => ({
  type: 'error', message: `Reconnecting... ${attempt}/5 (${reason})`,
});
const TOOL = {type: 'item.started', item: {type: 'command_execution', command: 'fixture tool must be rejected'}};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return {promise, resolve};
}

// Controlled fake child processes exercise the real writer parser, cleanup and
// AbortSignal behavior. No CLI, provider, account or external service is called.
function fixture(t, {timeoutMs = 1000, autoCloseOnKill = true, abortDuringSpawn = false} = {}) {
  const controller = new AbortController();
  const started = deferred();
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    const call = {executable, args, options, child, signals: [], closed: false, stdin: ''};
    calls.push(call);
    child.pid = 2_147_483_647; // Invalid real process group; kills fall back to this fake.
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    call.close = (code = 0) => {
      if (call.closed) return;
      call.closed = true;
      child.stdout.end(); child.stderr.end(); child.emit('close', code);
    };
    child.kill = signal => {
      call.signals.push(signal);
      if (autoCloseOnKill) queueMicrotask(() => call.close(1));
      return true;
    };
    const chunks = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) { call.stdin = Buffer.concat(chunks).toString('utf8'); callback(); started.resolve(call); },
    });
    call.event = (event, {newline = true, splitBytes = false} = {}) => {
      const bytes = Buffer.from(`${JSON.stringify(event)}${newline ? '\n' : ''}`);
      if (splitBytes) for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      else child.stdout.write(bytes);
    };
    call.output = async (reply = REPLY) => {
      const schemaPath = args[args.indexOf('--output-schema') + 1];
      call.schema = JSON.parse(await readFile(schemaPath, 'utf8'));
      await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(reply));
    };
    if (abortDuringSpawn) controller.abort(new Error('user switched post while spawning'));
    return child;
  };
  const runner = new CodexRunner({spawnImpl, timeoutMs, fetchImpl: async () => { throw new Error('text-only fixture must not fetch media'); }});
  const promise = runner.run({...SOURCE}, {style: 'mix', tone: '自然接话'}, controller.signal);
  const outcome = promise.then(value => ({value}), error => ({error}));
  t.after(async () => {
    controller.abort();
    for (const call of calls) call.close(1);
    await outcome;
  });
  return {runner, controller, calls, started: started.promise, promise, outcome};
}

async function assertCleaned(call) {
  await assert.rejects(stat(call.options.cwd), {code: 'ENOENT'});
}

async function assertFailure(f, code) {
  const result = await f.outcome;
  assert.ok(result.error instanceof BridgeError);
  assert.equal(result.error.code, code);
  assert.equal(f.calls.length, 1);
  await assertCleaned(f.calls[0]);
  return result.error;
}

test('official recoverable reconnect notice keeps the same CLI alive through strict structured completion', async t => {
  const f = fixture(t);
  const call = await f.started;
  call.event(reconnect(), {splitBytes: true});
  assert.deepEqual(call.signals, [], 'an informational reconnect must not terminate the existing CLI');
  await call.output();
  call.event({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(REPLY)}}, {splitBytes: true});
  call.event({type: 'turn.completed', usage: {input_tokens: 20, output_tokens: 30}});
  call.close(0);
  const result = await f.promise;
  assert.deepEqual(result.understanding, REPLY.understanding);
  assert.deepEqual(result.candidates, REPLY.candidates);
  assert.equal(result.timings.cliReconnects, 1);
  assert.equal(call.schema.additionalProperties, false);
  assert.equal(call.schema.properties.candidates.maxItems, 2);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(call.signals, []);
  assert.equal(call.options.shell, false);
  await assertCleaned(call);
});

test('multiple reconnect notices are counted without spawning or submitting another writer', async t => {
  const f = fixture(t);
  const call = await f.started;
  call.event(reconnect(2)); call.event(reconnect(3));
  assert.deepEqual(call.signals, []);
  await call.output();
  call.event({type: 'item.completed', item: {type: 'agent_message', text: '合法中文草稿'}});
  call.event({type: 'turn.completed'});
  call.close(0);
  const result = await f.promise;
  assert.equal(result.timings.cliReconnects, 2);
  assert.equal(f.calls.length, 1);
  await assertCleaned(call);
});

test('a reconnect notification on the final unterminated line is still informational', async t => {
  const f = fixture(t);
  const call = await f.started;
  await call.output();
  call.event({type: 'item.completed', item: {type: 'agent_message', text: '合法草稿'}});
  call.event(reconnect(), {newline: false});
  call.close(0);
  const result = await f.promise;
  assert.equal(result.timings.cliReconnects, 1);
  assert.deepEqual(result.candidates, REPLY.candidates);
  assert.deepEqual(call.signals, []);
  assert.equal(f.calls.length, 1);
  await assertCleaned(call);
});

test('terminal turn.failed remains fatal after reconnect notifications even if it repeats reconnect wording', async t => {
  const f = fixture(t);
  const call = await f.started;
  call.event(reconnect());
  assert.deepEqual(call.signals, []);
  call.event({type: 'turn.failed', error: {message: reconnect().message}});
  const failure = await assertFailure(f, 'NETWORK');
  assert.ok(call.signals.includes('SIGTERM'));
  assert.equal(failure.message.includes(SOURCE.text), false);
});

for (const newline of [true, false]) {
  test(`tool execution after reconnect is rejected (${newline ? 'terminated' : 'unterminated final'} JSONL line)`, async t => {
    const f = fixture(t);
    const call = await f.started;
    call.event(reconnect());
    assert.deepEqual(call.signals, []);
    call.event(TOOL, {newline});
    if (!newline) call.close(0);
    await assertFailure(f, 'TOOL_BLOCKED');
  });
}

test('a terminal network failure cannot hide a later tool event in the final unterminated line', async t => {
  const f = fixture(t, {autoCloseOnKill: false});
  const call = await f.started;
  call.event(reconnect());
  call.event({type: 'turn.failed', error: {message: 'stream disconnected before completion'}});
  call.event(TOOL, {newline: false});
  call.close(1);
  await assertFailure(f, 'TOOL_BLOCKED');
});

test('malformed JSONL after reconnect remains fatal instead of being treated as a warning', async t => {
  const f = fixture(t);
  const call = await f.started;
  call.event(reconnect());
  call.child.stdout.write('{broken event}\n');
  await assertFailure(f, 'EVENT_FORMAT');
});

test('valid reconnect notice never exempts malformed structured reply output from validation', async t => {
  const f = fixture(t);
  const call = await f.started;
  call.event(reconnect());
  await call.output({...REPLY, unexpected: 'not allowed by the strict reply schema'});
  call.event({type: 'turn.completed'}); call.close(0);
  await assertFailure(f, 'INVALID_CANDIDATES');
});

test('cancellation after reconnect waits for close, cleans up, and never starts another CLI', async t => {
  const f = fixture(t, {autoCloseOnKill: false});
  const call = await f.started;
  call.event(reconnect());
  assert.deepEqual(call.signals, []);
  let settled = false;
  f.outcome.then(() => { settled = true; });
  f.controller.abort(new Error('reply window closed'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'sending SIGTERM is not proof the process is closed');
  assert.ok(call.signals.includes('SIGTERM'));
  assert.equal((await stat(call.options.cwd)).isDirectory(), true);
  call.close(1);
  await assertFailure(f, 'CANCELLED');
});

test('timeout after reconnect still stops the same CLI and removes its temporary directory', async t => {
  const f = fixture(t, {timeoutMs: 80});
  const call = await f.started;
  call.event(reconnect());
  assert.deepEqual(call.signals, []);
  await delay(15); call.event(reconnect(3));
  await assertFailure(f, 'TIMEOUT');
  assert.ok(call.signals.includes('SIGTERM'));
});

test('cancellation triggered inside spawn cannot fall into the abort-listener registration gap', async t => {
  const f = fixture(t, {abortDuringSpawn: true, timeoutMs: 1000});
  await assertFailure(f, 'CANCELLED');
  assert.ok(f.calls[0].signals.includes('SIGTERM'));
});

for (const [message, expectedCode] of [
  ['An unfamiliar CLI warning SECRET must fail closed', 'CODEX_FAILED'],
  ['Reconnecting... 2/5 (unrecognized transport failure SECRET)', 'NETWORK'],
  ['Reconnecting... 6/5 (stream disconnected before completion: websocket closed by server before response.completed)', 'NETWORK'],
  ['401 unauthorized SECRET', 'AUTH_REQUIRED'],
  ['Reconnecting... 2/5 (401 unauthorized SECRET)', 'AUTH_REQUIRED'],
  ['429 rate limit exceeded SECRET', 'USAGE_LIMIT'],
  ['Reconnecting... 2/5 (429 rate limit exceeded SECRET)', 'USAGE_LIMIT'],
  ['unsupported feature configuration SECRET', 'CODEX_CONFIG'],
]) {
  test(`unknown or nonrecoverable error is rejected without a second spawn: ${expectedCode} ${message.slice(0, 35)}`, async t => {
    const f = fixture(t);
    const call = await f.started;
    call.event({type: 'error', message});
    const failure = await assertFailure(f, expectedCode);
    assert.ok(call.signals.includes('SIGTERM'));
    assert.equal(failure.message.includes('SECRET'), false);
  });
}
