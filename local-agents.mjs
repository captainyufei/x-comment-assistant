import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {homedir} from 'node:os';

const CATALOG = Object.freeze([
  Object.freeze({id: 'codex', label: 'Codex', supported: true}),
  Object.freeze({id: 'claude', label: 'Claude Code', supported: true}),
  Object.freeze({id: 'gemini', label: 'Gemini CLI', supported: false}),
]);

// Discovery only checks known executable names. It never executes a shell,
// starts an agent, installs software, reads credentials, or changes CLI settings.
export async function resolveAgentPath(id, {env = process.env} = {}) {
  if (!CATALOG.some(agent => agent.id === id)) return null;
  const userHome = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : homedir();
  const explicit = env[`JIEYIJU_${id.toUpperCase()}_PATH`];
  if (explicit !== undefined && (typeof explicit !== 'string' || !isAbsolute(explicit))) return null;
  const directories = [
    ...(typeof env.PATH === 'string' ? env.PATH.split(':').filter(isAbsolute) : []),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    join(userHome, '.local', 'bin'), join(userHome, '.npm-global', 'bin'),
  ];
  const candidates = explicit ? [explicit] : [...new Set(directories)].map(directory => join(directory, id));
  for (const candidate of candidates) {
    // A relative PATH entry or the working checkout must never shadow an agent.
    if (!isAbsolute(candidate) || resolve(candidate).startsWith(`${resolve(process.cwd())}/`)) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next known installation directory. */ }
  }
  return null;
}

export async function discoverLocalAgents({env = process.env} = {}) {
  return Promise.all(CATALOG.map(async agent => {
    const path = await resolveAgentPath(agent.id, {env});
    return {...agent, installed: Boolean(path), ...(path ? {path} : {})};
  }));
}
