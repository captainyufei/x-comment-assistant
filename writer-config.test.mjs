import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadWriterConfig} from './writer-config.mjs';

const fixtureKey='fixture-deepseek-secret';
async function fixture(t,config){
  const appDir=await mkdtemp(join(tmpdir(),'jieyiju-writer-config-'));
  t.after(()=>rm(appDir,{recursive:true,force:true}));
  if(config)await writeFile(join(appDir,'writer-config.json'),JSON.stringify(config),{mode:0o600});
  return appDir;
}
test('no config preserves Codex even when a DeepSeek environment key exists',async t=>{
  const appDir=await fixture(t);
  assert.deepEqual(await loadWriterConfig({appDir,env:{DEEPSEEK_API_KEY:fixtureKey}}),{provider:'codex'});
});
test('explicit DeepSeek config reads private key and current model without leaking to config',async t=>{
  const appDir=await fixture(t,{version:1,provider:'deepseek',model:'deepseek-flash'});
  await writeFile(join(appDir,'deepseek-api-key'),fixtureKey+'\n',{mode:0o600});
  assert.deepEqual(await loadWriterConfig({appDir,env:{}}),{provider:'deepseek',model:'deepseek-flash',baseUrl:'https://api.deepseek.com',apiKey:fixtureKey});
});
test('environment key is accepted only for explicitly configured DeepSeek',async t=>{
  const appDir=await fixture(t,{version:1,provider:'deepseek'});
  assert.equal((await loadWriterConfig({appDir,env:{DEEPSEEK_API_KEY:fixtureKey}})).model,'deepseek-flash');
  await assert.rejects(loadWriterConfig({appDir,env:{}}),e=>e.code==='DEEPSEEK_KEY_REQUIRED'&&!e.message.includes(fixtureKey));
});
test('unknown config, unapproved model or embedded key is rejected without echo',async t=>{
  const appDir=await fixture(t);
  for(const config of [{version:1,provider:'other'},{version:1,provider:'deepseek',model:'http://untrusted'},
    {version:1,provider:'deepseek',apiKey:fixtureKey},{version:1,provider:'codex',model:'another'}]){
    await writeFile(join(appDir,'writer-config.json'),JSON.stringify(config),{mode:0o600});
    await assert.rejects(loadWriterConfig({appDir,env:{}}),e=>e.code==='WRITER_CONFIG'&&!e.message.includes(fixtureKey));
  }
});
test('unsafe key permissions and symbolic links fail closed without environment fallback',async t=>{
  const appDir=await fixture(t,{version:1,provider:'deepseek'});
  const keyPath=join(appDir,'deepseek-api-key');
  await writeFile(keyPath,fixtureKey,{mode:0o600});
  await chmod(keyPath,0o644);
  await assert.rejects(loadWriterConfig({appDir,env:{DEEPSEEK_API_KEY:fixtureKey}}),e=>e.code==='WRITER_CONFIG');
  await rm(keyPath);
  await symlink(join(appDir,'writer-config.json'),keyPath);
  await assert.rejects(loadWriterConfig({appDir,env:{DEEPSEEK_API_KEY:fixtureKey}}),e=>e.code==='WRITER_CONFIG');
});
test('explicit Codex rollback does not read the DeepSeek key',async t=>{
  const appDir=await fixture(t,{version:1,provider:'codex'});
  await writeFile(join(appDir,'deepseek-api-key'),fixtureKey,{mode:0o644});
  assert.deepEqual(await loadWriterConfig({appDir,env:{}}),{provider:'codex'});
});
