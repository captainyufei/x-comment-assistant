import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_POPUP_PREFERENCES, TONE_PRESETS, validatePopupPreferences, generationPreferences, isTrustedPopupSender, publicHealth, publicWriterSettings} from './extension/background-core.js';

const runtimeId='a'.repeat(32), token='popup-private-token-0123456789', apiKey='private-test-api-key-0123456789';
const popup={id:runtimeId,url:`chrome-extension://${runtimeId}/popup.html`};
const panel={id:runtimeId,url:`chrome-extension://${runtimeId}/panel.html`};
const setup={id:runtimeId,url:`chrome-extension://${runtimeId}/setup.html`};
const content={id:runtimeId,tab:{id:7},frameId:0,documentId:'reply-document',url:'https://x.com/home'};
const context={id:'1234567890123456789',url:'https://x.com/demo_user/status/1234567890123456789',text:'把自己的观察说清楚。'};
const candidates=['witty','humor','insight','story'].map((style,i)=>({style,label:'回复角度',text:`中文候选 ${i}`}));

async function harness(t,{preferences={style:'all',tone:'旧的自定义口吻',personalExperience:'用户自己提供的真实素材'},popupPreferences,authenticated=true,offline=false}={}){
  const session={},local={replyTransport:"bridge",replyPreferences:structuredClone(preferences),...(popupPreferences?{replyPopupPreferences:structuredClone(popupPreferences)}:{})};
  const callbacks={},calls=[],jobs=new Map(); let nextJob=0,writer={provider:'deepseek',model:'deepseek-flash',keyConfigured:true,checkScope:'local'};
  let failSave=false,popupError=false;
  const oldChrome=globalThis.chrome,oldFetch=globalThis.fetch;
  const area=data=>({async get(key){return structuredClone({[key]:data[key]});},async set(values){Object.assign(data,structuredClone(values));},async setAccessLevel(){}});
  globalThis.chrome={
    storage:{session:area(session),local:area(local)},
    runtime:{id:runtimeId,getURL:path=>`chrome-extension://${runtimeId}/${path}`,onMessage:{addListener(cb){callbacks.message=cb;}},onInstalled:{addListener(cb){callbacks.installed=cb;}},async sendMessage(){}},
    action:{onClicked:{addListener(){throw new Error('Toolbar must use default_popup');}},openPopup(options){calls.push({path:'popup',options});if(popupError)throw new Error('unsupported');return Promise.resolve();}},
    sidePanel:{open(){throw new Error('Side panel must never open');}},
    contextMenus:{async removeAll(){},create(){},onClicked:{addListener(cb){callbacks.menu=cb;}}},
    tabs:{async query(){throw new Error('Popup cannot inspect tabs');},async create(){throw new Error('Popup cannot navigate');},onRemoved:{addListener(){}}},
    scripting:{executeScript(){throw new Error('Popup cannot capture X');}}
  };
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;calls.push({path,method:options.method,body:options.body?JSON.parse(options.body):undefined});
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    if(offline)throw new Error('offline');
    if(path==='/health')return Response.json({authenticated,writerProvider:writer.provider,writerModel:writer.model,writerReasoningEffort:'disabled',token,apiKey});
    if(path==='/extension/connect')return Response.json({paired:true,token});
    assert.equal(options.headers['X-Reply-Bridge-Token'],token);assert.equal(options.headers['X-Reply-Protocol'],'4');
    if(path==='/pair')return Response.json({paired:true});
    if(path==='/writer-settings'||path==='/writer-settings/read'){
      if(path==='/writer-settings/read'){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{});}
      if(path==='/writer-settings'&&options.method==='POST'){
        if(failSave)return Response.json({error:`service echoed ${apiKey}`,code:'WRITER_CONFIG'},{status:400});
        const input=JSON.parse(options.body);writer=input.provider==='codex'?{provider:'codex',model:'gpt-6.1-sol',keyConfigured:false,checkScope:'local'}:{provider:'deepseek',model:input.model,keyConfigured:true,checkScope:'local'};
      }
      return Response.json({...writer,apiKey,token,internal:{apiKey}});
    }
    if(path==='/writer-settings/models')return Response.json({provider:'deepseek',baseUrl:'https://api.deepseek.com',source:'remote',models:[{id:'remote-chat-model',apiKey}],apiKey,token});
    if(path==='/jobs'){
      const job={id:`popup-job-${++nextJob}`,status:'running'};jobs.set(job.id,job);return Response.json({job});
    }
    const job=jobs.get(path.slice('/jobs/'.length));
    if(job)return Response.json({job});
    throw new Error(`Unexpected endpoint ${path}`);
  };
  t.after(()=>{globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;});
  const restore=()=>import(`./extension/background.js?popup-test=${Date.now()}-${Math.random()}`);
  await restore();
  const message=(value,sender=popup)=>new Promise(resolve=>callbacks.message(value,sender,resolve));
  return {session,local,calls,jobs,message,restore,callbacks,setFailSave(value){failSave=value;},setPopupError(value){popupError=value;}};
}

