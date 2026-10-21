import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, delimiter} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseWriterSettings, parseEncryptedWriterState, WRITER_STATE_FILE, publicSelectionFromPrivateWriterState,MAX_WRITER_CONFIG_BYTES} from './writer-config.mjs';

export const SERVICE_LABEL = 'com.yufei.jieyiju.bridge';
export const HEALTH_URL = 'http://127.0.0.1:8769/health';
export const RUNTIME_FILES = Object.freeze([
  'bridge.mjs', 'prompt.js', 'reply-expertise.js', 'reply-styles.mjs', 'media.js', 'codex-events.mjs', 'connect.js', 'preview-adapter.js',
  'deepseek-runner.mjs', 'api-protocol.mjs','agent-runner.mjs','local-agents.mjs','writer-config.mjs', 'writer-settings.mjs', 'credential-store.mjs', 'model-discovery.mjs', 'popup-preview-adapter.js',
  'extension-trust.json', 'package.json', 'extension/media-core.js','extension/provider-catalog.js', 'extension/reply-style-catalog.js',
  'extension/panel.html', 'extension/panel.js', 'extension/panel.css',
  'extension/popup.html', 'extension/popup.js', 'extension/popup.css',
  'extension/help.html', 'extension/help.css',
  'extension/shared/prompt.js', 'extension/shared/reply-expertise.js', 'extension/shared/reply-styles.mjs',
  'extension/shared/api-protocol.mjs', 'extension/shared/model-discovery.mjs',
  'extension/icons/icon-16.png', 'extension/icons/icon-32.png',
  'extension/icons/icon-48.png', 'extension/icons/icon-128.png',
  'review-store.mjs', 'review.html', 'review.js', 'review.css', 'review-data.json',
]);
const ROOT = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ServiceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new ServiceError('BAD_PATH', `${name}必须是有效的绝对路径。`);
  }
  return value;
}

