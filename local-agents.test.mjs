import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverLocalAgents, resolveAgentPath} from './local-agents.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'local-agents-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('discovery returns fixed agent IDs and checks executable files without running them', async t => {
  const dir = await directory(t);
  for (const id of ['codex', 'claude', 'gemini']) await writeFile(join(dir, id), '#!/bin/sh\nexit 78\n', {mode: 0o700});
  const agents = await discoverLocalAgents({env: {PATH: dir, HOME: dir}});
  assert.deepEqual(agents.map(agent => agent.id), ['codex', 'claude', 'gemini']);
  assert.deepEqual(agents.map(agent => agent.supported), [true, true, false]);
  assert.ok(agents.every(agent => agent.installed && agent.path === join(dir, agent.id)));
});

test('explicit overrides require a known agent and an absolute executable regular file', async t => {
  const dir = await directory(t), executable = join(dir, 'claude');
  await writeFile(executable, '# fixture', {mode: 0o600});
  assert.equal(await resolveAgentPath('claude', {env: {JIEYIJU_CLAUDE_PATH: executable}}), null);
  await chmod(executable, 0o700);
  assert.equal(await resolveAgentPath('claude', {env: {JIEYIJU_CLAUDE_PATH: executable}}), executable);
  assert.equal(await resolveAgentPath('claude', {env: {JIEYIJU_CLAUDE_PATH: './claude'}}), null);
  assert.equal(await resolveAgentPath('claude;touch bad', {env: {PATH: dir}}), null);
  await mkdir(join(dir, 'directory'));
  assert.equal(await resolveAgentPath('claude', {env: {JIEYIJU_CLAUDE_PATH: join(dir, 'directory')}}), null);
  assert.equal(await resolveAgentPath('claude', {env: {JIEYIJU_CLAUDE_PATH: join(dir, 'missing')}}), null);
});

test('relative PATH entries cannot shadow an installed agent', async t => {
  const dir = await directory(t), executable = join(dir, 'claude');
  await writeFile(executable, '# fixture', {mode: 0o700});
  assert.equal(await resolveAgentPath('claude', {env: {PATH: `.:relative-bin:${dir}`, HOME: dir}}), executable);
});