function assertPrivate(value){const text=JSON.stringify(value);assert.equal(text.includes(token),false);assert.equal(text.includes(apiKey),false);}

test('popup sender accepts only the exact same-extension toolbar document',()=>{
  assert.equal(isTrustedPopupSender(popup,runtimeId),true);
  assert.equal(isTrustedPopupSender({...popup,tab:{id:1},frameId:0},runtimeId),true);
  for(const sender of [panel,setup,content,{...popup,tab:{id:1},frameId:1},{...popup,id:'b'.repeat(32)},{...popup,url:popup.url+'?secret=1'},{...popup,url:'https://x.com/popup.html'}])assert.equal(isTrustedPopupSender(sender,runtimeId),false);
});

test('popup opening checks local connection and projects public config without capturing or generating',async t=>{
  const h=await harness(t);
  assert.deepEqual(h.calls,[]);
  const result=await h.message({type:'popupState'});
  assert.equal(result.ok,true);assert.equal(result.enabled,true);assert.equal(result.tonePreset,'auto');assert.equal(result.connectionStatus,'connected');
  assert.deepEqual(result.writerSettings,{provider:'deepseek',model:'deepseek-flash',keyConfigured:true,checkScope:'local'});
  assert.equal(result.health.writerProvider,'deepseek');assert.equal(result.health.writerModel,'deepseek-flash');assert.equal(result.health.writerReasoningEffort,'disabled');assertPrivate(result);
  assert.deepEqual(h.calls.map(call=>call.path),['/health','/extension/connect','/writer-settings/read']);
  assert.equal(h.session.replySessionState.selectedContext,null);assert.deepEqual(h.session.replySessionState.inlineSessions,{});assertPrivate(h.local);
});

test('only toolbar popup may read or change writer configuration; popup cannot invoke panel or inline capabilities',async t=>{
  const h=await harness(t);
  for(const sender of [panel,setup,content,{...popup,tab:{id:3},frameId:1},{...popup,id:'b'.repeat(32)},{...popup,url:popup.url+'?settings'}]){
    for(const request of [{type:'popupState'},{type:'getWriterSettings'},{type:'saveWriterSettings',settings:{provider:'deepseek',model:'deepseek-flash',apiKey}},{type:'savePopupPreferences',enabled:false}])assert.equal((await h.message(request,sender)).code,'UNTRUSTED_SENDER');
  }
  for(const type of ['getState','capture','generate','inlineInit','inlineGenerate','saveSettings'])assert.equal((await h.message({type,context})).code,'UNTRUSTED_SENDER');
  assert.deepEqual(h.calls,[]);assertPrivate(h.local);
});

test('popup preferences persist separately, reject unsupported data, and add one selected tone to one four-angle request',async t=>{
  const h=await harness(t);
  const original=structuredClone(h.local.replyPreferences);
  assert.deepEqual(await h.message({type:'savePopupPreferences',tonePreset:'professional'}),{ok:true,enabled:true,tonePreset:'professional'});
  assert.deepEqual(h.local.replyPreferences,original);assert.deepEqual(h.calls,[]);
  for(const change of [{tonePreset:'automatic-send'},{enabled:'false'},{enabled:null},{tonePreset:null},{apiKey}])assert.equal((await h.message({type:'savePopupPreferences',...change})).ok,false);
  await h.restore();assert.equal((await h.message({type:'popupState'})).tonePreset,'professional');
  const initialized=await h.message({type:'inlineInit',context},content);
  const result=await h.message({type:'inlineGenerate',sessionId:initialized.sessionId},content);
  assert.equal(result.ok,true);
  const requests=h.calls.filter(call=>call.path==='/jobs');assert.equal(requests.length,1);assert.equal(requests[0].body.preferences.style,'all');
  assert.ok(requests[0].body.preferences.tone.includes(TONE_PRESETS.professional));assert.ok(requests[0].body.preferences.tone.includes(original.tone));
  assert.equal(requests[0].body.preferences.personalExperience,original.personalExperience);assert.deepEqual(h.local.replyPreferences,original);
});