function xml(value) {
  return String(value).replace(/[&<>"']/gu, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[character]));
}

export function buildLaunchAgent({runtime, nodePath, environment, logDir}) {
  absolutePath(runtime, '运行目录');
  absolutePath(nodePath, 'Node 路径');
  absolutePath(logDir, '日志目录');
  const entries = Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(join(runtime, 'bridge.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(runtime)}</string>
  <key>EnvironmentVariables</key><dict>
${entries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'bridge.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'bridge.error.log'))}</string>
</dict></plist>
`;
}

async function tcpListening(connectImpl) {
  return new Promise(resolve => {
    const socket = connectImpl({host:'127.0.0.1', port:8769});
    let settled = false;
    const finish = result => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.once('connect', () => finish(true));
    // A timed out or inaccessible listener is not safe to treat as an unused port.
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(700, () => finish(true));
  });
}

export async function probeBridge({fetchImpl = fetch, connectImpl = createConnection} = {}) {
  try {
    const response = await fetchImpl(HEALTH_URL, {
      method:'GET', redirect:'error', credentials:'omit', cache:'no-store',
      headers:{Accept:'application/json'}, signal:AbortSignal.timeout(1500),
    });
    if (!response.ok) return {state:'occupied'};
    const reader = response.body?.getReader();
    if (!reader) return {state:'occupied'};
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 8192) { await reader.cancel(); return {state:'occupied'}; }
        chunks.push(Buffer.from(result.value));
      }
    } finally { reader.releaseLock(); }
    const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (health?.service !== 'yufei-x-reply-codex' || typeof health.authenticated !== 'boolean' ||
        typeof health.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(health.version)) return {state:'occupied'};
    // Only public status is returned. No other fields from an unknown HTTP response survive.
    return {state:'running', health:{service:health.service, version:health.version, authenticated:health.authenticated,
      ...(typeof health.busy === 'boolean' ? {busy:health.busy} : {})}};
  } catch {
    return {state:await tcpListening(connectImpl) ? 'occupied' : 'stopped'};
  }
}

export function createServiceManager({
  sourceRoot = ROOT, home = homedir(), uid = process.getuid?.(), platform = process.platform,
  nodePath, codexPath, environment = process.env, fsImpl = fs,
  launchctlImpl = args => execFileAsync('/bin/launchctl', args, {timeout:10000, maxBuffer:64000}),
  probeImpl = () => probeBridge(), sleepImpl = sleep, readinessAttempts = 45,
} = {}) {
  const root = absolutePath(sourceRoot, '源目录');
  absolutePath(home, '用户目录');
  if (platform !== 'darwin' || !Number.isSafeInteger(uid) || uid < 0) throw new ServiceError('MACOS_REQUIRED', '持久启动需要当前 macOS 用户的登录会话。');
  const domain = `gui/${uid}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const launchAgents = join(home, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgents, `${SERVICE_LABEL}.plist`);
  const appDir = join(home, 'Library', 'Application Support', 'Jieyiju');
  const runtime = join(appDir, 'runtime');
  const logDir = join(home, 'Library', 'Logs', 'Jieyiju');
  const restartPending = join(appDir, 'restart-pending.json');

  async function optionalStat(path) {
    try { return await fsImpl.lstat(path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function regularFile(path) {
    const stat = await optionalStat(path);
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new ServiceError('UNSAFE_FILE', '本机服务文件存在链接或类型异常，请检查安装目录。');
    return stat;
  }

  async function directory(path, mode) {
    const stat = await optionalStat(path);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new ServiceError('UNSAFE_DIRECTORY', '本机服务目录存在链接或类型异常，请检查安装目录。');
    await fsImpl.mkdir(path, {recursive:true, ...(mode ? {mode} : {})});
    if (mode) await fsImpl.chmod(path, mode);
  }

  async function executable(explicit, choices, name) {
    const paths = explicit ? [absolutePath(explicit, `${name} 路径`)] : choices;
    for (const path of paths) {
      try { await fsImpl.access(path, constants.X_OK); return path; }
      catch { /* Try only known stable executable paths, not shell evaluation. */ }
    }
    throw new ServiceError('EXECUTABLE_MISSING', `没有找到可执行的 ${name}。请先完成安装，再打开启动文件。`);
  }

  async function registration() {
    try {
      const result = await launchctlImpl(['print', target]);
      const found = /(?:^|\n)\s*path = (.+)\r?$/mu.exec(result.stdout || '')?.[1]?.trim().replace(/^"|"$/gu, '');
      return {registered:true, owned:found === plistPath};
    } catch (error) {
      if (/Could not find service|No such process/iu.test(`${error.stdout || ''}\n${error.stderr || ''}`)) return {registered:false, owned:false};
      throw new ServiceError('LAUNCHCTL_STATUS', '无法读取 macOS 登录服务状态。请在当前用户的图形登录会话中重试。');
    }
  }

  async function launch(args, code, message) {
    try { return await launchctlImpl(args); }
    catch { throw new ServiceError(code, message); }
  }

  function bootstrapFailure(failure) {
    // Keep only a bounded numeric exit status for diagnosis. Child-process
    // errors can contain commands, environment values and raw stderr.
    const exitCode = Number.isInteger(failure?.code) && failure.code >= 0 && failure.code <= 255 ? failure.code : null;
    const error = new ServiceError('LAUNCHCTL_START', `macOS 未能载入登录服务。配置已保存，请检查当前用户登录会话后重试。${exitCode === null ? '' : `（launchctl 退出码 ${exitCode}）`}`);
    if (exitCode !== null) error.launchctlExitCode = exitCode;
    return error;
  }

  async function waitForBootoutRelease() {
    // bootout can acknowledge removal before print stops showing the old job.
    // The identical plist path is not proof that a later bootstrap took effect.
    // Establish absence first, without another removal or forced termination.
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await registration();
      if (!current.registered) return;
      if (!current.owned) throw new ServiceError('LABEL_CONFLICT', '同名 macOS 服务已来自其他配置，已停止更新，未关闭任何进程。');
      if (attempt < 4) await sleepImpl(750);
    }
    throw new ServiceError('LAUNCHCTL_RELEASE', 'macOS 尚未完成旧服务卸载，暂未启动新版。配置和待更新标记已保留，请稍后重新打开启动文件。');
  }

  async function bootstrapAfterBootout() {
    await waitForBootoutRelease();
    // Only a successfully removed, observably absent owned agent reaches here.
    // A failed bootstrap can leave no registration while launchd releases the
    // old label, or it can have installed the new registration despite an error.
    // Check state before a bounded retry; never remove or force-start anything.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await launchctlImpl(['bootstrap', domain, plistPath]);
        return;
      } catch (failure) {
        const current = await registration();
        if (current.registered) {
          if (!current.owned) throw new ServiceError('LABEL_CONFLICT', '同名 macOS 服务已来自其他配置，已停止恢复，未关闭任何进程。');
          // Installation still requires expected-version service health below;
          // model authentication remains a separate reported setup state.
          return;
        }
        if (['EACCES', 'EPERM', 'ENOENT'].includes(failure?.code) || failure?.killed === true || attempt === 2) {
          throw bootstrapFailure(failure);
        }
        await sleepImpl(750);
      }
    }
  }

  async function plan() {
    const selectedNode = await executable(nodePath, ['/opt/homebrew/bin/node', '/usr/local/bin/node'], 'Node.js 20+');
    // Select only the public writer settings. Credentials remain outside the
    // runtime copy and are read exclusively by the selected writer on startup.
    let writerSettings = {provider:'codex'};
    const privateWriterState = join(appDir, WRITER_STATE_FILE);
    const writerConfig = await regularFile(privateWriterState) ? privateWriterState : join(appDir, 'writer-config.json');
    if (await regularFile(writerConfig)) {
      try {
        const raw = Buffer.from(await fsImpl.readFile(writerConfig));
        if (raw.length > MAX_WRITER_CONFIG_BYTES) throw new Error('configuration too large');
        const parsed=JSON.parse(raw.toString('utf8'));
        writerSettings = writerConfig === privateWriterState
          ? parsed.version===3?{provider:parseEncryptedWriterState(parsed).provider}:publicSelectionFromPrivateWriterState(parsed)
          : parseWriterSettings(parsed);
      } catch {
        throw new ServiceError('WRITER_CONFIG', '本机模型配置格式无效或无法读取，请检查私有模型设置文件。');
      }
    }
    let selectedCodex=null;
    if(writerSettings.provider==='codex'){
      try{selectedCodex=await executable(codexPath, ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'], 'Codex CLI');}
      catch(error){if(error.code!=='EXECUTABLE_MISSING')throw error;}
    }
    const contents = [];
    for (const file of RUNTIME_FILES) {
      const path = join(root, file);
      if (!await regularFile(path)) throw new ServiceError('RUNTIME_MISSING', `安装文件缺失：${file}。请使用完整的插件文件夹。`);
      contents.push([file, await fsImpl.readFile(path)]);
    }
    let version;
    try { version = JSON.parse(contents.find(([file]) => file === 'package.json')[1]).version; }
    catch { throw new ServiceError('BAD_PACKAGE', '安装文件 package.json 无效。'); }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw new ServiceError('BAD_PACKAGE', '安装版本无效。');
    const env = {
      HOME:home,
      PATH:[dirname(selectedNode), ...(selectedCodex ? [dirname(selectedCodex)] : []), join(home,'.local','bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((path, index, array) => array.indexOf(path) === index).join(delimiter),
      ...(selectedCodex ? {JIEYIJU_CODEX_PATH:selectedCodex} : {}),
      LANG:'zh_CN.UTF-8',
    };
    if (selectedCodex && environment.CODEX_HOME) env.CODEX_HOME = absolutePath(environment.CODEX_HOME, 'Codex 配置目录');
    // API keys, proxy credentials, app tool pipes and arbitrary parent variables are never persisted.
    return {contents, version, plist:buildLaunchAgent({runtime, nodePath:selectedNode, environment:env, logDir})};
  }

  async function writeChanged(path, content) {
    const data = Buffer.from(content);
    const stat = await regularFile(path);
    if (stat && Buffer.from(await fsImpl.readFile(path)).equals(data)) {
      await fsImpl.chmod(path, 0o600);
      return false;
    }
    const staging = `${path}.tmp-${randomUUID()}`;
    try {
      await fsImpl.writeFile(staging, data, {mode:0o600, flag:'wx'});
      await fsImpl.rename(staging, path);
      return true;
    } finally { await fsImpl.rm(staging, {force:true}); }
  }

  async function installFiles(installation) {
    await directory(appDir, 0o700);
    await directory(runtime, 0o700);
    await directory(join(runtime, 'extension'), 0o700);
    await directory(join(runtime, 'extension', 'icons'), 0o700);
    await directory(launchAgents);
    await directory(logDir, 0o700);
    let changed = false;
    for (const [file, contents] of installation.contents) changed = await writeChanged(join(runtime, file), contents) || changed;
    changed = await writeChanged(plistPath, installation.plist) || changed;
    for (const name of ['bridge.log', 'bridge.error.log']) {
      const path = join(logDir, name);
      if (!await regularFile(path)) await fsImpl.writeFile(path, '', {mode:0o600, flag:'wx'});
      else await fsImpl.chmod(path, 0o600);
    }
    return changed;
  }

  async function needsUpdate(installation) {
    for (const [file, content] of [...installation.contents.map(([name, data]) => [join(runtime, name), data]), [plistPath, installation.plist]]) {
      if (!await regularFile(file) || !Buffer.from(await fsImpl.readFile(file)).equals(Buffer.from(content))) return true;
    }
    return false;
  }

  function readyResult(probe, extra = {}) {
    if (typeof probe.health?.authenticated !== 'boolean') throw new ServiceError('SERVICE_STATE_UNKNOWN', '本机服务未提供有效的模型状态，请检查服务日志后重试。');
    const modelReady = probe.health.authenticated;
    // Installing the bridge and authenticating a model are separate steps. The
    // running settings endpoint is needed to configure a fresh installation.
    // Keep the failed/not-yet-ready model status visible; generation still has
    // its own authentication checks and is never authorized by this result.
    return {ok:true, running:true, version:probe.health.version, ...extra,
      authenticated:modelReady, modelReady, needsModelSetup:!modelReady,
      ...(!modelReady ? {message:'本机服务已启动，模型尚未就绪。请在插件模型设置配置 API 或检查本地 Agent 登录。以后登录会自动启动，已有配置会保留。'} : {})};
  }

  async function waitReady(expectedVersion) {
    let oldVersion = null;
    for (let attempt = 0; attempt < readinessAttempts; attempt++) {
      const probe = await probeImpl();
      if (probe.state === 'running') {
        if (probe.health.version === expectedVersion) return readyResult(probe, {managed:true, expectedVersion, updated:true});
        oldVersion = probe.health.version;
      }
      // A listener can be our process finishing initialization; never kill or replace it.
      if (attempt + 1 < readinessAttempts) await sleepImpl(750);
    }
    if (oldVersion) throw new ServiceError('VERSION_MISMATCH', `当前运行的服务仍是 ${oldVersion}，需要的版本是 ${expectedVersion}。新版尚未完成启动，请检查服务日志后重试。`);
    throw new ServiceError('START_TIMEOUT', `本机 AI 服务尚未就绪。登录启动已保留，请检查当前模型的认证配置和 ${logDir} 中的服务日志后重试。`);
  }

  async function install() {
    const installation = await plan();
    const registered = await registration();
    if (registered.registered && !registered.owned) throw new ServiceError('LABEL_CONFLICT', '同名 macOS 服务来自其他配置，已停止安装，未关闭任何进程。');
    const before = await probeImpl();
    if (before.state === 'occupied') throw new ServiceError('PORT_IN_USE', '8769 端口已被其他服务占用，未关闭任何进程。请先处理端口占用后重试。');
    const pendingUpdate = await needsUpdate(installation);
    const pendingRestart = Boolean(await regularFile(restartPending));
    const outdated = before.state === 'running' && before.health.version !== installation.version;
    const reload = registered.registered && (pendingUpdate || pendingRestart || outdated);
    if (before.state === 'running' && before.health.busy && (pendingUpdate || reload)) {
      throw new ServiceError('SERVICE_BUSY', '当前正在生成回复，已保留本次任务。请等生成完成后再更新本机服务。');
    }
    if (reload) {
      // Remember unfinished updates, including same-version changes and partial file-copy failures.
      // This file contains only the expected version; it never stores jobs, content or credentials.
      await directory(appDir, 0o700);
      await writeChanged(restartPending, JSON.stringify({version:installation.version}));
    }
    const changed = await installFiles(installation);
    if (before.state === 'running' && !registered.registered) {
      if (outdated) throw new ServiceError('VERSION_MISMATCH', `当前仍是手动启动的 ${before.health.version}，新版 ${installation.version} 暂未启动。登录配置已安装，原进程保持运行；请在生成完成后退出旧服务，再打开启动文件。`);
      return readyResult(before, {managed:false, installed:true, expectedVersion:installation.version, updated:before.health.version === installation.version,
        message:'当前已运行正确的本机服务。登录启动配置已安装；当前手动进程保持运行，下次登录由 macOS 接管。'});
    }
    await launch(['enable', target], 'LAUNCHCTL_ENABLE', 'macOS 未能启用登录服务，请在当前图形登录会话中重试。');
    if (reload) {
      // A user may have started generation while files were copied. Check again before stopping this agent.
      const latest = await probeImpl();
      if (latest.state === 'occupied') throw new ServiceError('PORT_IN_USE', '8769 端口当前被其他服务占用，未关闭任何进程。');
      if (latest.state === 'running' && latest.health.busy) throw new ServiceError('SERVICE_BUSY', '当前刚开始生成回复，已保留本次任务。新版文件已保存，请等生成完成后再打开启动文件。');
      if (latest.state === 'running' && typeof latest.health.busy !== 'boolean') throw new ServiceError('SERVICE_STATE_UNKNOWN', '当前旧服务未提供生成状态，暂未重启。请在生成完成后退出旧服务，再打开启动文件。');
      await launch(['bootout', target], 'LAUNCHCTL_UPDATE', 'macOS 未能更新本服务。原配置已保留，请重新打开启动文件。');
    }
    if (reload) {
      await bootstrapAfterBootout();
    } else if (!registered.registered) {
      await launch(['bootstrap', domain, plistPath], 'LAUNCHCTL_START', 'macOS 未能载入登录服务。配置已保存，请检查当前用户登录会话后重试。');
    } else if (before.state !== 'running') {
      // No -k: an already running managed process is never forcibly terminated.
      await launch(['kickstart', target], 'LAUNCHCTL_START', 'macOS 未能启动本服务，请检查服务日志后重试。');
    }
    const result = await waitReady(installation.version);
    await fsImpl.rm(restartPending, {force:true});
    return {...result, installed:true, changed};
  }

  async function start() {
    // Installation also synchronizes explicitly allowed runtime files and is idempotent.
    return install();
  }

  async function status() {
    const registered = await registration();
    const probe = await probeImpl();
    return {ok:probe.state === 'running' && probe.health.authenticated, running:probe.state === 'running',
      state:probe.state, registered:registered.registered, managed:registered.registered && registered.owned,
      ...(probe.state === 'running' ? {version:probe.health.version, authenticated:probe.health.authenticated,
        ...(typeof probe.health.busy === 'boolean' ? {busy:probe.health.busy} : {})} : {}),
      plistPath, logDir};
  }

  return {install, start, status, paths:{root, runtime, plistPath, logDir, target, restartPending}};
}

export async function runServiceCommand(args, {manager = createServiceManager(), write = text => console.log(text), error = text => console.error(text)} = {}) {
  const command = args[0] || 'install';
  if (args.length > 1 || !['install', 'start', 'status'].includes(command)) {
    error('用法：node service-manager.mjs install | start | status');
    return 1;
  }
  try {
    const result = await manager[command]();
    if (command === 'status') {
      write(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    write(result.message || `本机 AI 服务已就绪（${result.version}）。以后登录会自动启动，异常退出会自动恢复。\n可以关闭这个窗口，回到 X 点击“生成回复”。`);
    return 0;
  } catch (failure) {
    error(failure instanceof ServiceError ? `${failure.message} [${failure.code}]` : '本机服务安装失败，请检查文件夹权限后重试。 [INSTALL_FAILED]');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runServiceCommand(process.argv.slice(2)); }
  catch (failure) { console.error(failure instanceof ServiceError ? failure.message : '无法启动服务管理器。'); process.exitCode = 1; }
}
