import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html=await readFile(new URL('./extension/popup.html',import.meta.url),'utf8');
const source=await readFile(new URL('./extension/popup.js',import.meta.url),'utf8');
const catalog=await readFile(new URL('./extension/provider-catalog.js',import.meta.url),'utf8');
const styleCatalog=await readFile(new URL('./extension/reply-style-catalog.js',import.meta.url),'utf8');
const css=await readFile(new URL('./extension/popup.css',import.meta.url),'utf8');
const bootstrap=source.indexOf('\nif (globalThis.chrome?.runtime?.sendMessage)');
assert.ok(bootstrap>0);
const fixtureSource=catalog.replaceAll('export ','')+'\n'+styleCatalog+'\n'+source.slice(0,bootstrap).replace(/^import .*?;\n/gm,'').replace('export function mountPopup','function mountPopup')+'\nglobalThis.fixtureMountPopup=mountPopup;';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,timeout=1000){const started=Date.now();while(!condition()){if(Date.now()-started>timeout)throw new Error('Popup condition timed out');await delay(5);}}
function harness(t,{initial={},intercept,preview=false}={}){
  const dom=new JSDOM(html,{url:'https://extension-fixture.test/popup.html',runScripts:'outside-only'});
  const w=dom.window;
  const calls=[],modelCalls=[];
  const state={enabled:true,tonePreset:'auto',transport:'bridge',connectionStatus:'connected',health:{writerProvider:'deepseek',writerModel:'deepseek-flash'},writerSettings:{provider:'deepseek',model:'deepseek-flash',keyConfigured:true,checkScope:'local'},...structuredClone(initial)};
  async function send(message){
    (message.type==='listWriterModels'?modelCalls:calls).push(structuredClone(message));
    const custom=await intercept?.(message,state);
    if(custom!==undefined)return custom;
    if(message.type==='listWriterModels')return {ok:true,modelList:{provider:message.settings.provider,baseUrl:message.settings.baseUrl,source:'remote',models:[{id:'fixture-remote-model'}]}};
    if(message.type==='popupState')return {ok:true,...structuredClone(state)};
    if(message.type==='setReplyTransport'){state.transport=message.transport;state.writerSettings=null;state.health=null;state.connectionStatus=message.transport==='direct'?'auth-required':'unavailable';return {ok:true,transport:state.transport};}
    if(message.type==='savePopupPreferences'){if(Object.hasOwn(message,'enabled'))state.enabled=message.enabled;if(message.tonePreset)state.tonePreset=message.tonePreset;return {ok:true,enabled:state.enabled,tonePreset:state.tonePreset};}
    if(message.type==='saveWriterSettings'){state.writerSettings={provider:message.settings.provider,model:message.settings.model||'gpt-6.1-sol',keyConfigured:message.settings.provider==='deepseek',checkScope:'local'};return {ok:true,writerSettings:structuredClone(state.writerSettings)};}
    throw new Error(`Unexpected message type ${message.type}`);
  }
  w.eval(fixtureSource);
  const popup=w.fixtureMountPopup(send,{preview});
  t.after(()=>{popup.destroy();w.close();});
  return {w,doc:w.document,popup,calls,modelCalls,state};
}

test('compact popup reads only sanitized settings and never captures or generates posts on opening',async t=>{
  const h=harness(t);await h.popup.ready;
  assert.deepEqual(h.calls.map(c=>c.type),['popupState']);
  assert.equal(h.doc.getElementById('engine-name').textContent,'DeepSeek');
  assert.equal(h.doc.getElementById('engine-model').textContent,'deepseek-flash');
  assert.equal(h.doc.getElementById('connection-text').textContent,'本机服务连接正常');
  assert.equal(h.doc.querySelector('textarea,[data-style],#context-select,#source-text,#generate'),null);
  assert.equal(h.doc.getElementById('tone-menu').hidden,true);
  assert.equal(h.doc.getElementById('settings-screen').hidden,true);
  assert.equal(h.doc.getElementById('review-link'),null);
});