test('pause blocks only new jobs while existing jobs, owned results and manual resume stay available',async t=>{
  const h=await harness(t);
  const initialized=await h.message({type:'inlineInit',context},content);
  const started=await h.message({type:'inlineGenerate',sessionId:initialized.sessionId},content);
  const savedJob=structuredClone(h.session.replySessionState.inlineSessions[initialized.sessionId].job);
  const beforePause=h.calls.length;
  assert.equal((await h.message({type:'savePopupPreferences',enabled:false})).enabled,false);
  assert.equal(h.calls.length,beforePause);assert.deepEqual(h.session.replySessionState.inlineSessions[initialized.sessionId].job,savedJob);
  assert.equal((await h.message({type:'inlineGenerate',sessionId:initialized.sessionId},content)).code,'ASSISTANT_PAUSED');
  assert.equal((await h.message({type:'generate',context},panel)).code,'ASSISTANT_PAUSED');
  const pausedBefore=h.calls.length;
  const pausedInit=await h.message({type:'inlineInit',context},content);assert.equal(pausedInit.enabled,false);assert.equal(h.calls.length,pausedBefore);
  assert.equal((await h.message({type:'inlineHealth'},content)).enabled,false);assert.equal(h.calls.length,pausedBefore);
  Object.assign(h.jobs.get(started.job.id),{status:'completed',candidates,contextStatus:'sufficient',missingContext:''});
  const completed=await h.message({type:'inlinePoll',sessionId:initialized.sessionId,id:started.job.id},content);
  assert.equal(completed.job.candidates.length,4);assert.deepEqual(completed.job.candidates.map(value=>value.style),['witty','humor','insight','story']);
  const jobsBefore=h.calls.filter(call=>call.path==='/jobs').length;
  await h.message({type:'savePopupPreferences',enabled:true});assert.equal(h.calls.filter(call=>call.path==='/jobs').length,jobsBefore);
  assert.equal((await h.message({type:'inlineGenerate',sessionId:initialized.sessionId},content)).ok,true);assert.equal(h.calls.filter(call=>call.path==='/jobs').length,jobsBefore+1);
});

test('writer settings send secrets only in authenticated local POST and never persist or echo them',async t=>{
  const h=await harness(t);
  const saved=await h.message({type:'saveWriterSettings',settings:{provider:'deepseek',model:'deepseek-flash',apiKey}});
  assert.equal(saved.ok,true);assertPrivate(saved);assert.equal(JSON.stringify(h.session).includes(apiKey),false);assertPrivate(h.local);
  const posts=h.calls.filter(call=>call.path==='/writer-settings'&&call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body.apiKey,apiKey);
  const current=await h.message({type:'getWriterSettings'});assertPrivate(current);assert.equal(current.writerSettings.keyConfigured,true);
  const blank=await h.message({type:'saveWriterSettings',settings:{provider:'deepseek',model:'deepseek-v4-pro',apiKey:''}});assert.equal(blank.writerSettings.keyConfigured,true);
  const codex=await h.message({type:'saveWriterSettings',settings:{provider:'codex'}});assert.equal(codex.writerSettings.provider,'codex');assertPrivate(codex);
  const before=h.calls.length;
  for(const settings of [{provider:'unknown-agent'},{provider:'deepseek',model:'https://invalid.test',apiKey},{provider:'deepseek',model:'deepseek-flash',apiKey:'invalid key'},{provider:'codex',apiKey},{provider:'deepseek',model:'deepseek-flash',baseUrl:'https://attacker.test'}])assert.equal((await h.message({type:'saveWriterSettings',settings})).ok,false);
  assert.equal(h.calls.length,before);
  h.setFailSave(true);const failure=await h.message({type:'saveWriterSettings',settings:{provider:'deepseek',model:'deepseek-flash',apiKey}});assert.equal(failure.code,'WRITER_CONFIG');assertPrivate(failure);
  assert.equal(h.calls.filter(call=>call.path==='/jobs').length,0);
});

