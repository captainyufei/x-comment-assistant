import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadPrivateWriterState,loadWriterConfig,parsePrivateWriterState,publicSelectionFromPrivateWriterState,credentialStorageStatus,WRITER_STATE_FILE} from './writer-config.mjs';
import {createWriterSettingsController,savePrivateWriterState} from './writer-settings.mjs';
import {fakeCredentialStore} from './credential-store.test-helper.mjs';
import {validateWriterSettings,publicWriterSettings} from './extension/background-core.js';

const KEY_A='fixture-private-deepseek-key';
const KEY_B='fixture-private-openai-key';
const agents=[{id:'codex',label:'Codex',installed:true,path:'/private/do-not-echo'},
  {id:'claude',label:'Claude Code',installed:false}];
const runner=config=>({health:{writerProvider:config.provider,writerModel:config.model??'local-agent-model'},async initialize(){}});
async function fixture(t){
  const appDir=await mkdtemp(join(tmpdir(),'writer-providers-'));
  t.after(()=>rm(appDir,{recursive:true,force:true}));
  await writeFile(join(appDir,'writer-config.json'),JSON.stringify({version:1,provider:'deepseek',model:'deepseek-flash'}),{mode:0o600});
  await writeFile(join(appDir,'deepseek-api-key'),KEY_A,{mode:0o600});
  const staged=[],credentialStore=fakeCredentialStore();
  const controller=await createWriterSettingsController({appDir,env:{},initialRunner:runner({provider:'deepseek',model:'deepseek-flash'}),
    credentialStore,discoverAgents:async()=>agents,createRunner:config=>{staged.push(config);return runner(config);}});
  return {appDir,controller,staged,credentialStore};
}
test('legacy state migrates only in memory and public settings project profiles and agent availability without credentials or paths',async t=>{
  const f=await fixture(t),before=await readdir(f.appDir);
  const state=await loadPrivateWriterState({appDir:f.appDir,credentialStore:f.credentialStore,env:{}});
  assert.equal(state.version,2);assert.equal(state.provider,'deepseek');assert.equal(state.profiles.deepseek.apiKey,KEY_A);
  const selected=publicSelectionFromPrivateWriterState(state);
  assert.equal(selected.provider,'deepseek');assert.equal(selected.model,'deepseek-flash');assert.equal(typeof selected.baseUrl,'string');
  const settings=await f.controller.read();
  assert.equal(settings.profiles.deepseek.keyConfigured,true);
  assert.deepEqual(settings.agents,[{id:'codex',label:'Codex',installed:true,supported:true},{id:'claude',label:'Claude Code',installed:false,supported:true}]);
  assert.equal(JSON.stringify(settings).includes(KEY_A),false);assert.equal(JSON.stringify(settings).includes('/private'),false);
  assert.deepEqual(await readdir(f.appDir),before);assert.equal(f.staged.length,0);
});
test('provider switches keep independent credentials and blank key never borrows another provider key',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.controller.write({provider:'openai',model:'gpt-test'}),error=>error.code==='API_KEY_REQUIRED');
  assert.equal(f.staged.length,0);
  await f.controller.write({provider:'openai',model:'gpt-test',apiKey:KEY_B});
  await f.controller.write({provider:'claude'});
  await f.controller.write({provider:'deepseek',model:'deepseek-custom-model',apiKey:''});
  assert.equal((await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}})).apiKey,KEY_A);
  await f.controller.write({provider:'openai',model:'gpt-test',apiKey:' '});
  assert.equal((await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}})).apiKey,KEY_B);
  const disk=JSON.parse(await readFile(join(f.appDir,WRITER_STATE_FILE),'utf8'));
  assert.equal(disk.version,3);assert.equal(disk.profiles.deepseek.apiKey,undefined);assert.equal(disk.profiles.openai.apiKey,undefined);
  assert.ok(!JSON.stringify(disk).includes(KEY_A)&&!JSON.stringify(disk).includes(KEY_B));
});
test('local model profiles use loopback endpoint and no mandatory API credential',async t=>{
  const f=await fixture(t);
  await f.controller.write({provider:'ollama',model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434/v1'});
  assert.deepEqual(await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}}),{provider:'ollama',model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434/v1'});
  const saved=await f.controller.read();assert.equal(saved.keyConfigured,false);assert.equal(saved.profiles.deepseek.keyConfigured,true);
  assert.equal(saved.profiles.ollama.baseUrl,'http://127.0.0.1:11434/v1');
});
test('all supported providers validate while unknown providers arbitrary commands and hostile endpoints fail without preserving secrets in errors',()=>{
  for(const provider of ['codex','claude','gemini'])assert.deepEqual(validateWriterSettings({provider}),{provider});
  for(const provider of ['deepseek','openai','qwen','kimi','minimax','doubao'])assert.equal(validateWriterSettings({provider,model:'test-model',apiKey:KEY_B}).provider,provider);
  for(const input of [{provider:'exec',command:'rm -rf /'},
    {provider:'openai',model:'gpt-test',baseUrl:'https://attacker.invalid'},
    {provider:'ollama',model:'qwen3:8b',baseUrl:'http://169.254.169.254/v1'},
    {provider:'lmstudio',model:'local-model',baseUrl:'http://127.0.0.1:8769/v1'},
    {provider:'claude',apiKey:KEY_B}])assert.throws(()=>validateWriterSettings(input));
  assert.throws(()=>parsePrivateWriterState({version:2,provider:'other',profiles:{}}));
});
test('public writer projection redacts extra profile fields and local agent paths',()=>{
  const projected=publicWriterSettings({provider:'openai',model:'gpt-test',keyConfigured:true,checkScope:'local',apiKey:KEY_B,
    profiles:{openai:{model:'gpt-test',baseUrl:'https://api.openai.com/v1',keyConfigured:true,apiKey:KEY_B}},agents});
  assert.equal(projected.profiles.openai.keyConfigured,true);assert.equal(projected.agents[0].installed,true);
  assert.equal(JSON.stringify(projected).includes(KEY_B),false);assert.equal(JSON.stringify(projected).includes('/private'),false);
});
test('v1 private state takes precedence, keeps the inactive key, and leaves every byte unchanged during migration reads',async t=>{
  const f=await fixture(t);
  const path=join(f.appDir,WRITER_STATE_FILE);
  const original=JSON.stringify({version:1,provider:'codex',deepseekApiKey:KEY_B})+'\n';
  await writeFile(path,original,{mode:0o600});
  const state=await loadPrivateWriterState({appDir:f.appDir,credentialStore:f.credentialStore,env:{DEEPSEEK_API_KEY:KEY_A}});
  assert.equal(state.version,2);assert.equal(state.profiles.deepseek.apiKey,KEY_B);
  assert.deepEqual(await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}}),{provider:'codex'});
  assert.equal(await readFile(path,'utf8'),original);
});
test('multiple long provider credentials fit the bounded private encrypted file and survive an explicit save',async t=>{
  const f=await fixture(t);
  const longKey='p'.repeat(4096);
  const profiles=Object.fromEntries(['deepseek','openai','qwen','kimi','minimax','doubao'].map(provider=>[provider,{model:'test-model',apiKey:longKey}]));
  await savePrivateWriterState(f.appDir,{version:2,provider:'qwen',profiles},{credentialStore:f.credentialStore});
  const path=join(f.appDir,WRITER_STATE_FILE),metadata=await stat(path);
  assert.ok(metadata.size>0&&metadata.size<64*1024);assert.equal(metadata.mode&0o777,0o600);
  const selected=await loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{}});
  assert.equal(selected.provider,'qwen');assert.equal(selected.apiKey,longKey);
});
test('malformed v2 fields and profile credentials fail closed without selecting another provider',async t=>{
  const f=await fixture(t),path=join(f.appDir,WRITER_STATE_FILE);
  for(const state of [
    {version:2,provider:'openai',profiles:{}},
    {version:2,provider:'openai',profiles:{openai:{model:'gpt-test',apiKey:'tiny'}}},
    {version:2,provider:'codex',profiles:{claude:{model:'gpt-test'}}},
    {version:2,provider:'openai',profiles:{openai:{model:'gpt-test',apiKey:KEY_B,command:'exec'}}},
    {version:2,provider:'openai',profiles:{openai:{model:'gpt-test',baseUrl:'https://api.openai.com/v1?api_key=private'}}},
  ]){
    await writeFile(path,JSON.stringify(state),{mode:0o600});
    await assert.rejects(loadWriterConfig({appDir:f.appDir,credentialStore:f.credentialStore,env:{DEEPSEEK_API_KEY:KEY_A}}),error=>error.code==='WRITER_CONFIG'&&!error.message.includes(KEY_B));
  }
});
test('missing or incompatible local agent leaves current API selection and private file unchanged',async t=>{
  const f=await fixture(t);
  await f.controller.write({provider:'openai',model:'gpt-test',apiKey:KEY_B});
  const path=join(f.appDir,WRITER_STATE_FILE),before=await readFile(path,'utf8');
  const controller=await createWriterSettingsController({appDir:f.appDir,credentialStore:f.credentialStore,env:{},initialRunner:runner({provider:'openai',model:'gpt-test'}),
    discoverAgents:async()=>agents,createRunner:()=>({initialize:async()=>{throw new Error(KEY_B);}})});
  await assert.rejects(controller.write({provider:'claude'}),error=>error.code==='WRITER_INITIALIZE_FAILED'&&!error.message.includes(KEY_B));
  await assert.rejects(controller.write({provider:'gemini'}),error=>error.code==='AGENT_UNSUPPORTED');
  assert.equal((await controller.read()).provider,'openai');assert.equal(await readFile(path,'utf8'),before);
});
test('mixed platform storage status follows the selected provider rather than first profile',async t=>{
  const f=await fixture(t),credential=await f.credentialStore.seal('qwen',KEY_B);
  const oldMac={backend:'macos-keychain',reference:'deepseek-00000000-0000-0000-0000-000000000000',
    ciphertext:Buffer.alloc(16).toString('base64'),iv:Buffer.alloc(12).toString('base64'),tag:Buffer.alloc(16).toString('base64')};
  await writeFile(join(f.appDir,WRITER_STATE_FILE),JSON.stringify({version:3,provider:'qwen',profiles:{
    deepseek:{model:'deepseek-flash',credential:oldMac},qwen:{model:'qwen-flash',credential}}}),{mode:0o600});
  const state=await loadPrivateWriterState({appDir:f.appDir,env:{},credentialStore:f.credentialStore,allowUnavailable:true});
  assert.equal(credentialStorageStatus(state).backend,'windows-dpapi');assert.equal(state.profiles.qwen.apiKey,KEY_B);
});