test('style menu derives eight merged styles and automatic matching from the shared catalogue',async t=>{
  const h=harness(t);await h.popup.ready;
  assert.equal(h.doc.getElementById('tone-label').textContent,'回复风格');
  assert.equal(h.doc.getElementById('tone-note').textContent,'自动匹配按原帖选四条；手动选择生成同风格四条。下次生成生效。');
  h.doc.getElementById('tone-toggle').click();
  assert.equal(h.doc.getElementById('tone-menu').hidden,false);
  assert.equal(h.doc.getElementById('tone-toggle').getAttribute('aria-expanded'),'true');
  const catalogue=h.w.XReplyStyleCatalog.styles;
  assert.deepEqual([...h.doc.querySelectorAll('[data-tone]')].map(n=>n.dataset.tone),['auto','chat','playful','professional','sharp','agree','perspective','practical','empathetic']);
  assert.equal(h.doc.querySelector('[data-tone="auto"] small').textContent,'从下方风格中按原帖选择');
  for(const style of catalogue){
    assert.equal(h.doc.querySelector(`[data-tone="${style.id}"] strong`).textContent,style.label);
    assert.equal(h.doc.querySelector(`[data-tone="${style.id}"] small`).textContent,style.description);
  }
  h.doc.querySelector('[data-tone="professional"]').click();
  await until(()=>h.doc.getElementById('tone-value').textContent==='理性专业');
  assert.equal(h.doc.getElementById('tone-menu').hidden,true);
  assert.equal(h.doc.querySelector('[data-tone="professional"]').getAttribute('aria-selected'),'true');
  assert.deepEqual(h.calls[1],{type:'savePopupPreferences',tonePreset:'professional'});
  assert.equal(h.calls.length,2);
  h.doc.getElementById('tone-toggle').click();h.doc.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape'}));
  assert.equal(h.doc.getElementById('tone-menu').hidden,true);
});

test('new manual styles restore and save without generation, capture, or model changes',async t=>{
  const h=harness(t,{initial:{tonePreset:'empathetic'}});await h.popup.ready;
  assert.equal(h.doc.getElementById('tone-value').textContent,'温和共情');
  assert.equal(h.doc.querySelector('[data-tone="empathetic"]').getAttribute('aria-selected'),'true');
  for(const id of ['agree','perspective','practical','empathetic','auto']){
    h.doc.getElementById('tone-toggle').click();h.doc.querySelector(`[data-tone="${id}"]`).click();
    await until(()=>h.state.tonePreset===id&&!h.doc.getElementById('tone-toggle').disabled);
    assert.equal(h.doc.getElementById('tone-menu').hidden,true);
  }
  assert.deepEqual(h.calls.map(message=>message.type),['popupState',...Array(5).fill('savePopupPreferences')]);
  assert.deepEqual(h.calls.slice(1).map(message=>message.tonePreset),['agree','perspective','practical','empathetic','auto']);
  assert.equal(h.state.writerSettings.provider,'deepseek');
  assert.equal(h.state.writerSettings.model,'deepseek-flash');
});

test('style dropdown keeps a bounded scroll area inside the compact popup',async t=>{
  const h=harness(t);await h.popup.ready;
  const sheet=h.doc.createElement('style');sheet.textContent=css;h.doc.head.append(sheet);
  const menuStyle=h.w.getComputedStyle(h.doc.getElementById('tone-menu'));
  assert.equal(menuStyle.maxHeight,'240px');assert.equal(menuStyle.overflowY,'auto');
  assert.ok(Number.parseInt(h.w.getComputedStyle(h.doc.body).maxHeight)<=600);
});

test('enable switch saves preference without generation or altering model',async t=>{
  const h=harness(t);await h.popup.ready;
  h.doc.getElementById('enabled').click();
  await until(()=>h.state.enabled===false);
  assert.deepEqual(h.calls[1],{type:'savePopupPreferences',enabled:false});
  assert.equal(h.doc.getElementById('enabled').checked,false);
  assert.match(h.doc.getElementById('usage-note').textContent,/暂停/);
  assert.equal(h.state.writerSettings.provider,'deepseek');
});

test('writer settings read failure stays separate from healthy service and uses bounded fixed notice',async t=>{
  const h=harness(t,{initial:{writerSettings:null,health:{writerProvider:'codex',writerModel:'gpt-6.1-sol'},writerSettingsError:{code:'INVALID_RESPONSE',message:'private-backend-text-should-not-render'}}});await h.popup.ready;
  assert.equal(h.doc.getElementById('connection-text').textContent,'本机服务连接正常');
  assert.equal(h.doc.getElementById('engine-name').textContent,'Codex');
  assert.equal(h.doc.getElementById('engine-model').textContent,'gpt-6.1-sol');
  assert.equal(h.doc.getElementById('notice').textContent,'服务已连接，模型设置暂未读取，点击重试。');
  assert.equal(h.doc.body.textContent.includes('private-backend-text-should-not-render'),false);
  assert.equal(h.doc.getElementById('refresh-status').hidden,false);
  h.doc.getElementById('open-settings').click();
  assert.equal(h.doc.getElementById('agent-settings').hidden,false);
  assert.equal(h.doc.getElementById('api-settings').hidden,true);
  h.doc.getElementById('back-home').click();
  h.state.writerSettingsError=undefined;h.state.writerSettings={provider:'codex',model:'gpt-6.1-sol',keyConfigured:false,checkScope:'local'};
  h.doc.getElementById('refresh-status').click();await until(()=>h.calls.length===2&&!h.doc.getElementById('refresh-status').disabled&&h.doc.getElementById('notice').hidden);
  assert.equal(h.doc.getElementById('connection').className,'connection connected');
  assert.equal(h.calls.some(message=>message.type==='inlineGenerate'),false);
});