test('writer credentials can be configured when the selected writer is not authenticated; offline state is honest',async t=>{
  await t.test('unauthenticated writer still permits approved local setup',async sub=>{
    const h=await harness(sub,{authenticated:false});const state=await h.message({type:'popupState'});
    assert.equal(state.connectionStatus,'auth-required');assert.equal(state.health.authenticated,false);assert.ok(state.writerSettings);assertPrivate(state);
    const saved=await h.message({type:'saveWriterSettings',settings:{provider:'deepseek',model:'deepseek-flash',apiKey}});assert.equal(saved.ok,true);assertPrivate(saved);
    assert.equal(h.calls.filter(call=>call.path==='/jobs').length,0);
  });
  await t.test('offline never reports ready or creates a job',async sub=>{
    const h=await harness(sub,{offline:true});const state=await h.message({type:'popupState'});assert.equal(state.ok,true);assert.equal(state.connectionStatus,'unavailable');assert.equal(state.health,null);assert.equal(state.writerSettings,null);assertPrivate(state);
    assert.deepEqual(h.calls.map(call=>call.path),['/health']);
  });
});

test('context menu opens only the popup and handles browser compatibility errors without side panel or capture',async t=>{
  const h=await harness(t);
  h.callbacks.menu({menuItemId:'other'},{windowId:3});assert.equal(h.calls.length,0);
  h.callbacks.menu({menuItemId:'reply-selected-tweet',selectionText:'private selection'},{windowId:3});assert.deepEqual(h.calls,[{path:'popup',options:{windowId:3}}]);
  h.setPopupError(true);assert.doesNotThrow(()=>h.callbacks.menu({menuItemId:'reply-selected-tweet'},{windowId:3}));assert.equal(h.calls.length,2);
});

test('tone request bounds preserve stored custom text and public projections exclude credentials',()=>{
  assert.deepEqual(validatePopupPreferences(),DEFAULT_POPUP_PREFERENCES);
  const original={style:'all',tone:'中'.repeat(600),personalExperience:''};
  const generated=generationPreferences(original,{enabled:true,tonePreset:'sharp'});assert.equal(Array.from(generated.tone).length,600);assert.ok(generated.tone.startsWith(`本次选择语气（优先）：${TONE_PRESETS.sharp}`));assert.match(generated.tone,/补充偏好（不冲突时参考）：/);assert.equal(original.tone.length,600);
  const automatic=generationPreferences(original,{enabled:true,tonePreset:'auto'});assert.equal(Array.from(automatic.tone).length,600);assert.ok(automatic.tone.startsWith('补充偏好（不冲突时参考）：'));assert.equal(original.tone.length,600);
  assertPrivate(publicHealth({authenticated:true,writerModel:'deepseek-flash',apiKey,token}));
  assertPrivate(publicWriterSettings({provider:'deepseek',model:'deepseek-flash',keyConfigured:true,checkScope:'local',apiKey,token}));
});

test('model discovery is popup-only, uses authenticated POST, and does not persist or echo keys',async t=>{
 const h=await harness(t);
 for(const sender of [panel,setup,content,{...popup,tab:{id:2},frameId:1}])assert.equal((await h.message({type:'listWriterModels',settings:{provider:'deepseek',apiKey}},sender)).code,'UNTRUSTED_SENDER');
 assert.equal(h.calls.length,0);
 const result=await h.message({type:'listWriterModels',settings:{provider:'deepseek',apiKey}});
 assert.equal(result.ok,true);assert.deepEqual(result.modelList,{provider:'deepseek',baseUrl:'https://api.deepseek.com',source:'remote',models:[{id:'remote-chat-model'}]});
 assertPrivate(result);assertPrivate(h.local);assert.equal(JSON.stringify(h.session).includes(apiKey),false);
 const request=h.calls.find(c=>c.path==='/writer-settings/models');assert.equal(request.method,'POST');assert.equal(request.body.apiKey,apiKey);
 assert.equal(h.calls.some(c=>c.path==='/writer-settings'||c.path==='/jobs'),false);
});

test('invalid discovery source or endpoint never makes network requests',async t=>{
 const h=await harness(t);
 for(const settings of [{provider:'codex'},{provider:'deepseek',model:'x'},{provider:'deepseek',baseUrl:'https://attacker.example/v1',apiKey},{provider:'ollama',baseUrl:'http://192.168.1.1:1234/v1'}])assert.equal((await h.message({type:'listWriterModels',settings})).ok,false);
 assert.equal(h.calls.length,0);assertPrivate(h.local);
});
