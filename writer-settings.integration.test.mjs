import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBridge,createWriterRunnerFromConfig,PORT,REPLY_PROTOCOL} from './bridge.mjs';
import {fakeCredentialStore} from './credential-store.test-helper.mjs';
import {createWriterSettingsController,WriterSettingsError} from './writer-settings.mjs';
import {loadWriterConfig} from './writer-config.mjs';

const ORIGIN=`chrome-extension://${'a'.repeat(32)}`;
const FOREIGN=`chrome-extension://${'b'.repeat(32)}`;
const TOKEN='writer-settings-fixture-token';
const PUBLIC={provider:'deepseek',model:'deepseek-flash',keyConfigured:true,checkScope:'local'};
const JOB={context:{id:'1234567890123456789',url:'https://x.com/example/status/1234567890123456789',
  author:'@example',authorName:'作者',text:'中文测试原帖'},preferences:{style:'all'}};
function harness(t,settings={}){
  const runCalls=[];
  const runner={health:{writerProvider:'deepseek',writerModel:'deepseek-flash'},
    run:()=>new Promise(resolve=>{runCalls.push(resolve);})};
  const changes=[];
  const nextRunner={health:{writerProvider:'codex',writerModel:'gpt-6.1-sol'},run:async()=>({candidates:[]})};
  const bridge=createBridge({runner,token:TOKEN,autoConnectOrigin:ORIGIN,writerSettings:{
    read:()=>PUBLIC,write:async input=>{changes.push(input);return {runner:nextRunner,settings:{...PUBLIC,provider:'codex',model:'gpt-6.1-sol',saved:true}};},...settings}});
  t.after(async()=>{for(const release of runCalls)release({candidates:[]});await bridge.stop();});
  function request({path='/writer-settings',method='GET',body,headers={},stream}={}){
    const req=stream??Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    req.method=method;req.url=path;req.headers={host:`127.0.0.1:${PORT}`,origin:ORIGIN,
      'x-reply-bridge-token':TOKEN,'x-reply-protocol':REPLY_PROTOCOL,
      ...(body!==undefined?{'content-type':'application/json'}:{}),...headers};
    return new Promise(resolve=>{
      const responseHeaders={};let status;
      const res={setHeader:(key,value)=>{responseHeaders[key.toLowerCase()]=value;},
        writeHead:(code)=>{status=code;},end:text=>resolve({status,data:text?JSON.parse(text):null,headers:responseHeaders})};
      bridge.server.emit('request',req,res);
    });
  }
  return {request,changes,runCalls};
}
test('writer settings require the approved extension Origin plus token and protocol, never localhost preview access',async t=>{
  const h=harness(t);
  assert.equal((await h.request()).status,200);
  for(const origin of [undefined,FOREIGN,`http://127.0.0.1:${PORT}`,'https://x.com']){
    const response=await h.request({headers:{origin}});
    assert.equal(response.status,403);
    assert.equal(response.headers['access-control-allow-origin'],undefined);
  }
  assert.equal((await h.request({headers:{'x-reply-bridge-token':undefined}})).status,401);
  assert.equal((await h.request({headers:{'x-reply-protocol':'2'}})).status,409);
  assert.deepEqual((await h.request()).data,PUBLIC);
  assert.equal(h.changes.length,0);
});
test('only approved Origin receives settings CORS preflight; save swaps health and has no generation side effect',async t=>{
  const h=harness(t);
  assert.equal((await h.request({method:'OPTIONS',headers:{'x-reply-bridge-token':undefined}})).status,204);
  assert.equal((await h.request({method:'OPTIONS',headers:{origin:FOREIGN}})).status,403);
  const saved=await h.request({method:'POST',body:{provider:'codex'}});
  assert.equal(saved.status,200);assert.equal(saved.data.saved,true);assert.equal(saved.data.checkScope,'local');
  assert.equal((await h.request({path:'/health'})).data.writerProvider,'codex');
  assert.equal(h.changes.length,1);assert.equal(h.runCalls.length,0);
});
test('POST settings reads retain the approved Origin boundary and remain read-only during generation',async t=>{
  const h=harness(t);
  const path='/writer-settings/read';
  assert.equal((await h.request({path,method:'OPTIONS',headers:{'x-reply-bridge-token':undefined}})).status,204);
  for(const origin of [undefined,FOREIGN,`http://127.0.0.1:${PORT}`,'https://x.com']){
    assert.equal((await h.request({path,method:'OPTIONS',headers:{origin}})).status,403);
    assert.equal((await h.request({path,method:'POST',body:{},headers:{origin}})).status,403);
  }
  const created=await h.request({path:'/jobs',method:'POST',body:JOB});
  assert.equal(created.status,202);
  const read=await h.request({path,method:'POST',body:{}});
  assert.equal(read.status,200);assert.deepEqual(read.data,PUBLIC);
  for(const body of [{provider:'codex'},[],null])assert.equal((await h.request({path,method:'POST',body})).status,400);
  assert.equal(h.changes.length,0);assert.equal(h.runCalls.length,1);
});
test('active and cancelled-but-unsettled generation prevents model saves',async t=>{
  const h=harness(t);
  const created=await h.request({path:'/jobs',method:'POST',body:JOB});
  assert.equal(created.status,202);
  assert.equal((await h.request({method:'POST',body:{provider:'codex'}})).status,409);
  await h.request({path:`/jobs/${created.data.job.id}`,method:'DELETE'});
  assert.equal((await h.request({method:'POST',body:{provider:'codex'}})).status,409);
  assert.equal(h.changes.length,0);
});
test('settings lock covers a slow request body so generation and concurrent save cannot race a model switch',async t=>{
  const h=harness(t);
  const stream=new PassThrough();
  const saving=h.request({method:'POST',stream,headers:{'content-type':'application/json'}});
  assert.equal((await h.request({path:'/jobs',method:'POST',body:JOB})).status,409);
  assert.equal((await h.request({method:'POST',body:{provider:'codex'}})).status,409);
  assert.equal((await h.request({path:'/health'})).data.busy,true);
  stream.end(JSON.stringify({provider:'codex'}));
  assert.equal((await saving).status,200);
  assert.equal((await h.request({path:'/health'})).data.busy,false);
});
test('settings initialization errors preserve the active runner and return only sanitized messages',async t=>{
  const h=harness(t,{write:async()=>{throw new WriterSettingsError('WRITER_INITIALIZE_FAILED','本机配置检查失败。',503);}});
  const response=await h.request({method:'POST',body:{provider:'codex'}});
  assert.equal(response.status,503);assert.equal(response.data.code,'WRITER_INITIALIZE_FAILED');
  assert.equal((await h.request({path:'/health'})).data.writerProvider,'deepseek');
  assert.equal((await h.request({path:'/health'})).data.busy,false);
});
test('real settings controller and DeepSeek factory save privately through HTTP without remote calls or generation',async t=>{
  const appDir=await mkdtemp(join(tmpdir(),'x-reply-settings-http-'));
  t.after(()=>rm(appDir,{recursive:true,force:true}));
  const oldKey='fixture-old-api-key-http';
  const newKey='fixture-new-api-key-http';
  await writeFile(join(appDir,'writer-config.json'),JSON.stringify({version:1,provider:'deepseek',model:'deepseek-flash'}),{mode:0o600});
  await writeFile(join(appDir,'deepseek-api-key'),oldKey,{mode:0o600});
  let remoteCalls=0;
  const createRunner=config=>createWriterRunnerFromConfig(config,{env:{},deepseekOptions:{fetchImpl:async()=>{remoteCalls++;throw new Error('unexpected remote call');}}});
  const initialRunner=createRunner({provider:'deepseek',model:'deepseek-flash',apiKey:oldKey});
  await initialRunner.initialize();
  const credentialStore=fakeCredentialStore();
  const controller=await createWriterSettingsController({appDir,env:{},credentialStore,initialRunner,createRunner,discoverAgents:async()=>[]});
  const h=harness(t,controller);
  const response=await h.request({method:'POST',body:{provider:'deepseek',model:'deepseek-v4-pro',apiKey:newKey}});
  assert.equal(response.status,200);assert.equal(response.data.model,'deepseek-v4-pro');
  assert.equal(response.data.checkScope,'local');
  assert.equal((await h.request()).data.model,'deepseek-v4-pro');
  assert.equal((await h.request({path:'/health'})).data.writerModel,'deepseek-v4-pro');
  assert.equal((await loadWriterConfig({appDir,env:{},credentialStore})).apiKey,newKey);
  assert.ok(!JSON.stringify(response).includes(oldKey)&&!JSON.stringify(response).includes(newKey));
  assert.equal(remoteCalls,0);assert.equal(h.runCalls.length,0);
});