test('settings preserve model names confirmed by health when settings could not be read',async t=>{
  const h=harness(t,{initial:{writerSettings:null,health:{writerProvider:'deepseek',writerModel:'deepseek-v4-pro'},writerSettingsError:{code:'INVALID_RESPONSE',message:'unavailable'}}});await h.popup.ready;
  h.doc.getElementById('open-settings').click();
  assert.equal(h.doc.getElementById('api-settings').hidden,false);
  assert.equal(h.doc.getElementById('api-model').value,'deepseek-v4-pro');
  assert.equal(h.calls.some(message=>message.type==='saveWriterSettings'),false);
  h.state.health.writerModel='unknown-model';await h.popup.refresh();
  assert.equal(h.doc.getElementById('engine-model').textContent,'unknown-model');
  h.doc.getElementById('back-home').click();h.doc.getElementById('open-settings').click();assert.equal(h.doc.getElementById('api-model').value,'unknown-model');
});

test('API settings never prefill a saved key, preserve a blank key and make only a local check claim',async t=>{
  const h=harness(t,{initial:{writerSettings:{provider:'deepseek',model:'deepseek-flash',keyConfigured:true,checkScope:'local',apiKey:'should-not-render-private-key'}}});await h.popup.ready;
  h.doc.getElementById('open-settings').click();
  assert.equal(h.doc.getElementById('settings-screen').hidden,false);
  assert.equal(h.doc.getElementById('api-key').type,'password');
  assert.equal(h.doc.getElementById('api-key').value,'');
  assert.match(h.doc.getElementById('api-key').placeholder,/留空沿用/);
  assert.equal(h.doc.documentElement.outerHTML.includes('should-not-render-private-key'),false);
  h.doc.getElementById('api-model').value='deepseek-v4-pro';
  h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
  await until(()=>h.doc.getElementById('notice').textContent.includes('API 连接会在生成时验证'));
  assert.deepEqual(h.calls[1],{type:'saveWriterSettings',transport:'bridge',settings:{provider:'deepseek',model:'deepseek-v4-pro',baseUrl:'https://api.deepseek.com'}});
  assert.equal(h.calls[2].type,'popupState');
  assert.equal(h.doc.getElementById('notice').textContent.includes('API 连接成功'),false);
  assert.equal(h.doc.querySelector('#show-key'),null);assert.equal(h.doc.getElementById('api-base-url').value,'https://api.deepseek.com');
});

test('typed API key is submitted only to save settings and cleared after successful save and screen changes',async t=>{
  const h=harness(t);await h.popup.ready;h.doc.getElementById('engine-settings').click();
  const key='fixture-private-typed-key';h.doc.getElementById('api-key').value=key;
  h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
  await until(()=>h.calls.length===3&&h.doc.getElementById('save-api').disabled===false);
  assert.equal(h.calls[1].settings.apiKey,key);
  assert.equal(h.doc.getElementById('api-key').value,'');
  assert.equal(h.doc.documentElement.outerHTML.includes(key),false);
  assert.equal(h.doc.body.textContent.includes(key),false);
  h.doc.getElementById('api-key').value=key;h.doc.getElementById('local-tab').click();assert.equal(h.doc.getElementById('api-key').value,'');
  h.doc.getElementById('api-tab').click();h.doc.getElementById('api-key').value=key;h.doc.getElementById('back-home').click();assert.equal(h.doc.getElementById('api-key').value,'');
  h.doc.getElementById('open-settings').click();h.doc.getElementById('api-key').value=key;h.w.dispatchEvent(new h.w.Event('pagehide'));assert.equal(h.doc.getElementById('api-key').value,'');
});

test('save failure clears typed secrets and does not render arbitrary backend text',async t=>{
  const key='fixture-secret-should-never-render';
  const h=harness(t,{intercept:m=>m.type==='saveWriterSettings'?{ok:false,code:'UNAVAILABLE',error:`Failed ${key}`} :undefined});await h.popup.ready;
  h.doc.getElementById('open-settings').click();h.doc.getElementById('api-key').value=key;h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
  await until(()=>h.doc.getElementById('notice').classList.contains('error'));
  assert.equal(h.doc.getElementById('api-key').value,'');assert.equal(h.doc.body.textContent.includes(key),false);assert.match(h.doc.getElementById('notice').textContent,/未保存|未完成/);
});

