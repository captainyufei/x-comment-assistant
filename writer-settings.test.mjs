import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,chmod,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWriterSettingsController,savePrivateWriterState} from './writer-settings.mjs';
import {fakeCredentialStore} from './credential-store.test-helper.mjs';
import {CredentialStoreError} from './credential-store.mjs';
import {loadWriterConfig,WRITER_STATE_FILE} from './writer-config.mjs';

const OLD_KEY='fixture-old-deepseek-private';
const NEW_KEY='fixture-new-deepseek-private';
function runner(config={provider:'deepseek',model:'deepseek-flash'}){
  return {health:{writerProvider:config.provider,writerModel:config.model??'gpt-6.1-sol'},async initialize(){return this.health;}};
}
async function setup(t,options={}){
  const appDir=await mkdtemp(join(tmpdir(),'x-reply-settings-'));
  t.after(()=>rm(appDir,{recursive:true,force:true}));
  await writeFile(join(appDir,'writer-config.json'),JSON.stringify({version:1,provider:'deepseek',model:'deepseek-flash'}),{mode:0o600});
  await writeFile(join(appDir,'deepseek-api-key'),OLD_KEY,{mode:0o600});
  const staged=[],credentialStore=fakeCredentialStore();
  const controller=await createWriterSettingsController({appDir,env:{},initialRunner:runner(),
    credentialStore,discoverAgents:async()=>[],createRunner:async config=>{staged.push(config);return runner(config);},...options});
  return {appDir,controller,staged,credentialStore};
}
test('reading settings reports only public fields and does not create or migrate files',async t=>{
  const f=await setup(t);
  const before=await readdir(f.appDir);
  assert.deepEqual(await f.controller.read(),{provider:'deepseek',model:'deepseek-flash',baseUrl:'https://api.deepseek.com',keyConfigured:true,
    allowedModels:['deepseek-flash','deepseek-v4-pro'],checkScope:'local',
    profiles:{deepseek:{model:'deepseek-flash',baseUrl:'https://api.deepseek.com',keyConfigured:true}},agents:[],credentialStorage:{backend:'legacy-plaintext',encrypted:false,legacy:true}});
  assert.deepEqual(await readdir(f.appDir),before);
  assert.equal(f.staged.length,0);
  assert.ok(!JSON.stringify(await f.controller.read()).includes(OLD_KEY));
});
test('saving stages one local initialization then atomically persists selected model and key privately',async t=>{
  const f=await setup(t);
  const result=await f.controller.write({provider:'deepseek',model:'deepseek-v4-pro',apiKey:NEW_KEY});
  assert.deepEqual(f.staged,[{provider:'deepseek',model:'deepseek-v4-pro',baseUrl:'https://api.deepseek.com',apiKey:NEW_KEY}]);
  assert.equal(result.settings.saved,true);assert.equal(result.settings.checkScope,'local');
  assert.ok(!JSON.stringify(result.settings).includes(NEW_KEY));
  assert.deepEqual(await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}}),{provider:'deepseek',model:'deepseek-v4-pro',baseUrl:'https://api.deepseek.com',apiKey:NEW_KEY});
  assert.equal((await stat(join(f.appDir,WRITER_STATE_FILE))).mode&0o777,0o600);
  await assert.rejects(readFile(join(f.appDir,'deepseek-api-key'),'utf8'),{code:'ENOENT'});
  const encrypted=await readFile(join(f.appDir,WRITER_STATE_FILE),'utf8');
  assert.equal(JSON.parse(encrypted).version,3);assert.ok(!encrypted.includes(NEW_KEY)&&!encrypted.includes(OLD_KEY));
  assert.equal(JSON.parse(await readFile(join(f.appDir,'writer-config.json'),'utf8')).model,'deepseek-flash');
  assert.deepEqual((await readdir(f.appDir)).sort(),['writer-config.json',WRITER_STATE_FILE].sort());
});
test('blank key preserves saved credential through Codex switch and a later DeepSeek save',async t=>{
  const f=await setup(t);
  await f.controller.write({provider:'deepseek',model:'deepseek-flash',apiKey:NEW_KEY});
  await f.controller.write({provider:'codex'});
  assert.equal((await f.controller.read()).model,'gpt-6.1-sol');
  assert.deepEqual(await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{DEEPSEEK_API_KEY:OLD_KEY}}),{provider:'codex'});
  await f.controller.write({provider:'deepseek',model:'deepseek-flash',apiKey:'  '});
  assert.equal((await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}})).apiKey,NEW_KEY);
});
test('unsupported providers URLs extra fields and malformed keys never initialize or persist',async t=>{
  const f=await setup(t);
  for(const input of [{provider:'unsupported-agent'},{provider:'deepseek',model:'https://malicious.invalid'},
    {provider:'deepseek',model:'deepseek-flash',baseUrl:'https://malicious.invalid'},
    {provider:'deepseek',model:'deepseek-flash',apiKey:'tiny'},
    {provider:'codex',model:'other'},{provider:'codex',apiKey:NEW_KEY},null,[]]){
    await assert.rejects(f.controller.write(input),error=>!error.message.includes(NEW_KEY));
  }
  assert.equal(f.staged.length,0);
  assert.equal((await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}})).apiKey,OLD_KEY);
  assert.ok(!(await readdir(f.appDir)).includes(WRITER_STATE_FILE));
});
test('initialization failure preserves runtime selection and disk key without leaking provider errors',async t=>{
  const f=await setup(t,{createRunner:async()=>({initialize:async()=>{throw new Error(NEW_KEY);}})});
  await assert.rejects(f.controller.write({provider:'deepseek',model:'deepseek-v4-pro',apiKey:NEW_KEY}),error=>
    error.code==='WRITER_INITIALIZE_FAILED'&&!JSON.stringify(error).includes(NEW_KEY)&&!error.message.includes(NEW_KEY));
  assert.equal((await f.controller.read()).model,'deepseek-flash');
  assert.equal((await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}})).apiKey,OLD_KEY);
});
test('commit failure preserves runtime selection and old private state',async t=>{
  const f=await setup(t,{commitState:async()=>{throw new Error(NEW_KEY);}});
  await assert.rejects(f.controller.write({provider:'deepseek',model:'deepseek-v4-pro',apiKey:NEW_KEY}),error=>
    error.code==='WRITER_SETTINGS_SAVE_FAILED'&&!error.message.includes(NEW_KEY));
  assert.equal((await f.controller.read()).model,'deepseek-flash');
  assert.equal((await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}})).apiKey,OLD_KEY);
});
test('a concurrent settings save is refused while one candidate is initializing',async t=>{
  let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,{createRunner:async config=>({...runner(config),initialize:()=>wait})});
  const first=f.controller.write({provider:'codex'});
  await assert.rejects(f.controller.write({provider:'deepseek',model:'deepseek-v4-pro',apiKey:NEW_KEY}),error=>error.code==='BUSY');
  release();await first;
  assert.equal((await f.controller.read()).provider,'codex');
});
test('private state rejects a symlink target and an unsafe directory without altering targets',async t=>{
  const f=await setup(t);
  const state={version:1,provider:'deepseek',model:'deepseek-flash',deepseekApiKey:NEW_KEY};
  await symlink(join(f.appDir,'deepseek-api-key'),join(f.appDir,WRITER_STATE_FILE));
  await assert.rejects(savePrivateWriterState(f.appDir,state,{credentialStore:f.credentialStore}),error=>error.code==='WRITER_SETTINGS_SAVE_FAILED');
  assert.equal(await readFile(join(f.appDir,'deepseek-api-key'),'utf8'),OLD_KEY);
  await rm(join(f.appDir,WRITER_STATE_FILE));
  await chmod(f.appDir,0o777);
  await assert.rejects(savePrivateWriterState(f.appDir,state,{credentialStore:f.credentialStore}),error=>error.code==='WRITER_SETTINGS_SAVE_FAILED');
  await chmod(f.appDir,0o700);
  const alias=f.appDir+'-alias';await symlink(f.appDir,alias);t.after(()=>rm(alias,{force:true}));
  await assert.rejects(savePrivateWriterState(alias,state,{credentialStore:f.credentialStore}),error=>error.code==='WRITER_SETTINGS_SAVE_FAILED');
  assert.ok(!(await readdir(f.appDir)).includes(WRITER_STATE_FILE));
});
test('new private state wins over legacy settings and refuses unsafe file modes or unknown fields',async t=>{
  const f=await setup(t);
  const path=join(f.appDir,WRITER_STATE_FILE);
  await savePrivateWriterState(f.appDir,{version:1,provider:'codex',deepseekApiKey:NEW_KEY},{credentialStore:f.credentialStore});
  assert.deepEqual(await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}}),{provider:'codex'});
  await chmod(path,0o644);
  await assert.rejects(loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}}),error=>error.code==='WRITER_CONFIG');
  await chmod(path,0o600);
  await writeFile(path,JSON.stringify({version:1,provider:'codex',apiKey:NEW_KEY}));
  await assert.rejects(loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}}),error=>error.code==='WRITER_CONFIG'&&!error.message.includes(NEW_KEY));
});
test('system keystore failure preserves legacy disk and runtime without a plaintext fallback',async t=>{
  const credentialStore={backend:'macos-keychain',async seal(){throw new CredentialStoreError();},async discard(){}};
  const f=await setup(t,{credentialStore});
  await assert.rejects(f.controller.write({provider:'deepseek',model:'deepseek-v4-pro',apiKey:NEW_KEY}),error=>error.code==='CREDENTIAL_STORE_UNAVAILABLE'&&!error.message.includes(NEW_KEY));
  assert.equal((await f.controller.read()).model,'deepseek-flash');
  assert.equal(await readFile(join(f.appDir,'deepseek-api-key'),'utf8'),OLD_KEY);
  assert.ok(!(await readdir(f.appDir)).includes(WRITER_STATE_FILE));
});
test('locked credentials remain advertised and preserved when switching Agent; blank unavailable key cannot overwrite',async t=>{
  const f=await setup(t);
  await f.controller.write({provider:'deepseek',model:'deepseek-flash',apiKey:NEW_KEY});
  const path=join(f.appDir,WRITER_STATE_FILE),before=await readFile(path,'utf8');
  let locked=true;
  const credentialStore={...f.credentialStore,async unseal(...args){if(locked)throw new CredentialStoreError();return f.credentialStore.unseal(...args);}};
  const controller=await createWriterSettingsController({appDir:f.appDir,credentialStore,env:{},initialRunner:runner(),createRunner:runner,discoverAgents:async()=>[]});
  const settings=await controller.read();assert.equal(settings.keyConfigured,true);assert.equal(settings.credentialStorage.encrypted,true);
  await assert.rejects(controller.write({provider:'deepseek',model:'deepseek-flash'}),{code:'CREDENTIAL_STORE_UNAVAILABLE'});
  assert.equal(await readFile(path,'utf8'),before);
  await controller.write({provider:'codex'});assert.equal((await controller.read()).provider,'codex');
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')).profiles,JSON.parse(before).profiles);
  locked=false;await controller.read();await controller.write({provider:'deepseek',model:'deepseek-flash'});assert.equal((await controller.read()).provider,'deepseek');
});
test('unavailable inactive provider credential cannot stop the selected cloud writer',async t=>{
  const f=await setup(t);
  await f.controller.write({provider:'openai',model:'gpt-test',apiKey:NEW_KEY});
  const credentialStore={...f.credentialStore,async unseal(provider,...args){if(provider==='deepseek')throw new CredentialStoreError();return f.credentialStore.unseal(provider,...args);}};
  assert.equal((await loadWriterConfig({appDir:f.appDir,env:{},credentialStore})).apiKey,NEW_KEY);
  const controller=await createWriterSettingsController({appDir:f.appDir,env:{},credentialStore,initialRunner:runner({provider:'openai',model:'gpt-test'}),createRunner:runner,discoverAgents:async()=>[]});
  assert.equal((await controller.read()).profiles.deepseek.keyConfigured,true);
  const before=JSON.parse(await readFile(join(f.appDir,WRITER_STATE_FILE),'utf8'));
  await controller.write({provider:'openai',model:'gpt-other'});
  const after=JSON.parse(await readFile(join(f.appDir,WRITER_STATE_FILE),'utf8'));
  assert.deepEqual(after.profiles.deepseek.credential,before.profiles.deepseek.credential);
  assert.equal(after.profiles.openai.model,'gpt-other');
});
test('new explicit credential replaces an unavailable old envelope while other provider envelopes remain intact',async t=>{
  const f=await setup(t);
  await f.controller.write({provider:'deepseek',model:'deepseek-flash',apiKey:NEW_KEY});
  const path=join(f.appDir,WRITER_STATE_FILE),old=JSON.parse(await readFile(path,'utf8')).profiles.deepseek.credential;
  const credentialStore={...f.credentialStore,async unseal(provider,envelope){if(envelope.ciphertext===old.ciphertext)throw new CredentialStoreError('CREDENTIAL_STORE_PLATFORM_MISMATCH','请重新填写 API Key。');return f.credentialStore.unseal(provider,envelope);}};
  const controller=await createWriterSettingsController({appDir:f.appDir,env:{},credentialStore,initialRunner:runner(),createRunner:runner,discoverAgents:async()=>[]});
  await controller.write({provider:'deepseek',model:'deepseek-flash',apiKey:OLD_KEY});
  assert.equal((await loadWriterConfig({appDir:f.appDir,env:{},credentialStore})).apiKey,OLD_KEY);
  assert.equal((await controller.read()).credentialStorage.backend,'windows-dpapi');
  assert.equal(f.credentialStore.records.size,1);
});
test('unchanged credentials reuse encrypted envelopes and rotations retire old records only after successful commit',async t=>{
  const f=await setup(t);
  await f.controller.write({provider:'deepseek',model:'deepseek-flash',apiKey:NEW_KEY});
  const path=join(f.appDir,WRITER_STATE_FILE),before=JSON.parse(await readFile(path,'utf8')).profiles.deepseek.credential;
  await f.controller.write({provider:'deepseek',model:'deepseek-v4-pro'});
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')).profiles.deepseek.credential,before);
  assert.equal(f.credentialStore.records.size,1);
  await f.controller.write({provider:'deepseek',model:'deepseek-flash',apiKey:OLD_KEY});
  assert.equal(f.credentialStore.records.size,1);assert.notDeepEqual(JSON.parse(await readFile(path,'utf8')).profiles.deepseek.credential,before);
});
test('model discovery uses only its provider key and does not persist, initialize, or select another writer',async t=>{
  const calls=[];
  const f=await setup(t,{discoverModelsImpl:async input=>{calls.push(input);return {provider:input.provider,models:[{id:'discovered-test-model'}],source:'remote'};}});
  const before=await readdir(f.appDir);
  assert.equal((await f.controller.models({provider:'deepseek',apiKey:' '})).models[0].id,'discovered-test-model');
  assert.equal(calls[0].apiKey,OLD_KEY);assert.equal(calls[0].provider,'deepseek');
  await assert.rejects(f.controller.models({provider:'openai'}),{code:'API_KEY_REQUIRED'});
  await assert.rejects(f.controller.models({provider:'codex'}),{code:'WRITER_SETTINGS_INVALID'});
  await assert.rejects(f.controller.models({provider:'deepseek',baseUrl:'https://attacker.invalid'}),{code:'WRITER_SETTINGS_INVALID'});
  await assert.rejects(f.controller.models({provider:'deepseek',model:'not-allowed'}),{code:'WRITER_SETTINGS_INVALID'});
  assert.deepEqual(await readdir(f.appDir),before);assert.equal(f.staged.length,0);assert.equal((await f.controller.read()).provider,'deepseek');
});
test('concurrent model discovery is rejected while independent read remains available',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,{discoverModelsImpl:()=>pending});
  const listing=f.controller.models({provider:'deepseek'});
  await assert.rejects(f.controller.models({provider:'deepseek'}),{code:'BUSY'});
  assert.equal((await f.controller.read()).provider,'deepseek');
  release({provider:'deepseek',models:[],source:'remote'});await listing;
});
