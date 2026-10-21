import test from 'node:test';
import assert from 'node:assert/strict';

const runtimeId='a'.repeat(32),secret='fixture-direct-api-key-0123456789';
const popup={id:runtimeId,url:`chrome-extension://${runtimeId}/popup.html`};
const content={id:runtimeId,tab:{id:7},frameId:0,documentId:'direct-document',url:'https://x.com/home'};
const source={id:'1234567890123456789',url:'https://x.com/demo/status/1234567890123456789',text:'连续几天没睡好，今天只想安安静静待一会儿。'};
const reply={contextStatus:'sufficient',missingContext:'',candidates:[
  ['witty','empathetic','那今天就先安静待着吧，不用连休息都给自己安排任务。'],
  ['humor','chat','连续几天没睡好，确实很难再有精力接着忙。希望你能有一段没人打扰的时间。'],
  ['insight','empathetic','有时候只想安静一会儿，也不用急着解释给每个人听。'],
  ['story','chat','今天没有安排也挺好，先给自己留点空白。']
].map(([style,replyStyle,text])=>({style,replyStyle,text}))};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(2);}throw new Error('Condition timed out');}
// Minimal asynchronous IndexedDB fixture preserves the actual non-exportable
// WebCrypto key used by production code, rather than bypassing encryption.
function indexedDBFixture(){
  const values=new Map();let exists=false;
  const db={objectStoreNames:{contains:()=>exists},createObjectStore(){exists=true;},transaction(){
    const tx={objectStore:()=>({get(id){const request={};queueMicrotask(()=>{request.result=values.get(id);request.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return request;},put(value,id){values.set(id,value);}})};return tx;
  }};
  return {open(){const request={};queueMicrotask(()=>{request.result=db;if(!exists)request.onupgradeneeded?.();request.onsuccess?.();});return request;},values};
}
async function harness(t,{local={},session={}}={}){
  const previous={chrome:globalThis.chrome,fetch:globalThis.fetch,indexedDB:globalThis.indexedDB};
  const callbacks={},calls=[],tabs=[];let behavior=async()=>Response.json({choices:[{message:{role:'assistant',content:JSON.stringify(reply)},finish_reason:'stop'}]});
  const area=data=>({async get(key){return structuredClone({[key]:data[key]});},async set(values){Object.assign(data,structuredClone(values));},async setAccessLevel(){}});
  globalThis.indexedDB=indexedDBFixture();
  globalThis.chrome={storage:{local:area(local),session:area(session)},runtime:{id:runtimeId,getURL:path=>`chrome-extension://${runtimeId}/${path}`,onMessage:{addListener(cb){callbacks.message=cb;}},onInstalled:{addListener(){}},async sendMessage(){}},contextMenus:{async removeAll(){},create(){},onClicked:{addListener(){}}},tabs:{async create(value){tabs.push(value);},onRemoved:{addListener(cb){callbacks.removed=cb;}}},action:{},scripting:{executeScript(){throw Error('No automatic capture');}}};
  globalThis.fetch=async(url,options)=>{assert.notEqual(new URL(url).hostname,'127.0.0.1');assert.notEqual(new URL(url).hostname,'localhost');calls.push({url,options});return behavior(url,options);};
  const reload=()=>import(`./extension/background.js?direct-background=${Date.now()}-${Math.random()}`);
  await reload();
  t.after(()=>Object.assign(globalThis,previous));
  return {local,session,calls,tabs,callbacks,reload,setBehavior(value){behavior=value;},message:(value,sender=popup)=>new Promise(resolve=>callbacks.message(value,sender,resolve))};
}
async function configure(h){return h.message({type:'saveWriterSettings',transport:'direct',settings:{provider:'deepseek',model:'deepseek-flash',apiKey:secret}});}
async function init(h,sender=content){return h.message({type:'inlineInit',context:source},sender);}
async function generate(h,sessionId,sender=content){return h.message({type:'inlineGenerate',sessionId},sender);}
async function poll(h,sessionId,id,sender=content){return h.message({type:'inlinePoll',sessionId,id},sender);}
function privateState(h,...publicResults){for(const value of [h.local,h.session,...publicResults])assert.equal(JSON.stringify(value).includes(secret),false);}

test('fresh profile configures API and manually generates four source-bound replies without localhost, capture or posting',async t=>{
  const h=await harness(t);
  const fresh=await h.message({type:'popupState'});assert.equal(fresh.transport,'direct');assert.equal(fresh.connectionStatus,'auth-required');assert.equal(fresh.writerSettings.model,'');assert.equal(h.calls.length,0);
  const initialized=await init(h);assert.equal(initialized.ok,true);assert.equal(initialized.paired,true);assert.equal(h.calls.length,0);
  assert.equal((await generate(h,initialized.sessionId)).code,'DIRECT_CONFIG_REQUIRED');
  const saved=await configure(h);assert.equal(saved.ok,true);assert.equal(saved.transport,'direct');assert.equal(saved.writerSettings.keyConfigured,true);
  assert.equal(h.local.directWriterSettings.profiles.deepseek.credential.backend,'browser-aes-gcm');assert.equal(h.calls.length,0);
  const configured=await h.message({type:'popupState'});assert.equal(configured.connectionStatus,'configured');assert.equal(configured.health.authenticated,true);assert.equal(h.calls.length,0);
  const started=await generate(h,initialized.sessionId);assert.equal(started.job.status,'running');assert.equal(started.job.transport,'direct');
  await until(()=>h.session.replySessionState.inlineSessions[initialized.sessionId].job.status==='completed');
  const result=await poll(h,initialized.sessionId,started.job.id);assert.equal(result.job.candidates.length,4);assert.deepEqual(result.job.candidates.map(x=>x.replyStyle),['empathetic','chat','empathetic','chat']);assert.ok(result.job.candidates.every(x=>x.context.id===source.id));
  await h.reload();const restored=await poll(h,initialized.sessionId,started.job.id);assert.equal(restored.job.status,'completed');assert.deepEqual(restored.job.candidates,result.job.candidates);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'https://api.deepseek.com/chat/completions');assert.equal(h.calls[0].options.headers.authorization,`Bearer ${secret}`);assert.equal(JSON.parse(h.calls[0].options.body).stream,true);assert.equal(h.tabs.length,0);privateState(h,fresh,saved,configured,started,result);
});

test('direct model discovery uses typed key once without saving it and requires trusted settings page',async t=>{
  const h=await harness(t);h.setBehavior(async(url,options)=>{assert.equal(url,'https://api.deepseek.com/models');assert.equal(options.headers.Authorization,`Bearer ${secret}`);return Response.json({data:[{id:'remote-first'},{id:'remote-second'}]});});
  assert.equal((await h.message({type:'listWriterModels',transport:'direct',settings:{provider:'deepseek',apiKey:secret}},content)).code,'UNTRUSTED_SENDER');
  const listed=await h.message({type:'listWriterModels',transport:'direct',settings:{provider:'deepseek',apiKey:secret}});
  assert.equal(listed.ok,true);assert.deepEqual(listed.modelList.models,[{id:'remote-first'},{id:'remote-second'}]);assert.equal(h.local.directWriterSettings,undefined);assert.equal(h.calls.length,1);privateState(h,listed);
});

test('running direct task never blocks poll/cancel and ignores late completion; owners cannot access another document',async t=>{
  const h=await harness(t);await configure(h);const held=deferred();h.setBehavior(()=>held.promise);
  const a=await init(h),other={...content,tab:{id:8},documentId:'other-document'},b=await init(h,other);
  const started=await generate(h,a.sessionId);await until(()=>h.calls.length===1);
  assert.equal((await generate(h,b.sessionId,other)).code,'JOB_RUNNING');
  for(const wrong of [other,{...content,documentId:'replaced-document'},{...content,frameId:1}])assert.equal((await poll(h,a.sessionId,started.job.id,wrong)).ok,false);
  const polled=await Promise.race([poll(h,a.sessionId,started.job.id),delay(100).then(()=>({timeout:true}))]);assert.equal(polled.job.status,'running');
  assert.equal((await h.message({type:'setReplyTransport',transport:'bridge'})).code,'JOB_RUNNING');
  assert.equal((await h.message({type:'saveWriterSettings',transport:'direct',settings:{provider:'deepseek',model:'deepseek-v4-pro'}})).code,'JOB_RUNNING');
  assert.equal((await h.message({type:'inlineCancel',sessionId:a.sessionId,id:started.job.id},other)).ok,false);
  const cancelled=await h.message({type:'inlineCancel',sessionId:a.sessionId,id:started.job.id},content);assert.equal(cancelled.job.status,'cancelled');assert.equal(h.calls[0].options.signal.aborted,true);
  held.resolve(Response.json({choices:[{message:{role:'assistant',content:JSON.stringify(reply)},finish_reason:'stop'}]}));await delay(10);
  assert.equal((await poll(h,a.sessionId,started.job.id)).job.status,'cancelled');
  h.setBehavior(async()=>Response.json({choices:[{message:{role:'assistant',content:JSON.stringify(reply)},finish_reason:'stop'}]}));
  const next=await generate(h,b.sessionId,other);assert.equal(next.ok,true);await until(()=>h.session.replySessionState.inlineSessions[b.sessionId].job.status==='completed');privateState(h,cancelled);
});

test('closing or replacing one reply document cancels only its task and worker restart fails persisted direct work',async t=>{
  const h=await harness(t);await configure(h);let held=deferred();h.setBehavior(()=>held.promise);
  const a=await init(h),other={...content,tab:{id:8},documentId:'other'},b=await init(h,other);
  const started=await generate(h,a.sessionId);await until(()=>h.calls.length===1);
  assert.equal((await h.message({type:'inlineClose',sessionId:b.sessionId},other)).closed,true);assert.equal((await poll(h,a.sessionId,started.job.id)).job.status,'running');
  const newDocument={...content,documentId:'fresh-document'};assert.equal((await init(h,newDocument)).ok,true);assert.equal(h.calls[0].options.signal.aborted,true);assert.equal(h.session.replySessionState.inlineSessions[a.sessionId],undefined);
  held.resolve(Response.json({choices:[{message:{role:'assistant',content:JSON.stringify(reply)},finish_reason:'stop'}]}));await delay(5);
  held=deferred();h.setBehavior(()=>held.promise);const fresh=await init(h,newDocument),active=await generate(h,fresh.sessionId,newDocument);await until(()=>h.calls.length===2);
  await h.reload();const restored=await poll(h,fresh.sessionId,active.job.id,newDocument);assert.equal(restored.job.status,'failed');assert.equal(restored.job.code,'DIRECT_WORKER_RESTARTED');assert.equal(h.calls.length,2);privateState(h,restored);
  held.resolve(Response.json({choices:[{message:{role:'assistant',content:JSON.stringify(reply)},finish_reason:'stop'}]}));await delay(10);
});

test('transport switch is trusted, explicit and preserves separate encrypted direct profiles and legacy token',async t=>{
  const token='legacy-private-pairing-token-12345';const h=await harness(t,{session:{replySessionState:{pairingToken:token}}});
  // Resolve legacy default from state without contacting a local service.
  assert.equal((await h.message({type:'getState'},{id:runtimeId,url:`chrome-extension://${runtimeId}/panel.html`})).ok,true);
  for(const sender of [content,{...popup,id:'b'.repeat(32)},{...popup,url:popup.url+'?other'},{...popup,tab:{id:2},frameId:1}])assert.equal((await h.message({type:'setReplyTransport',transport:'direct'},sender)).code,'UNTRUSTED_SENDER');
  assert.equal((await h.message({type:'setReplyTransport',transport:'invalid'})).ok,false);assert.equal(h.calls.length,0);
  assert.equal((await h.message({type:'setReplyTransport',transport:'direct'})).transport,'direct');await configure(h);const encrypted=structuredClone(h.local.directWriterSettings);
  assert.equal((await h.message({type:'setReplyTransport',transport:'bridge'})).transport,'bridge');assert.deepEqual(h.local.directWriterSettings,encrypted);assert.equal(h.session.replySessionState.pairingToken,token);assert.equal(h.calls.length,0);
  assert.equal((await h.message({type:'setReplyTransport',transport:'direct'}, {...popup,tab:{id:44},frameId:0})).ok,true);
  const initialized=await init(h);assert.equal(initialized.paired,true);await h.message({type:'inlineOpenSetup'},content);assert.deepEqual(h.tabs,[{url:`chrome-extension://${runtimeId}/popup.html`}]);privateState(h);
});