test('model list route requires approved origin token protocol and never changes the writer',async t=>{
 let calls=0;
 const list={provider:'deepseek',baseUrl:'https://api.deepseek.com',source:'remote',models:[{id:'remote-chat-model'}]};
 const h=harness(t,{models:async input=>{calls++;assert.deepEqual(input,{provider:'deepseek'});return list;}});
 const path='/writer-settings/models';
 for(const origin of [undefined,FOREIGN,`http://127.0.0.1:${PORT}`,'https://x.com']){
  assert.equal((await h.request({path,method:'OPTIONS',headers:{origin}})).status,403);
  assert.equal((await h.request({path,method:'POST',body:{provider:'deepseek'},headers:{origin}})).status,403);
 }
 assert.equal((await h.request({path,method:'POST',body:{provider:'deepseek'},headers:{'x-reply-bridge-token':undefined}})).status,401);
 assert.equal((await h.request({path,method:'POST',body:{provider:'deepseek'},headers:{'x-reply-protocol':'2'}})).status,409);
 assert.equal((await h.request({path,method:'GET'})).status,405);assert.equal(calls,0);
 const response=await h.request({path,method:'POST',body:{provider:'deepseek'}});assert.equal(response.status,200);assert.deepEqual(response.data,list);
 assert.equal(calls,1);assert.equal(h.changes.length,0);assert.equal(h.runCalls.length,0);assert.equal((await h.request({path:'/health'})).data.writerProvider,'deepseek');
});

test('upstream auth and arbitrary discovery errors cannot revoke bridge auth or expose server text',async t=>{
 const h=harness(t,{models:async()=>{throw Object.assign(new Error('private-server-echo'),{code:'MODEL_DISCOVERY_AUTH',status:401});}});
 const response=await h.request({path:'/writer-settings/models',method:'POST',body:{provider:'deepseek'}});
 assert.equal(response.status,503);assert.equal(response.data.code,'MODEL_DISCOVERY_AUTH');assert.equal(JSON.stringify(response).includes('private-server-echo'),false);
 assert.equal((await h.request()).status,200);assert.equal((await h.request({path:'/health'})).data.busy,false);
});
