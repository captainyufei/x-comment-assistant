import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_CONFIG_BYTES = 1024;

export class ExtensionConfigurationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function error(code, message) { return new ExtensionConfigurationError(code, message); }

async function existingConfiguration(path, fsImpl) {
  let handle;
  try {
    const metadata = await fsImpl.lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw error('UNSAFE_TRUST_FILE', '扩展身份配置不是普通文件，已停止写入。');
    handle = await fsImpl.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw error('INVALID_TRUST_FILE', '已有扩展身份配置无效；请检查文件后重试。');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_CONFIG_BYTES) throw error('INVALID_TRUST_FILE', '已有扩展身份配置无效；请检查文件后重试。');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw error('INVALID_TRUST_FILE', '已有扩展身份配置无效；请检查文件后重试。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
        typeof value.extensionId !== 'string' || !/^[a-p]{32}$/u.test(value.extensionId)) {
      throw error('INVALID_TRUST_FILE', '已有扩展身份配置无效；请检查文件后重试。');
    }
    return {extensionId:value.extensionId, bytes};
  } catch (failure) {
    if (failure.code === 'ENOENT') return null;
    if (failure instanceof ExtensionConfigurationError) throw failure;
    throw error('TRUST_FILE_UNREADABLE', '无法安全读取扩展身份配置，请检查文件权限。');
  } finally { await handle?.close(); }
}

/** Explicit local setup only: no API keys, browser calls or trust-on-first-use. */
export async function configureExtension({extensionId, replace = false, sourceRoot = ROOT, fsImpl = fs} = {}) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId)) {
    throw error('INVALID_EXTENSION_ID', '扩展 ID 必须是扩展管理页显示的 32 位小写 a–p 字符。');
  }
  if (typeof replace !== 'boolean') throw error('INVALID_REPLACE', '替换选项无效。');
  if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot) || /[\x00-\x1f\x7f]/u.test(sourceRoot)) {
    throw error('INVALID_SOURCE_ROOT', '项目目录必须是有效的绝对路径。');
  }
  let directory;
  try { directory = await fsImpl.lstat(sourceRoot); }
  catch { throw error('SOURCE_ROOT_UNAVAILABLE', '无法读取项目目录，请检查文件夹权限。'); }
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw error('UNSAFE_SOURCE_ROOT', '项目目录不是普通文件夹，已停止写入。');
  const path = join(sourceRoot, 'extension-trust.json');
  const previous = await existingConfiguration(path, fsImpl);
  if (previous?.extensionId === extensionId) return {ok:true, changed:false, extensionId, path};
  if (previous && !replace) {
    throw error('EXTENSION_ID_EXISTS', '已有不同的扩展 ID，未覆盖。确认更换后请显式加上 --replace。');
  }
  const staging = join(sourceRoot, `.extension-trust-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify({extensionId}, null, 2)}\n`);
  let handle;
  try {
    handle = await fsImpl.open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    if (!previous) {
      // Publish a fully written inode without overwriting a concurrently
      // created config. Both paths live in the same project filesystem.
      try { await fsImpl.link(staging, path); }
      catch (failure) {
        if (failure.code === 'EEXIST') throw error('TRUST_FILE_CHANGED', '扩展身份配置刚被其他操作创建，未覆盖；请重新检查后执行。');
        throw failure;
      }
    } else {
      const current = await existingConfiguration(path, fsImpl);
      if (!current || !current.bytes.equals(previous.bytes)) throw error('TRUST_FILE_CHANGED', '扩展身份配置刚被其他操作修改，未覆盖；请重新检查后执行。');
      await fsImpl.rename(staging, path);
    }
    return {ok:true, changed:true, extensionId, path};
  } catch (failure) {
    if (failure instanceof ExtensionConfigurationError) throw failure;
    throw error('TRUST_FILE_WRITE_FAILED', '扩展身份配置未保存，请检查项目文件夹权限后重试。');
  } finally {
    await handle?.close();
    await fsImpl.rm(staging, {force:true}).catch(() => {});
  }
}

const USAGE = '用法：node configure-extension.mjs --extension-id <32位扩展ID> [--replace]\n请在浏览器扩展管理页复制实际 ID。此命令只保存本机公开扩展身份，不读取或保存 API Key，也不启动服务。';

export async function runConfigurationCommand(args, {configure = configureExtension, write = text => console.log(text), error:writeError = text => console.error(text)} = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { write(USAGE); return 0; }
  let extensionId, replace = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--extension-id' && extensionId === undefined && index + 1 < args.length) extensionId = args[++index];
    else if (args[index] === '--replace' && !replace) replace = true;
    else { writeError(USAGE); return 1; }
  }
  if (extensionId === undefined) { writeError(USAGE); return 1; }
  try {
    const result = await configure({extensionId, replace});
    write(`扩展身份${result.changed ? '已保存' : '已配置，无需更改'}：${result.extensionId}\n${result.path}\n下一步按安装文档启动本机服务；本命令不会自动安装或重启服务。`);
    return 0;
  } catch (failure) {
    writeError(failure instanceof ExtensionConfigurationError ? `${failure.message} [${failure.code}]` : '扩展身份配置失败，请检查文件夹权限后重试。 [CONFIGURATION_FAILED]');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runConfigurationCommand(process.argv.slice(2));
}