test('local agents use installation detection and keep unsupported integrations disabled',async t=>{
  const h=harness(t,{initial:{writerSettings:{provider:'deepseek',model:'deepseek-flash',keyConfigured:true,agents:[{id:'codex',installed:false,supported:true},{id:'claude',installed:true,supported:true},{id:'gemini',installed:true,supported:false}]}}});await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('agent-tab').click();
  assert.equal(h.doc.getElementById('api-settings').hidden,true);
  const options=[...h.doc.getElementById('agent-provider').options];
  assert.equal(options.find(n=>n.value==='codex').disabled,true);assert.match(options.find(n=>n.value==='codex').textContent,/未安装/);
  assert.equal(options.find(n=>n.value==='claude').disabled,false);assert.equal(options.find(n=>n.value==='gemini').disabled,true);
  h.doc.getElementById('agent-provider').value='claude';h.doc.getElementById('agent-provider').dispatchEvent(new h.w.Event('change'));
  h.doc.getElementById('agent-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.doc.getElementById('notice').textContent.includes('已保存本地 Agent'));
  assert.deepEqual(h.calls[1],{type:'saveWriterSettings',transport:'bridge',settings:{provider:'claude'}});
  h.doc.getElementById('back-home').click();assert.equal(h.doc.getElementById('engine-name').textContent,'Claude Code');
  h.doc.getElementById('open-settings').click();assert.equal(h.doc.getElementById('agent-settings').hidden,false);
});

test('unavailable or unauthenticated local service offers honest status and keeps settings accessible',async t=>{
  const h=harness(t,{initial:{connectionStatus:'auth-required',writerSettings:{provider:'deepseek',model:'deepseek-flash',keyConfigured:false,checkScope:'local'}}});await h.popup.ready;
  assert.equal(h.doc.getElementById('connection-text').textContent,'本机连接需要恢复');h.doc.getElementById('open-settings').click();
  assert.equal(h.doc.getElementById('settings-screen').hidden,false);assert.equal(h.doc.getElementById('api-key').placeholder,'输入 DeepSeek API Key');
  h.doc.getElementById('back-home').click();h.state.connectionStatus='unavailable';h.doc.getElementById('refresh-status').click();await until(()=>h.doc.getElementById('connection-text').textContent==='本机服务未连接');
  assert.deepEqual(h.calls.map(m=>m.type),['popupState','popupState']);
});

test('localhost preview can show screens but cannot submit preferences or credentials',async t=>{
  const h=harness(t,{preview:true});await h.popup.ready;
  h.doc.getElementById('enabled').click();h.doc.getElementById('tone-toggle').click();h.doc.querySelector('[data-tone="sharp"]').click();
  h.doc.getElementById('open-settings').click();h.doc.getElementById('api-key').value='preview-no-submit';h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
  await delay(10);assert.equal(h.doc.getElementById('api-key').value,'');assert.deepEqual(h.calls.map(m=>m.type),['popupState']);assert.match(h.doc.getElementById('notice').textContent,/预览/);
});


test('provider switching clears typed secrets and never auto-saves',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();
 assert.equal(h.doc.getElementById('review-link'),null);
 assert.deepEqual([...h.doc.getElementById('provider').options].map(n=>n.value),['deepseek','openai','qwen','kimi','minimax','doubao']);
 h.doc.getElementById('api-key').value='private-old-provider-key';h.doc.getElementById('provider').value='qwen';h.doc.getElementById('provider').dispatchEvent(new h.w.Event('change'));
 assert.equal(h.doc.getElementById('api-key').value,'');assert.equal(h.doc.getElementById('api-key').placeholder.includes('留空沿用'),false);assert.equal(h.calls.length,1);
});


