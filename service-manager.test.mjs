import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {SERVICE_LABEL, HEALTH_URL, RUNTIME_FILES, ServiceError, buildLaunchAgent, probeBridge, createServiceManager, runServiceCommand} from './service-manager.mjs';

const sourceRoot = '/fixture/X 运营';
const home = '/fixture/用户 & 本机';
const writerConfig = join(home, 'Library', 'Application Support', 'Jieyiju', 'writer-config.json');
const deepSeekKey = join(home, 'Library', 'Application Support', 'Jieyiju', 'deepseek-api-key');
const ready = {state:'running', health:{service:'yufei-x-reply-codex', version:'0.4.1', authenticated:true, busy:false}};
const absent = {state:'stopped'};
const missing = () => Object.assign(new Error('missing'), {code:'ENOENT'});

function fixture({probes = [absent, ready], registered = false, owned = true, failLaunch, environment = {}, fsFailure} = {}) {
  const files = new Map();
  const modes = new Map();
  const directories = new Set(['/opt/homebrew/bin']);
  const symlinks = new Set();
  const calls = [];
  const waits = [];
  const writes = [];
  let injectedBootstrapFailures = [];
  let configuredReleaseRegistrations = [];
  let releaseRegistrations = [];
  for (const name of RUNTIME_FILES) files.set(join(sourceRoot, name), Buffer.from(name === 'package.json' ? '{"type":"module","version":"0.4.1"}' : name));
  const fsImpl = {
    async lstat(path) {
      if (symlinks.has(path)) return {isSymbolicLink:() => true, isFile:() => false, isDirectory:() => false};
      if (directories.has(path)) return {isSymbolicLink:() => false, isFile:() => false, isDirectory:() => true};
      if (!files.has(path)) throw missing();
      return {isSymbolicLink:() => false, isFile:() => true, isDirectory:() => false};
    },
    async access(path) { if (!['/opt/homebrew/bin/node', '/opt/homebrew/bin/codex'].includes(path)) throw missing(); },
    async readFile(path) { if (!files.has(path)) throw missing(); return Buffer.from(files.get(path)); },
    async mkdir(path, options) { directories.add(path); if (options?.mode) modes.set(path, options.mode); },
    async chmod(path, mode) { modes.set(path, mode); },
    async writeFile(path, content, options) {
      if (fsFailure?.(path)) throw Object.assign(new Error('credential should never leak'), {code:'EACCES'});
      if (options?.flag === 'wx' && files.has(path)) throw Object.assign(new Error('exists'), {code:'EEXIST'});
      writes.push(path); files.set(path, Buffer.from(content)); modes.set(path, options.mode);
    },
    async rename(from, to) { files.set(to, files.get(from)); modes.set(to, modes.get(from)); files.delete(from); },
    async rm(path) { files.delete(path); },
  };
  const launchctlImpl = async args => {
    calls.push(args);
    if (failLaunch?.(args)) throw new Error('launch failure credential should never leak');
    if (args[0] === 'print') {
      if (releaseRegistrations.length) {
        const result = releaseRegistrations.shift();
        registered = result.registered;
        if (result.owned !== undefined) owned = result.owned;
      }
      if (!registered) throw Object.assign(new Error('not found'), {stderr:'Could not find service'});
      return {stdout:`gui/501/${SERVICE_LABEL} = {\n path = ${owned ? join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`) : '/other/service.plist'}\n}`};
    }
    if (args[0] === 'bootout') {
      registered = false;
      releaseRegistrations = [...configuredReleaseRegistrations];
    }
    if (args[0] === 'bootstrap' && injectedBootstrapFailures.length) {
      const result = injectedBootstrapFailures.shift();
      if (result.registered !== undefined) registered = result.registered;
      if (result.owned !== undefined) owned = result.owned;
      throw result.error;
    }
    if (args[0] === 'bootstrap') registered = true;
    return {stdout:''};
  };
  let probeIndex = 0;
  const manager = createServiceManager({sourceRoot, home, uid:501, platform:'darwin', fsImpl, launchctlImpl,
    environment, probeImpl:async () => probes[Math.min(probeIndex++, probes.length - 1)], sleepImpl:async ms => { waits.push(ms); }, readinessAttempts:3});
  return {manager, fsImpl, files, modes, directories, symlinks, calls, waits, writes,
    setProbes(values) { probes = values; probeIndex = 0; },
    setBootstrapFailures(values) { injectedBootstrapFailures = [...values]; },
    setReleaseRegistrations(values) { configuredReleaseRegistrations = [...values]; }};
}

test('plist uses a fixed user agent, absolute arguments, automatic recovery, and private log paths', async () => {
  const f = fixture();
  const result = await f.manager.install();
  assert.equal(result.managed, true);
  const plist = f.files.get(f.manager.paths.plistPath).toString();
  assert.match(plist, /<key>Label<\/key><string>com\.yufei\.jieyiju\.bridge<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /Application Support\/Jieyiju\/runtime\/bridge\.mjs/);
  assert.match(plist, /用户 &amp; 本机/);
  assert.doesNotMatch(plist, /Cellar|X 运营|\/bin\/(?:zsh|sh)|-c|0\.0\.0\.0/);
  assert.deepEqual(f.calls.filter(([command]) => command !== 'print'), [
    ['enable', 'gui/501/com.yufei.jieyiju.bridge'],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath],
  ]);
});

test('runtime copy is allowlisted, private, and preserves unknown files', async () => {
  const f = fixture();
  for (const name of ['auth.json', 'drafts.json', 'unknown.txt', 'bridge.test.mjs']) f.files.set(join(sourceRoot, name), Buffer.from('do not copy'));
  const unknown = join(f.manager.paths.runtime, 'user-note.txt');
  f.files.set(unknown, Buffer.from('preserve'));
  await f.manager.install();
  for (const name of RUNTIME_FILES) {
    const path = join(f.manager.paths.runtime, name);
    assert.ok(f.files.has(path));
    assert.equal(f.modes.get(path), 0o600);
  }
  for (const name of ['auth.json', 'drafts.json', 'unknown.txt', 'bridge.test.mjs']) assert.equal(f.files.has(join(f.manager.paths.runtime, name)), false);
  assert.equal(f.files.get(unknown).toString(), 'preserve');
  assert.equal(f.modes.get(f.manager.paths.runtime), 0o700);
  assert.equal(f.modes.get(join(f.manager.paths.runtime, 'extension')), 0o700);
  assert.equal(f.modes.get(f.manager.paths.logDir), 0o700);
  assert.equal(f.modes.get(f.manager.paths.plistPath), 0o600);
  assert.equal(f.modes.get(join(f.manager.paths.logDir, 'bridge.error.log')), 0o600);
  assert.equal([...f.files.keys()].some(path => path.includes('.tmp-')), false);
});

test('only safe login environment persists, including an explicit existing CODEX_HOME', async () => {
  const f = fixture({environment:{CODEX_HOME:'/private/local/codex', OPENAI_API_KEY:'secret-key', HTTPS_PROXY:'https://name:password@proxy', MCP_PIPE:'secret', PATH:'/untrusted', HOME:'/incorrect'}});
  await f.manager.install();
  const plist = f.files.get(f.manager.paths.plistPath).toString();
  assert.match(plist, /<key>CODEX_HOME<\/key><string>\/private\/local\/codex<\/string>/);
  assert.match(plist, /<key>JIEYIJU_CODEX_PATH<\/key><string>\/opt\/homebrew\/bin\/codex<\/string>/);
  assert.doesNotMatch(plist, /secret|password|proxy|untrusted|incorrect|OPENAI_API_KEY|MCP_PIPE/);
});

test('DeepSeek installs with only Node, never checks Codex or reads and copies API credentials', async () => {
  const f = fixture({environment:{CODEX_HOME:'/private/unused/codex', DEEPSEEK_API_KEY:'fixture-secret'}});
  f.files.set(writerConfig, Buffer.from(JSON.stringify({version:1, provider:'deepseek', model:'deepseek-flash'})));
  f.files.set(deepSeekKey, Buffer.from('fixture-secret'));
  const checked = [];
  f.fsImpl.access = async path => {
    checked.push(path);
    if (path !== '/opt/homebrew/bin/node') throw missing();
  };
  const originalRead = f.fsImpl.readFile;
  f.fsImpl.readFile = async path => {
    assert.notEqual(path, deepSeekKey, 'the installer must not read the API key');
    return originalRead(path);
  };
  assert.equal((await f.manager.install()).managed, true);
  assert.deepEqual(checked, ['/opt/homebrew/bin/node']);
  const plist = f.files.get(f.manager.paths.plistPath).toString();
  assert.doesNotMatch(plist, /JIEYIJU_CODEX_PATH|CODEX_HOME|DEEPSEEK_API_KEY|fixture-secret|deepseek-api-key/);
  assert.equal(f.files.get(deepSeekKey).toString(), 'fixture-secret');
  assert.equal(f.files.has(join(f.manager.paths.runtime, 'deepseek-api-key')), false);
  assert.equal(f.files.has(join(f.manager.paths.runtime, 'writer-config.json')), false);
  assert.ok(f.files.has(join(f.manager.paths.runtime, 'writer-config.mjs')));
  assert.ok(f.files.has(join(f.manager.paths.runtime, 'deepseek-runner.mjs')));
});

test('atomic popup selection takes precedence without copying its private credential into runtime or plist', async () => {
  for (const provider of ['deepseek','codex']) {
    const f = fixture();
    const atomic = join(home, 'Library', 'Application Support', 'Jieyiju', 'writer-settings-state.json');
    f.files.set(writerConfig, Buffer.from(JSON.stringify({version:1,provider:provider==='deepseek'?'codex':'deepseek'})));
    f.files.set(atomic, Buffer.from(JSON.stringify({version:1,provider,...(provider==='deepseek'?{model:'deepseek-flash'}:{}),deepseekApiKey:'fixture-private-popup-key'})));
    const checked = [];
    const access = f.fsImpl.access;
    f.fsImpl.access = async path => { checked.push(path); if(provider==='deepseek'&&path.endsWith('/codex'))throw missing(); return access(path); };
    assert.equal((await f.manager.install()).managed,true);
    assert.equal(checked.includes('/opt/homebrew/bin/codex'),provider==='codex');
    assert.equal(f.files.has(join(f.manager.paths.runtime,'writer-settings-state.json')),false);
    assert.doesNotMatch(f.files.get(f.manager.paths.plistPath).toString(),/fixture-private-popup-key|deepseekApiKey/);
    for(const file of RUNTIME_FILES)assert.ok(!f.files.get(join(f.manager.paths.runtime,file)).includes(Buffer.from('fixture-private-popup-key')));
  }
});

test('a missing selected Codex still installs the bridge so the user can switch model sources', async () => {
  for (const settings of [null, {version:1, provider:'codex'}]) {
    const f = fixture();
    if (settings) f.files.set(writerConfig, Buffer.from(JSON.stringify(settings)));
    const checked = [];
    f.fsImpl.access = async path => {
      checked.push(path);
      if (path !== '/opt/homebrew/bin/node') throw missing();
    };
    assert.equal((await f.manager.install()).managed,true);
    assert.deepEqual(checked, ['/opt/homebrew/bin/node', '/opt/homebrew/bin/codex', '/usr/local/bin/codex']);
    assert.ok(f.writes.length>0);
    assert.ok(f.calls.some(([operation])=>operation==='bootstrap'));
    assert.doesNotMatch(f.files.get(f.manager.paths.plistPath).toString(),/JIEYIJU_CODEX_PATH/);
  }
});

test('invalid public writer settings fail before runtime writes or launchctl changes', async () => {
  for (const value of [
    'not JSON', 'null', '[]', '{"version":1,"provider":"other"}',
    '{"version":2,"provider":"deepseek"}',
    '{"version":1,"provider":"deepseek","model":"https://invalid.test"}',
    '{"version":1,"provider":"deepseek","apiKey":"fixture-secret"}',
    '{"version":1,"provider":"codex","model":"gpt-6.1-sol"}',
    ' '.repeat(8193),
  ]) {
    const f = fixture();
    f.files.set(writerConfig, Buffer.from(value));
    await assert.rejects(f.manager.install(), failure => {
      assert.equal(failure.code, 'WRITER_CONFIG');
      assert.doesNotMatch(failure.message, /fixture-secret|not JSON|unsupported/);
      return true;
    });
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.calls, []);
  }
});

test('linked or non-file public writer configuration is rejected without following it', async () => {
  for (const kind of ['symlink', 'directory']) {
    const f = fixture();
    if (kind === 'symlink') f.symlinks.add(writerConfig);
    else f.directories.add(writerConfig);
    await assert.rejects(f.manager.install(), {code:'UNSAFE_FILE'});
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.calls, []);
  }
});

test('unreadable public writer configuration is reported without underlying error details', async () => {
  const f = fixture();
  f.files.set(writerConfig, Buffer.from('{"version":1,"provider":"deepseek"}'));
  const originalRead = f.fsImpl.readFile;
  f.fsImpl.readFile = async path => {
    if (path === writerConfig) throw Object.assign(new Error('fixture-secret'), {code:'EACCES'});
    return originalRead(path);
  };
  await assert.rejects(f.manager.install(), failure => {
    assert.equal(failure.code, 'WRITER_CONFIG');
    assert.doesNotMatch(failure.message, /fixture-secret/);
    return true;
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, []);
});

test('switching from Codex to DeepSeek reloads only the owned agent and preserves the config and key', async () => {
  const f = fixture();
  await f.manager.install();
  const config = '{"version":1,"provider":"deepseek"}';
  f.files.set(writerConfig, Buffer.from(config));
  f.files.set(deepSeekKey, Buffer.from('fixture-secret'));
  f.calls.length = 0;
  f.writes.length = 0;
  f.setProbes([ready]);
  f.fsImpl.access = async path => { if (path !== '/opt/homebrew/bin/node') throw missing(); };
  assert.equal((await f.manager.install()).changed, true);
  assert.deepEqual(f.calls.filter(([command]) => command !== 'print'), [
    ['enable', f.manager.paths.target], ['bootout', f.manager.paths.target],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath],
  ]);
  assert.doesNotMatch(f.files.get(f.manager.paths.plistPath).toString(), /JIEYIJU_CODEX_PATH|fixture-secret/);
  assert.equal(f.files.get(writerConfig).toString(), config);
  assert.equal(f.files.get(deepSeekKey).toString(), 'fixture-secret');
  assert.equal(f.writes.includes(writerConfig), false);
  assert.equal(f.writes.includes(deepSeekKey), false);
});

test('repeated installation with identical bytes does not restart an already healthy agent', async () => {
  const f = fixture();
  assert.equal((await f.manager.install()).changed, true);
  f.calls.length = 0; f.writes.length = 0; f.setProbes([ready]);
  assert.equal((await f.manager.install()).changed, false);
  assert.deepEqual(f.calls, [['print', f.manager.paths.target], ['enable', f.manager.paths.target]]);
  assert.deepEqual(f.writes, []);
});

test('an update gracefully reloads only this fixed registered agent', async () => {
  const f = fixture();
  await f.manager.install();
  f.files.set(join(sourceRoot, 'prompt.js'), Buffer.from('updated prompt'));
  f.calls.length = 0; f.setProbes([ready]);
  await f.manager.install();
  assert.deepEqual(f.calls.filter(([command]) => command !== 'print'), [
    ['enable', f.manager.paths.target], ['bootout', f.manager.paths.target],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath],
  ]);
  assert.equal(f.calls.some(args => args.includes('-k') || args[0] === 'kill'), false);
  assert.equal(f.files.get(join(f.manager.paths.runtime, 'prompt.js')).toString(), 'updated prompt');
});

test('busy generation blocks runtime updates before writes or service interruption', async () => {
  const f = fixture(); await f.manager.install();
  f.files.set(join(sourceRoot, 'prompt.js'), Buffer.from('updated while busy'));
  f.calls.length = 0; f.writes.length = 0;
  f.setProbes([{...ready, health:{...ready.health, busy:true}}]);
  await assert.rejects(f.manager.install(), {code:'SERVICE_BUSY'});
  assert.equal(f.files.get(join(f.manager.paths.runtime, 'prompt.js')).toString(), 'prompt.js');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, [['print', f.manager.paths.target]]);
});

test('a generation started during runtime copy prevents bootout and is updated after it completes', async () => {
  const f = fixture(); await f.manager.install();
  f.files.set(join(sourceRoot, 'package.json'), Buffer.from('{"type":"module","version":"0.4.2"}'));
  f.calls.length = 0;
  f.setProbes([ready, {...ready, health:{...ready.health, busy:true}}]);
  await assert.rejects(f.manager.install(), {code:'SERVICE_BUSY'});
  assert.equal(f.calls.some(([command]) => command === 'bootout'), false);
  assert.equal(f.modes.get(f.manager.paths.restartPending), 0o600);
  assert.equal(f.files.get(join(f.manager.paths.runtime, 'package.json')).toString().includes('0.4.2'), true);
  f.calls.length = 0;
  f.setProbes([ready, ready, {...ready, health:{...ready.health, version:'0.4.2'}}]);
  const result = await f.manager.install();
  assert.equal(result.updated, true);
  assert.equal(f.calls.filter(([command]) => command === 'bootout').length, 1);
  assert.equal(f.files.has(f.manager.paths.restartPending), false);
});

test('a same-version update postponed by generation is not lost on the next install', async () => {
  const f = fixture(); await f.manager.install();
  f.files.set(join(sourceRoot, 'prompt.js'), Buffer.from('same version changed content'));
  f.calls.length = 0;
  f.setProbes([ready, {...ready, health:{...ready.health, busy:true}}]);
  await assert.rejects(f.manager.install(), {code:'SERVICE_BUSY'});
  assert.equal(f.files.has(f.manager.paths.restartPending), true);
  f.calls.length = 0; f.setProbes([ready]);
  assert.equal((await f.manager.install()).updated, true);
  assert.equal(f.calls.filter(([command]) => command === 'bootout').length, 1);
  assert.equal(f.files.has(f.manager.paths.restartPending), false);
});

test('a registered older service without busy status is never automatically interrupted', async () => {
  const f = fixture(); await f.manager.install();
  f.files.set(join(sourceRoot, 'prompt.js'), Buffer.from('new prompt'));
  f.calls.length = 0;
  const noBusy = {...ready, health:{service:ready.health.service, version:ready.health.version, authenticated:true}};
  f.setProbes([noBusy]);
  await assert.rejects(f.manager.install(), {code:'SERVICE_STATE_UNKNOWN'});
  assert.equal(f.calls.some(([command]) => command === 'bootout'), false);
});

test('an unchanged idempotent install preserves a busy running agent', async () => {
  const f = fixture(); await f.manager.install();
  f.calls.length = 0; f.writes.length = 0;
  f.setProbes([{...ready, health:{...ready.health, busy:true}}]);
  assert.equal((await f.manager.install()).changed, false);
  assert.equal(f.calls.some(([command]) => ['bootout', 'bootstrap', 'kickstart'].includes(command)), false);
  assert.deepEqual(f.writes, []);
});

test('existing correct manual service is recognized without starting a competing process', async () => {
  const f = fixture({probes:[ready]});
  const result = await f.manager.install();
  assert.equal(result.ok, true); assert.equal(result.managed, false); assert.equal(result.installed, true);
  assert.deepEqual(f.calls, [['print', f.manager.paths.target]]);
  assert.match(result.message, /下次登录/);
});

test('an older unmanaged manual service is explicitly reported as not updated', async () => {
  const f = fixture({probes:[{...ready, health:{...ready.health, version:'0.4.0'}}]});
  await assert.rejects(f.manager.install(), error => error.code === 'VERSION_MISMATCH' && error.message.includes('新版 0.4.1 暂未启动'));
  assert.ok(f.files.has(f.manager.paths.plistPath));
  assert.deepEqual(f.calls, [['print', f.manager.paths.target]]);
});

test('a stopped but unchanged registered agent is started without force termination', async () => {
  const f = fixture();
  await f.manager.install();
  f.calls.length = 0; f.setProbes([absent, ready]);
  await f.manager.start();
  assert.deepEqual(f.calls.filter(([command]) => command !== 'print'), [['enable', f.manager.paths.target], ['kickstart', f.manager.paths.target]]);
});

test('an unrelated port listener blocks installation before mutation or launch', async () => {
  const f = fixture({probes:[{state:'occupied'}]});
  await assert.rejects(f.manager.install(), {code:'PORT_IN_USE'});
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, [['print', f.manager.paths.target]]);
});

test('a same-label service from another plist is never stopped or overwritten', async () => {
  const f = fixture({registered:true, owned:false});
  await assert.rejects(f.manager.install(), {code:'LABEL_CONFLICT'});
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, [['print', f.manager.paths.target]]);
});

test('a missing source runtime file fails before writing any installed files', async () => {
  const f = fixture(); f.files.delete(join(sourceRoot, 'extension/media-core.js'));
  await assert.rejects(f.manager.install(), {code:'RUNTIME_MISSING'});
  assert.deepEqual(f.writes, []); assert.deepEqual(f.calls, []);
});

test('source and destination symlinks are refused', async () => {
  const source = fixture(); source.symlinks.add(join(sourceRoot, 'bridge.mjs'));
  await assert.rejects(source.manager.install(), {code:'UNSAFE_FILE'});
  assert.deepEqual(source.writes, []);
  const destination = fixture(); destination.symlinks.add(join(destination.manager.paths.runtime, 'bridge.mjs'));
  await assert.rejects(destination.manager.install(), {code:'UNSAFE_FILE'});
  assert.deepEqual(destination.writes, []);
  const directory = fixture(); directory.symlinks.add(directory.manager.paths.runtime);
  await assert.rejects(directory.manager.install(), {code:'UNSAFE_DIRECTORY'});
});

test('invalid package, relative executable/config paths, and unsupported platforms fail safely', async () => {
  const f = fixture(); f.files.set(join(sourceRoot, 'package.json'), Buffer.from('{}'));
  await assert.rejects(f.manager.install(), {code:'BAD_PACKAGE'});
  const env = fixture({environment:{CODEX_HOME:'relative/path'}});
  await assert.rejects(env.manager.install(), {code:'BAD_PATH'});
  assert.deepEqual(env.writes, []);
  assert.throws(() => createServiceManager({platform:'linux', uid:501}), {code:'MACOS_REQUIRED'});
  assert.throws(() => buildLaunchAgent({runtime:'relative', nodePath:'/node', logDir:'/logs', environment:{}}), {code:'BAD_PATH'});
});

test('missing executable is reported before registration or installation', async () => {
  const f = fixture(); f.fsImpl.access = async () => { throw missing(); };
  await assert.rejects(f.manager.install(), {code:'EXECUTABLE_MISSING'});
  assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
});

test('launchctl permission errors are not mistaken for an unregistered service', async () => {
  const f = fixture({failLaunch:args => args[0] === 'print'});
  await assert.rejects(f.manager.install(), {code:'LAUNCHCTL_STATUS'});
  assert.deepEqual(f.writes, []);
});

test('a bootstrap failure preserves configuration and returns a readable error without low level output', async () => {
  const f = fixture({failLaunch:args => args[0] === 'bootstrap'});
  await assert.rejects(f.manager.install(), error => error.code === 'LAUNCHCTL_START' && !error.message.includes('credential'));
  assert.ok(f.files.has(f.manager.paths.plistPath));
  assert.equal(f.calls.some(args => args[0] === 'kill' || args.includes('-k')), false);
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 1);
  assert.deepEqual(f.waits, []);
});

async function stagedUpdate() {
  const f = fixture();
  await f.manager.install();
  f.files.set(join(sourceRoot, 'prompt.js'), Buffer.from('updated prompt after bootstrap race'));
  f.calls.length = 0; f.waits.length = 0;
  f.setProbes([ready]);
  return f;
}

const transientBootstrapError = () => Object.assign(new Error('raw command environment credential should never leak'), {code:5, stderr:'Bootstrap failed: 5: Input/output error credential should never leak'});

test('a successful bootout permits bounded bootstrap retries while the old label is being released', async () => {
  const f = await stagedUpdate();
  f.setBootstrapFailures([{error:transientBootstrapError()}, {error:transientBootstrapError()}]);
  const result = await f.manager.install();
  assert.equal(result.updated, true);
  assert.deepEqual(f.calls, [
    ['print', f.manager.paths.target], ['enable', f.manager.paths.target], ['bootout', f.manager.paths.target],
    ['print', f.manager.paths.target],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath], ['print', f.manager.paths.target],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath], ['print', f.manager.paths.target],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath],
  ]);
  assert.deepEqual(f.waits, [750, 750]);
  assert.equal(f.files.has(f.manager.paths.restartPending), false);
});

test('bootstrap recovery stops after exactly three attempts and preserves pending update and configuration', async () => {
  const f = await stagedUpdate();
  f.setBootstrapFailures(Array.from({length:4}, () => ({error:transientBootstrapError()})));
  await assert.rejects(f.manager.install(), error => error.code === 'LAUNCHCTL_START' && error.launchctlExitCode === 5 && error.message.includes('退出码 5') && !error.message.includes('credential'));
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 3);
  assert.equal(f.calls.filter(([command]) => command === 'bootout').length, 1);
  assert.equal(f.calls.filter(([command]) => command === 'print').length, 5);
  assert.deepEqual(f.waits, [750, 750]);
  assert.ok(f.files.has(f.manager.paths.restartPending));
  assert.ok(f.files.has(f.manager.paths.plistPath));
  assert.equal(f.calls.some(args => args[0] === 'kill' || args[0] === 'kickstart' || args.includes('-k')), false);
});

test('a bootstrap error that has already registered the owned agent proceeds to expected health without another launch', async () => {
  const f = await stagedUpdate();
  f.setBootstrapFailures([{error:transientBootstrapError(), registered:true, owned:true}]);
  f.setProbes([ready, ready, absent, ready]);
  const result = await f.manager.install();
  assert.equal(result.updated, true);
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 1);
  assert.equal(f.calls.filter(([command]) => command === 'bootout').length, 1);
  assert.deepEqual(f.calls.slice(2, 6), [
    ['bootout', f.manager.paths.target], ['print', f.manager.paths.target],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath], ['print', f.manager.paths.target],
  ], 'absence is observed before interpreting an owned registration as a new bootstrap side effect');
  assert.deepEqual(f.waits, [750]);
  assert.equal(f.files.has(f.manager.paths.restartPending), false);
});

test('old owned registration lingers for two reads after bootout and must disappear before bootstrap', async () => {
  const f = await stagedUpdate();
  f.setReleaseRegistrations([{registered:true, owned:true}, {registered:true, owned:true}, {registered:false}]);
  const result = await f.manager.install();
  assert.equal(result.updated, true);
  assert.deepEqual(f.calls, [
    ['print', f.manager.paths.target], ['enable', f.manager.paths.target], ['bootout', f.manager.paths.target],
    ['print', f.manager.paths.target], ['print', f.manager.paths.target], ['print', f.manager.paths.target],
    ['bootstrap', 'gui/501', f.manager.paths.plistPath],
  ]);
  assert.deepEqual(f.waits, [750, 750]);
  assert.equal(f.calls.filter(([command]) => command === 'bootout').length, 1);
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 1);
  assert.equal(f.files.has(f.manager.paths.restartPending), false);
});

test('old owned registration that never disappears stops after five reads without launching anything new', async () => {
  const f = await stagedUpdate();
  f.setReleaseRegistrations([{registered:true, owned:true}]);
  await assert.rejects(f.manager.install(), error => error.code === 'LAUNCHCTL_RELEASE' && !error.message.includes('credential'));
  assert.equal(f.calls.filter(([command]) => command === 'print').length, 6, 'one initial status plus exactly five release reads');
  assert.deepEqual(f.waits, [750, 750, 750, 750]);
  assert.equal(f.calls.filter(([command]) => command === 'bootout').length, 1);
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 0);
  assert.equal(f.calls.some(args => args[0] === 'kill' || args[0] === 'kickstart' || args.includes('-k')), false);
  assert.ok(f.files.has(f.manager.paths.restartPending));
  assert.ok(f.files.has(f.manager.paths.plistPath));
});

test('a foreign registration appearing during old-service release stops without bootstrapping or removing it', async () => {
  const f = await stagedUpdate();
  f.setReleaseRegistrations([{registered:true, owned:true}, {registered:true, owned:false}]);
  await assert.rejects(f.manager.install(), {code:'LABEL_CONFLICT'});
  assert.deepEqual(f.calls, [
    ['print', f.manager.paths.target], ['enable', f.manager.paths.target], ['bootout', f.manager.paths.target],
    ['print', f.manager.paths.target], ['print', f.manager.paths.target],
  ]);
  assert.deepEqual(f.waits, [750]);
  assert.ok(f.files.has(f.manager.paths.restartPending));
  assert.equal(f.calls.some(args => args[0] === 'kill' || args[0] === 'kickstart' || args.includes('-k')), false);
});

test('a different same-label registration after a bootstrap error stops immediately without another launch', async () => {
  const f = await stagedUpdate();
  f.setBootstrapFailures([{error:transientBootstrapError(), registered:true, owned:false}]);
  await assert.rejects(f.manager.install(), {code:'LABEL_CONFLICT'});
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 1);
  assert.equal(f.calls.filter(([command]) => command === 'bootout').length, 1);
  assert.deepEqual(f.waits, []);
  assert.ok(f.files.has(f.manager.paths.restartPending));
});

test('explicit permission, missing executable, and terminated launchctl errors are not retried even after bootout', async () => {
  for (const fields of [{code:'EACCES'}, {code:'EPERM'}, {code:'ENOENT'}, {killed:true, code:'ETIMEDOUT'}]) {
    const f = await stagedUpdate();
    const failure = Object.assign(new Error('sensitive stderr must never be exposed'), fields);
    f.setBootstrapFailures([{error:failure}]);
    await assert.rejects(f.manager.install(), error => error.code === 'LAUNCHCTL_START' && !error.message.includes('sensitive'));
    assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 1);
    assert.deepEqual(f.waits, []);
    assert.ok(f.files.has(f.manager.paths.restartPending));
  }
});

test('a failed bootout never enters bootstrap recovery or clears its pending update', async () => {
  let rejectBootout = false;
  const f = fixture({failLaunch:args => rejectBootout && args[0] === 'bootout'});
  await f.manager.install();
  f.files.set(join(sourceRoot, 'prompt.js'), Buffer.from('new prompt'));
  f.calls.length = 0; f.waits.length = 0; f.setProbes([ready]); rejectBootout = true;
  await assert.rejects(f.manager.install(), {code:'LAUNCHCTL_UPDATE'});
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 0);
  assert.deepEqual(f.waits, []);
  assert.ok(f.files.has(f.manager.paths.restartPending));
});

test('an owned registration after bootstrap failure still requires the expected service version', async () => {
  for (const [probe, expectedCode] of [
    [{...ready, health:{...ready.health, version:'0.4.0'}}, 'VERSION_MISMATCH'],
  ]) {
    const f = await stagedUpdate();
    f.setBootstrapFailures([{error:transientBootstrapError(), registered:true, owned:true}]);
    f.setProbes([ready, ready, probe]);
    await assert.rejects(f.manager.install(), {code:expectedCode});
    assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 1);
    assert.ok(f.files.has(f.manager.paths.restartPending));
  }
});

test('not-ready outcomes fail, while an unauthenticated running service stays available for model setup', async () => {
  const stopped = fixture({probes:[absent]});
  await assert.rejects(stopped.manager.install(), {code:'START_TIMEOUT'});
  assert.equal(stopped.calls.filter(([command]) => command === 'bootstrap').length, 1);
  const auth = fixture({probes:[absent, {...ready, health:{...ready.health, authenticated:false}}]});
  const result = await auth.manager.install();
  assert.equal(result.ok, true);
  assert.equal(result.running, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.modelReady, false);
  assert.equal(result.needsModelSetup, true);
  assert.match(result.message, /服务已启动，模型尚未就绪/);
  assert.match(result.message, /配置 API 或检查本地 Agent 登录/);
  assert.equal(auth.calls.filter(([command]) => command === 'bootstrap').length, 1);
  assert.equal(auth.calls.some(([command]) => command === 'kickstart'), false);
});

test('a previously running unmanaged service also distinguishes model setup from installation failure', async () => {
  const f = fixture({probes:[{...ready, health:{...ready.health, authenticated:false}}]});
  const result = await f.manager.install();
  assert.equal(result.ok, true);
  assert.equal(result.managed, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.needsModelSetup, true);
  assert.match(result.message, /模型尚未就绪/);
  assert.doesNotMatch(result.message, /回到 X 点击/);
  assert.equal(f.calls.some(([command]) => ['bootout', 'bootstrap', 'kickstart'].includes(command)), false);
});

test('ready models retain an explicit authenticated state and do not request first-time setup', async () => {
  const f = fixture();
  const result = await f.manager.install();
  assert.equal(result.authenticated, true);
  assert.equal(result.modelReady, true);
  assert.equal(result.needsModelSetup, false);
});

test('a still-running older version is not reported as successfully updated', async () => {
  const f = fixture({probes:[absent, {...ready, health:{...ready.health, version:'0.4.0'}}]});
  await assert.rejects(f.manager.install(), {code:'VERSION_MISMATCH'});
  assert.equal(f.calls.filter(([command]) => command === 'bootstrap').length, 1);
  const eventuallyReady = fixture({probes:[absent, {...ready, health:{...ready.health, version:'0.4.0'}}, ready]});
  assert.equal((await eventuallyReady.manager.install()).updated, true);
});

test('atomic write failure removes staging files and does not bootstrap an incomplete runtime', async () => {
  const f = fixture({fsFailure:path => path.includes('prompt.js.tmp-')});
  await assert.rejects(f.manager.install());
  assert.equal([...f.files.keys()].some(path => path.includes('.tmp-')), false);
  assert.equal(f.calls.some(([command]) => command === 'bootstrap'), false);
});

test('status is read only and exposes only safe public service fields', async () => {
  const f = fixture({probes:[{...ready, health:{...ready.health, token:'do not print', paired:true}}], registered:true});
  const result = await f.manager.status();
  assert.equal(result.running, true); assert.equal(result.managed, true);
  assert.equal(JSON.stringify(result).includes('do not print'), false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, [['print', f.manager.paths.target]]);
});

test('public health probe requests only localhost health and filters unexpected response fields', async () => {
  let requested;
  const result = await probeBridge({fetchImpl:async (url, options) => { requested = {url, options}; return new Response(JSON.stringify({...ready.health, token:'not returned'})); }, connectImpl:() => { throw new Error('not needed'); }});
  assert.deepEqual(result, ready);
  assert.equal(requested.url, HEALTH_URL);
  assert.equal(requested.options.redirect, 'error');
  assert.equal(requested.options.credentials, 'omit');
  assert.deepEqual(requested.options.headers, {Accept:'application/json'});
});

test('public health probe retains only a boolean busy indicator', async () => {
  for (const busy of [true, false, 'task id secret']) {
    const result = await probeBridge({fetchImpl:async () => new Response(JSON.stringify({...ready.health, busy}))});
    if (typeof busy === 'boolean') assert.equal(result.health.busy, busy);
    else assert.equal('busy' in result.health, false);
  }
});

test('unexpected, oversized, or failed HTTP responses are occupied listeners', async () => {
  for (const response of [new Response('{"service":"unrelated","authenticated":true,"version":"1.0.0"}'), new Response('x'.repeat(9000)), new Response('error', {status:503})]) {
    assert.deepEqual(await probeBridge({fetchImpl:async () => response}), {state:'occupied'});
  }
});

test('HTTP connection failure probes the fixed TCP listener; only ECONNREFUSED means stopped', async () => {
  for (const [code, expected] of [['ECONNREFUSED', 'stopped'], ['EACCES', 'occupied'], [null, 'occupied']]) {
    let settings;
    const result = await probeBridge({fetchImpl:async () => { throw new Error('offline'); }, connectImpl:options => {
      settings = options;
      const socket = new EventEmitter(); socket.destroy = () => {}; socket.setTimeout = () => {};
      queueMicrotask(() => code ? socket.emit('error', Object.assign(new Error('socket'), {code})) : socket.emit('connect'));
      return socket;
    }});
    assert.deepEqual(settings, {host:'127.0.0.1', port:8769});
    assert.deepEqual(result, {state:expected});
  }
});

test('command output gives a close-window success instruction or a safe actionable failure', async () => {
  const output = []; const errors = [];
  assert.equal(await runServiceCommand(['install'], {manager:{install:async () => ({ok:true, version:'0.4.1'})}, write:text => output.push(text), error:text => errors.push(text)}), 0);
  assert.match(output[0], /可以关闭这个窗口/);
  assert.equal(await runServiceCommand(['install'], {manager:{install:async () => { throw new ServiceError('PORT_IN_USE', '端口占用。'); }}, write:text => output.push(text), error:text => errors.push(text)}), 1);
  assert.equal(errors[0], '端口占用。 [PORT_IN_USE]');
  assert.equal(await runServiceCommand(['install'], {manager:{install:async () => { throw new Error('auth secret internal path'); }}, error:text => errors.push(text)}), 1);
  assert.equal(errors.at(-1).includes('secret'), false);
  assert.equal(await runServiceCommand(['kill'], {manager:{}, error:text => errors.push(text)}), 1);
});

test('encrypted v3 metadata permits startup and update without reading OS credentials or copying private state',async()=>{
 const f=fixture();const statePath=join(home,'Library','Application Support','Jieyiju','writer-settings-state.json');
 const ciphertext=Buffer.alloc(40,17).toString('base64');
 f.files.set(statePath,Buffer.from(JSON.stringify({version:3,provider:'deepseek',profiles:{deepseek:{model:'deepseek-flash',baseUrl:'https://api.deepseek.com',credential:{backend:'windows-dpapi',ciphertext}}}})));
 const checked=[];f.fsImpl.access=async path=>{checked.push(path);if(path!=='/opt/homebrew/bin/node')throw missing();};
 const read=f.fsImpl.readFile;f.fsImpl.readFile=async path=>{assert.notEqual(path,deepSeekKey);return read(path);};
 assert.equal((await f.manager.install()).managed,true);assert.deepEqual(checked,['/opt/homebrew/bin/node']);
 assert.equal(f.files.has(join(f.manager.paths.runtime,'writer-settings-state.json')),false);
 assert.equal(f.files.get(statePath).toString().includes(ciphertext),true);
 assert.equal(f.files.get(f.manager.paths.plistPath).toString().includes(ciphertext),false);
 assert.equal(f.files.has(join(f.manager.paths.runtime,'credential-store.mjs')),true);
});