test('saved profiles restore their own model and endpoint without transferring keys',async t=>{
 const h=harness(t,{initial:{writerSettings:{provider:'deepseek',model:'deepseek-flash',keyConfigured:true,profiles:{qwen:{model:'qwen-plus',baseUrl:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',keyConfigured:true}}}}});await h.popup.ready;h.doc.getElementById('open-settings').click();
 h.doc.getElementById('provider').value='qwen';h.doc.getElementById('provider').dispatchEvent(new h.w.Event('change'));
 assert.equal(h.doc.getElementById('api-model').value,'qwen-plus');assert.equal(h.doc.getElementById('api-base-url').value,'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');assert.match(h.doc.getElementById('api-key').placeholder,/留空沿用/);assert.equal(h.doc.getElementById('api-key').value,'');
});

test('local models accept a real local model name and loopback endpoint without requiring a key',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('local-tab').click();
 h.doc.getElementById('local-model').value='qwen3:8b';h.doc.getElementById('local-base-url').value='http://localhost:11434/v1/';
 h.doc.getElementById('local-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.calls.length>=3&&!h.doc.getElementById('save-api').disabled&&!h.doc.getElementById('save-local').disabled);
 assert.deepEqual(h.calls[1],{type:'saveWriterSettings',transport:'bridge',settings:{provider:'ollama',model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434/v1'}});assert.equal(h.calls.some(m=>m.type==='inlineGenerate'),false);
});

test('local provider switches clear optional keys and restore the chosen service defaults',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('local-tab').click();h.doc.getElementById('local-api-key').value='local-private';
 h.doc.getElementById('model-provider').value='lmstudio';h.doc.getElementById('model-provider').dispatchEvent(new h.w.Event('change'));
 assert.equal(h.doc.getElementById('local-api-key').value,'');assert.equal(h.doc.getElementById('local-base-url').value,'http://127.0.0.1:1234/v1');assert.equal(h.doc.getElementById('local-model').value,'');assert.equal(h.calls.length,1);
});

test('invalid cloud endpoints and non-local local-model endpoints are rejected before saving',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('api-base-url').value='https://private-key-receiver.test/v1';h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 assert.equal(h.calls.length,1);assert.match(h.doc.getElementById('notice').textContent,/官方 API/);
 h.doc.getElementById('local-tab').click();h.doc.getElementById('local-model').value='qwen3:8b';h.doc.getElementById('local-base-url').value='http://192.168.1.5:11434/v1';h.doc.getElementById('local-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));assert.equal(h.calls.length,1);assert.match(h.doc.getElementById('notice').textContent,/本机 HTTP/);
});

test('unknown model ids remain editable and are submitted without a static model allowlist',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('provider').value='doubao';h.doc.getElementById('provider').dispatchEvent(new h.w.Event('change'));h.doc.getElementById('api-model').value='ep-user-model-20261020';h.doc.getElementById('api-key').value='private-doubao-key';
 h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.calls.length>=3&&!h.doc.getElementById('save-api').disabled&&!h.doc.getElementById('save-local').disabled);assert.deepEqual(h.calls[1],{type:'saveWriterSettings',transport:'bridge',settings:{provider:'doubao',model:'ep-user-model-20261020',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',apiKey:'private-doubao-key'}});
});

test('preview also blocks local model and local agent saves',async t=>{
 const h=harness(t,{preview:true});await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('local-tab').click();h.doc.getElementById('local-model').value='qwen3:8b';h.doc.getElementById('local-api-key').value='preview-private';h.doc.getElementById('local-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));assert.equal(h.doc.getElementById('local-api-key').value,'');h.doc.getElementById('agent-tab').click();h.doc.getElementById('agent-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await delay(10);assert.deepEqual(h.calls.map(m=>m.type),['popupState']);
});

test('settings automatically fetch real models using a saved key, with no key echo or model overwrite',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();
 await until(()=>h.doc.getElementById('api-model-note').textContent.includes('1 个模型'));
 assert.deepEqual(h.modelCalls,[{type:'listWriterModels',transport:'bridge',settings:{provider:'deepseek',baseUrl:'https://api.deepseek.com'}}]);
 assert.deepEqual([...h.doc.querySelectorAll('#api-models option[data-remote-model]')].map(n=>n.value),['fixture-remote-model']);
 assert.equal(h.doc.getElementById('api-model').value,'deepseek-flash');
 assert.equal(h.calls.some(m=>['saveWriterSettings','inlineGenerate'].includes(m.type)),false);
 h.doc.getElementById('api-model-refresh').click();await until(()=>h.modelCalls.length===2);
 assert.equal(h.doc.getElementById('api-key').value,'');
});

test('new provider waits for key, reads on blur, and keeps the unsaved key only in the input',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();
 h.doc.getElementById('provider').value='kimi';h.doc.getElementById('provider').dispatchEvent(new h.w.Event('change'));
 const before=h.modelCalls.length;assert.match(h.doc.getElementById('api-model-note').textContent,/填写 API Key/);
 const key=h.doc.getElementById('api-key');key.value='fixture-unsaved-key-only';key.dispatchEvent(new h.w.Event('input'));key.dispatchEvent(new h.w.Event('blur'));
 await until(()=>h.modelCalls.length===before+1&&h.doc.getElementById('api-model-note').textContent.includes('1 个模型'));
 assert.equal(h.modelCalls.at(-1).settings.apiKey,'fixture-unsaved-key-only');
 assert.equal(key.value,'fixture-unsaved-key-only');assert.equal(h.calls.some(m=>m.type==='saveWriterSettings'),false);
 h.doc.getElementById('back-home').click();assert.equal(key.value,'');
});

test('late model discovery from a different provider never contaminates the current list',async t=>{
 let release;
 const h=harness(t,{intercept(message){if(message.type==='listWriterModels'&&message.settings.provider==='deepseek')return new Promise(resolve=>{release=resolve;});}});
 await h.popup.ready;h.doc.getElementById('open-settings').click();await until(()=>release);
 h.doc.getElementById('provider').value='qwen';h.doc.getElementById('provider').dispatchEvent(new h.w.Event('change'));
 release({ok:true,modelList:{provider:'deepseek',baseUrl:'https://api.deepseek.com',source:'remote',models:[{id:'late-wrong-provider'}]}});await delay(10);
 assert.equal(h.doc.querySelectorAll('#api-models option[data-remote-model]').length,0);
 assert.match(h.doc.getElementById('api-model-note').textContent,/填写 API Key/);
 assert.equal(h.doc.getElementById('api-model').value,'');
});

test('unsupported discovery remains editable, errors are fixed text, and preview makes no discovery calls',async t=>{
 const h=harness(t,{intercept(message){if(message.type==='listWriterModels')return {ok:false,code:'MODEL_DISCOVERY_UNSUPPORTED',error:'private-remote-echo'};}});
 await h.popup.ready;h.doc.getElementById('open-settings').click();await until(()=>h.doc.getElementById('api-model-note').textContent.includes('暂不提供'));
 assert.equal(h.doc.getElementById('api-model').disabled,false);assert.equal(h.doc.body.textContent.includes('private-remote-echo'),false);
 const p=harness(t,{preview:true});await p.popup.ready;p.doc.getElementById('open-settings').click();p.doc.getElementById('api-model-refresh').click();assert.equal(p.modelCalls.length,0);
});

test('local model discovery uses its own endpoint and does not download or save a model',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('local-tab').click();
 await until(()=>h.doc.getElementById('local-model-note').textContent.includes('1 个模型'));
 assert.deepEqual(h.modelCalls.at(-1),{type:'listWriterModels',transport:'bridge',settings:{provider:'ollama',baseUrl:'http://127.0.0.1:11434/v1'}});
 assert.equal(h.doc.getElementById('local-model').value,'');assert.equal(h.calls.some(m=>m.type==='saveWriterSettings'),false);
});

test('new cloud providers start blank without a key and never use built-in model defaults as fetched results',async t=>{
 const h=harness(t,{initial:{writerSettings:{provider:'codex',model:'gpt-fixture',keyConfigured:false,checkScope:'local',profiles:{},agents:[]},health:{writerProvider:'codex',writerModel:'gpt-fixture'}}});
 await h.popup.ready;h.doc.getElementById('open-settings').click();h.doc.getElementById('api-tab').click();
 for(const id of ['deepseek','openai','qwen','kimi','minimax','doubao']){
  h.doc.getElementById('provider').value=id;h.doc.getElementById('provider').dispatchEvent(new h.w.Event('change'));
  assert.equal(h.doc.getElementById('api-model').value,'');assert.equal(h.doc.getElementById('api-models').value,'');
  assert.equal(h.doc.getElementById('api-models').selectedOptions[0].textContent,'先填写 API Key 以获取模型');
  assert.equal(h.doc.getElementById('api-model').hidden,true);
  assert.equal(h.doc.querySelectorAll('#api-models option[data-remote-model]').length,0);
 }
 assert.equal(h.modelCalls.length,0);
});

test('native model dropdown keeps every remote option visible when an existing model is selected',async t=>{
 const h=harness(t,{intercept(message){if(message.type==='listWriterModels')return {ok:true,modelList:{provider:message.settings.provider,baseUrl:message.settings.baseUrl,source:'remote',models:[{id:'deepseek-flash'},{id:'deepseek-v4-pro'}]}};}});
 await h.popup.ready;h.doc.getElementById('open-settings').click();await until(()=>h.doc.querySelectorAll('#api-models option[data-remote-model]').length===2);
 const select=h.doc.getElementById('api-models');assert.equal(select.tagName,'SELECT');assert.equal(select.value,'deepseek-flash');
 assert.deepEqual([...select.querySelectorAll('[data-remote-model]')].map(n=>n.value),['deepseek-flash','deepseek-v4-pro']);
 select.value='deepseek-v4-pro';select.dispatchEvent(new h.w.Event('change'));
 assert.equal(h.doc.getElementById('api-model').value,'deepseek-v4-pro');assert.equal(h.doc.getElementById('api-model').hidden,true);
 assert.equal(select.querySelectorAll('[data-remote-model]').length,2);
 h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.calls.some(m=>m.type==='saveWriterSettings'));
 assert.equal(h.calls.find(m=>m.type==='saveWriterSettings').settings.model,'deepseek-v4-pro');
});

test('manual model entry remains available and a fresh fetched list still waits for an explicit choice',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();
 h.doc.getElementById('provider').value='qwen';h.doc.getElementById('provider').dispatchEvent(new h.w.Event('change'));
 const key=h.doc.getElementById('api-key');key.value='fixture-qwen-model-key';key.dispatchEvent(new h.w.Event('input'));key.dispatchEvent(new h.w.Event('blur'));
 await until(()=>h.doc.querySelectorAll('#api-models option[data-remote-model]').length===1);
 const select=h.doc.getElementById('api-models');assert.equal(select.value,'');assert.equal(h.doc.getElementById('api-model').value,'');
 select.value='__manual__';select.dispatchEvent(new h.w.Event('change'));
 assert.equal(h.doc.getElementById('api-model').hidden,false);h.doc.getElementById('api-model').value='my-custom-model';
 h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));await until(()=>h.calls.some(m=>m.type==='saveWriterSettings'));
 assert.equal(h.calls.find(m=>m.type==='saveWriterSettings').settings.model,'my-custom-model');
});


test('fresh direct install configures API entirely in the popup without local service or automatic generation',async t=>{
 const h=harness(t,{initial:{transport:'direct',connectionStatus:'auth-required',writerSettings:null,health:null},intercept(message,state){
  if(message.type==='saveWriterSettings'){
   assert.equal(message.transport,'direct');
   const {provider,model,baseUrl}=message.settings;
   state.writerSettings={provider,model,baseUrl,keyConfigured:true,profiles:{[provider]:{model,baseUrl,keyConfigured:true}},credentialStorage:{backend:'browser-aes-gcm'},checkScope:'browser'};
   state.connectionStatus='configured';return {ok:true,writerSettings:state.writerSettings};
  }
 }});await h.popup.ready;
 assert.equal(h.doc.getElementById('connection-text').textContent,'尚未配置模型');
 assert.equal(h.doc.getElementById('refresh-status').hidden,true);
 assert.equal(h.doc.getElementById('engine-name').textContent,'尚未配置');
 h.doc.getElementById('open-settings').click();
 assert.equal(h.doc.getElementById('api-models').value,'');assert.equal(h.modelCalls.length,0);
 assert.match(h.doc.getElementById('key-note').textContent,/AES-GCM/);assert.match(h.doc.getElementById('key-note').textContent,/不通过浏览器同步/);
 const key=h.doc.getElementById('api-key');key.value='fixture-direct-own-key';key.dispatchEvent(new h.w.Event('input'));key.dispatchEvent(new h.w.Event('blur'));
 await until(()=>h.doc.querySelectorAll('#api-models option[data-remote-model]').length===1);
 assert.equal(h.modelCalls[0].transport,'direct');assert.equal(h.modelCalls[0].settings.apiKey,'fixture-direct-own-key');
 const select=h.doc.getElementById('api-models');select.value='fixture-remote-model';select.dispatchEvent(new h.w.Event('change'));
 h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 await until(()=>h.doc.getElementById('notice').textContent.includes('已保存浏览器配置'));
 assert.equal(key.value,'');assert.equal(h.doc.documentElement.outerHTML.includes('fixture-direct-own-key'),false);
 h.doc.getElementById('back-home').click();
 assert.equal(h.doc.getElementById('connection-text').textContent,'模型已配置，生成时验证');
 assert.equal(h.doc.body.textContent.includes('本机服务未连接'),false);
 h.doc.getElementById('open-settings').click();assert.match(key.placeholder,/留空沿用/);
 h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 await until(()=>h.calls.filter(m=>m.type==='saveWriterSettings').length===2&&!h.doc.getElementById('save-api').disabled);
 const saves=h.calls.filter(m=>m.type==='saveWriterSettings');assert.equal('apiKey' in saves[1].settings,false);
 assert.equal(h.calls.some(m=>['inlineGenerate','setReplyTransport','captureTimeline'].includes(m.type)),false);
 assert.ok(h.calls.every(m=>['popupState','saveWriterSettings'].includes(m.type)));
});

test('direct local model config uses browser transport and needs no bridge or API key',async t=>{
 const h=harness(t,{initial:{transport:'direct',connectionStatus:'auth-required',writerSettings:null,health:null}});await h.popup.ready;
 h.doc.getElementById('open-settings').click();h.doc.getElementById('local-tab').click();
 await until(()=>h.doc.querySelectorAll('#local-models option[data-remote-model]').length===1);assert.equal(h.modelCalls[0].transport,'direct');
 h.doc.getElementById('local-models').value='fixture-remote-model';h.doc.getElementById('local-models').dispatchEvent(new h.w.Event('change'));
 h.doc.getElementById('local-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 await until(()=>h.calls.some(m=>m.type==='saveWriterSettings'));
 const save=h.calls.find(m=>m.type==='saveWriterSettings');assert.equal(save.transport,'direct');assert.equal(save.settings.provider,'ollama');assert.equal('apiKey' in save.settings,false);
 assert.equal(h.calls.some(m=>m.type==='setReplyTransport'),false);
});

test('direct Agent tab honestly requires optional bridge and a deliberate switch',async t=>{
 const h=harness(t,{initial:{transport:'direct',connectionStatus:'auth-required',writerSettings:null,health:null}});await h.popup.ready;
 h.doc.getElementById('open-settings').click();h.doc.getElementById('agent-tab').click();
 assert.equal(h.doc.getElementById('save-agent').disabled,true);assert.match(h.doc.getElementById('agent-note').textContent,/浏览器不能直接运行/);
 assert.ok([...h.doc.getElementById('agent-provider').options].every(option=>option.disabled));
 assert.equal(h.doc.querySelector('#agent-bridge-actions a').getAttribute('href'),'help.html#local-agent');
 h.doc.getElementById('connect-agent').click();
 await until(()=>h.calls.some(m=>m.type==='setReplyTransport')&&!h.doc.getElementById('connect-agent').disabled);
 assert.deepEqual(h.calls.find(m=>m.type==='setReplyTransport'),{type:'setReplyTransport',transport:'bridge'});
 assert.match(h.doc.getElementById('notice').textContent,/尚未连接本机桥接/);
 assert.equal(h.calls.some(m=>m.type==='saveWriterSettings'),false);
});

test('bridge user can choose browser transport without copying a key or stale saved model',async t=>{
 const h=harness(t);await h.popup.ready;h.doc.getElementById('open-settings').click();
 const key=h.doc.getElementById('api-key');key.value='fixture-unsaved-bridge-key';
 const transport=h.doc.getElementById('reply-transport');transport.value='direct';transport.dispatchEvent(new h.w.Event('change'));
 await until(()=>h.state.transport==='direct'&&!transport.disabled);
 assert.equal(key.value,'');assert.equal(h.doc.getElementById('api-model').value,'');assert.equal(h.doc.getElementById('api-models').value,'');
 assert.equal(h.doc.getElementById('connection-text').textContent,'尚未配置模型');assert.equal(h.doc.getElementById('transport-options').open,false);
 assert.match(h.doc.getElementById('notice').textContent,/密钥不会复制/);
 assert.equal(h.calls.some(m=>m.type==='saveWriterSettings'),false);
 assert.equal(h.calls.some(m=>JSON.stringify(m).includes('fixture-unsaved-bridge-key')),false);
});

test('active generation rejects transport switch and preserves old connection mode',async t=>{
 const h=harness(t,{intercept:m=>m.type==='setReplyTransport'?{ok:false,code:'BUSY'}:undefined});await h.popup.ready;h.doc.getElementById('open-settings').click();
 const transport=h.doc.getElementById('reply-transport');transport.value='direct';transport.dispatchEvent(new h.w.Event('change'));
 await until(()=>h.doc.getElementById('notice').classList.contains('error'));
 assert.equal(transport.value,'bridge');assert.match(h.doc.getElementById('notice').textContent,/正在生成/);assert.equal(h.state.transport,'bridge');
 assert.equal(h.calls.some(m=>m.type==='saveWriterSettings'),false);
});

test('preview prevents transport changes and bridge probing',async t=>{
 const h=harness(t,{preview:true,initial:{transport:'direct',connectionStatus:'auth-required',writerSettings:null,health:null}});await h.popup.ready;
 h.doc.getElementById('open-settings').click();h.doc.getElementById('agent-tab').click();h.doc.getElementById('connect-agent').click();
 assert.deepEqual(h.calls.map(m=>m.type),['popupState']);assert.match(h.doc.getElementById('notice').textContent,/预览/);
});


test('fresh direct state with an empty provider profile does not claim a configured model',async t=>{
 const h=harness(t,{initial:{transport:'direct',connectionStatus:'auth-required',writerSettings:{provider:'deepseek',model:'',keyConfigured:false,profiles:{},credentialStorage:{backend:'browser-aes-gcm'}},health:{writerProvider:'deepseek',writerModel:'',authenticated:false}}});await h.popup.ready;
 assert.equal(h.doc.getElementById('connection-text').textContent,'尚未配置模型');
 assert.equal(h.doc.getElementById('engine-model').textContent,'打开模型设置');
 h.doc.getElementById('open-settings').click();assert.equal(h.modelCalls.length,0);assert.equal(h.doc.getElementById('api-model').value,'');
});

test('browser credential storage failure never tells direct users to install a local service or unlock Keychain',async t=>{
 const h=harness(t,{initial:{transport:'direct',connectionStatus:'configured'},intercept:m=>m.type==='saveWriterSettings'?{ok:false,code:'CREDENTIAL_STORE_UNAVAILABLE'}:undefined});await h.popup.ready;
 h.doc.getElementById('open-settings').click();h.doc.getElementById('api-key').value='fixture-failing-browser-save';h.doc.getElementById('api-settings').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 await until(()=>h.doc.getElementById('notice').classList.contains('error'));
 assert.match(h.doc.getElementById('notice').textContent,/浏览器密钥存储不可用/);assert.equal(h.doc.getElementById('notice').textContent.includes('钥匙串'),false);assert.equal(h.doc.getElementById('api-key').value,'');
});
