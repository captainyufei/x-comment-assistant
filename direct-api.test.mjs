import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectWriter,DIRECT_SETTINGS_KEY} from './extension/direct-api.js';
const key='synthetic-direct-key-123456789';
const context={id:'1234567890',url:'https://x.com/example/status/1234567890',text:'做产品时先理解用户上次怎样解决问题。'};
const preferences={style:'all',tonePreset:'auto'};
const reply=()=>({contextStatus:'sufficient',missingContext:'',candidates:[
  {style:'witty',replyStyle:'agree',text:'这个切入点很实在，过去真正做过什么，比现场说想要什么更有参考价值。'},
  {style:'humor',replyStyle:'playful',text:'功能清单可以随口列，真要讲上次怎么解决，细节就藏不住了。'},
  {style:'insight',replyStyle:'professional',text:'问清当时卡在哪一步，以及为什么选择那种办法，也能帮助判断问题是否值得解决。'},
  {style:'story',replyStyle:'practical',text:'可以顺着问一句：当时有没有试过别的办法，最后为什么没继续用？'}]});
function memoryStorage(){const values={};return {values,async get(key){return {[key]:structuredClone(values[key])};},async set(input){Object.assign(values,structuredClone(input));}};}
function fakeVault(){const map=new Map();let serial=0;return {async available(){return true;},async seal(provider,secret){const id=++serial;map.set(id,{provider,secret});return {encrypted:id};},async unseal(provider,record){const item=map.get(record.encrypted);if(item?.provider!==provider)throw Object.assign(new Error('vault unavailable'),{code:'BROWSER_VAULT_UNAVAILABLE'});return item.secret;}};}
const jsonResponse=(body=reply(),extra={})=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(body)},finish_reason:'stop'}]}),{headers:{'content-type':'application/json',...extra}});
function events(body=reply(),{finish='stop',done=true,tool=false}={}){
  const text=JSON.stringify(body),parts=[text.slice(0,25),text.slice(25)];
  return [JSON.stringify({choices:[{index:0,delta:{role:'assistant'}}]}),...parts.map(content=>JSON.stringify({choices:[{index:0,delta:{content}}]})),...(tool?[JSON.stringify({choices:[{index:0,delta:{tool_calls:[{id:'bad'}]}}]})]:[]),JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}]}),...(done?['[DONE]']:[])].map(x=>`data: ${x}\n\n`).join('');
}
const streamResponse=(text=events())=>new Response(text,{headers:{'content-type':'text/event-stream'}});
async function setup(fetchImpl,extra={}){const storage=memoryStorage(),vault=fakeVault(),writer=createDirectWriter({storage,vault,fetchImpl,...extra});await writer.saveSettings({provider:'deepseek',model:'deepseek-flash',apiKey:key});return {writer,storage,vault};}
test('fresh install is explicitly unconfigured and does not read or migrate bridge secrets',async()=>{
  const storage=memoryStorage(),writer=createDirectWriter({storage,vault:fakeVault(),fetchImpl:()=>{throw Error('unexpected');}});
  assert.equal(await writer.hasConfiguration(),false);const state=await writer.readSettings();
  assert.equal(state.model,'');assert.equal(state.keyConfigured,false);assert.equal(state.credentialStorage.backend,'browser-aes-gcm');assert.deepEqual(state.agents,[]);
  assert.deepEqual(storage.values,{});await assert.rejects(writer.run(context,preferences),{code:'DIRECT_NOT_CONFIGURED'});
});
test('settings store only encrypted per-provider credentials, blank retains, public metadata never contains the key',async()=>{
  const {writer,storage}=await setup(()=>{});await writer.saveSettings({provider:'openai',model:'gpt-4o-mini',apiKey:'second-synthetic-key-123456'});
  const state=await writer.saveSettings({provider:'deepseek',model:'deepseek-v4-pro',apiKey:''});
  assert.equal(state.provider,'deepseek');assert.equal(state.keyConfigured,true);assert.equal(state.profiles.openai.keyConfigured,true);
  assert.equal(JSON.stringify(storage.values).includes(key),false);assert.equal(JSON.stringify(state).includes(key),false);
  assert.equal(storage.values[DIRECT_SETTINGS_KEY].profiles.deepseek.model,'deepseek-v4-pro');
});
test('key storage failure never saves plaintext or destroys an existing provider profile',async()=>{
  const {writer,storage,vault}=await setup(()=>{}),before=structuredClone(storage.values);vault.seal=async()=>{throw Object.assign(new Error('unavailable'),{code:'BROWSER_VAULT_UNAVAILABLE'});};
  await assert.rejects(writer.saveSettings({provider:'kimi',model:'kimi-k2.6',apiKey:key}));assert.deepEqual(storage.values,before);
});
test('direct run makes one streamed official API call and returns four validated actual styles without changing source',async()=>{
  let call,calls=0;const {writer}=await setup(async(...args)=>{calls++;call=args;return streamResponse();});const original=structuredClone(context);
  const result=await writer.run(context,preferences);assert.equal(calls,1);assert.equal(call[0],'https://api.deepseek.com/chat/completions');
  assert.equal(call[1].redirect,'error');assert.equal(call[1].credentials,'omit');assert.equal(JSON.parse(call[1].body).stream,true);
  assert.deepEqual(result.candidates.map(x=>x.replyStyle),['agree','playful','professional','practical']);assert.equal(result.candidates.length,4);
  assert.equal(result.mediaEvidence.images,0);assert.ok(result.timings.totalMs>=0);assert.deepEqual(context,original);
});
test('JSON completion fallback supports local providers without cloud credentials',async()=>{
  let call;const storage=memoryStorage(),writer=createDirectWriter({storage,vault:fakeVault(),fetchImpl:async(...args)=>{call=args;return jsonResponse();}});
  await writer.saveSettings({provider:'ollama',model:'qwen3:8b'});const result=await writer.run(context,preferences);
  assert.equal(call[0],'http://127.0.0.1:11434/v1/chat/completions');assert.equal(Object.hasOwn(call[1].headers,'authorization'),false);assert.equal(result.candidates.length,4);
});
test('browser parser honors manual style selection for every candidate',async()=>{
  const body=reply();body.candidates.forEach(x=>{x.replyStyle='practical';});const {writer}=await setup(async()=>streamResponse(events(body)));
  assert.equal((await writer.run(context,{...preferences,tonePreset:'practical'})).candidates.every(x=>x.replyStyle==='practical'),true);
  await assert.rejects(writer.run(context,{...preferences,tonePreset:'professional'}),{code:'INVALID_CANDIDATES'});
});
test('model discovery uses an entered key without saving or switching active provider',async()=>{
  let auth;const {writer,storage}=await setup(async(_,opts)=>{auth=opts.headers.Authorization;return new Response(JSON.stringify({data:[{id:'kimi-k2.6'}]}));});
  const before=structuredClone(storage.values),result=await writer.listModels({provider:'kimi',apiKey:'entered-synthetic-key-123456'});
  assert.equal(auth,'Bearer entered-synthetic-key-123456');assert.deepEqual(result.models,[{id:'kimi-k2.6'}]);assert.deepEqual(storage.values,before);
});
test('model discovery reuses only the selected provider credential',async()=>{
  let auth;const {writer}=await setup(async(_,opts)=>{auth=opts.headers.Authorization;return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}));});
  await writer.listModels({provider:'deepseek'});assert.equal(auth,`Bearer ${key}`);
  await assert.rejects(writer.listModels({provider:'kimi'}),{code:'MODEL_DISCOVERY_CONFIG'});
});
for(const input of [{provider:'deepseek',model:'deepseek-flash',baseUrl:'https://evil.example',apiKey:key},{provider:'ollama',model:'local',baseUrl:'http://192.168.0.3:11434/v1'},{provider:'codex'}])test('unsafe endpoint or local Agent cannot enter direct transport '+JSON.stringify(input),async()=>{
  const {writer}=await setup(()=>{throw Error('unexpected');});await assert.rejects(writer.saveSettings(input));
});
for(const [name,response] of [
  ['tool call',()=>streamResponse(events(reply(),{tool:true}))],
  ['truncation',()=>streamResponse(events(reply(),{finish:'length'}))],
  ['missing DONE',()=>streamResponse(events(reply(),{done:false}))],
  ['JSON finish length',()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(reply())},finish_reason:'length'}]}),{headers:{'content-type':'application/json'}})],
  ['huge response',()=>streamResponse('data: '+ 'x'.repeat(128*1024))],
  ['bad JSON',()=>new Response('provider-private-error '+key,{headers:{'content-type':'application/json'}})],
])test(`${name} fails closed without retry or partial candidates`,async()=>{
  let calls=0;const {writer}=await setup(async()=>{calls++;return response();});await assert.rejects(writer.run(context,preferences),error=>!!error.code&&!String(error.stack).includes(key));assert.equal(calls,1);
});
test('HTTP error bodies never escape into public errors and no retry occurs',async()=>{
  let calls=0;const {writer}=await setup(async()=>{calls++;return new Response(key,{status:401});});await assert.rejects(writer.run(context,preferences),error=>error.code==='DIRECT_AUTH_REQUIRED'&&!String(error.stack).includes(key));assert.equal(calls,1);
});
test('headers deadline settles even when provider ignores AbortSignal',async()=>{
  let signal;const {writer}=await setup(async(_,opts)=>{signal=opts.signal;return new Promise(()=>{});},{headersTimeoutMs:10});
  await assert.rejects(writer.run(context,preferences),{code:'DIRECT_HEADERS_TIMEOUT'});assert.equal(signal.aborted,true);
});
test('user cancellation aborts a hanging body without waiting for reader cancellation',async()=>{
  const body=new ReadableStream({start(){},cancel(){return new Promise(()=>{});}});const {writer}=await setup(async()=>new Response(body,{headers:{'content-type':'text/event-stream'}}));
  const controller=new AbortController(),result=writer.run(context,preferences,controller.signal);setTimeout(()=>controller.abort(),10);await assert.rejects(result,{code:'CANCELLED'});
});
test('image attachments use only validated pbs URL, matching MIME bytes, and truthful evidence',async()=>{
  const calls=[],png=new Uint8Array([137,80,78,71,13,10,26,10,0]);const {writer}=await setup(async(url,opts)=>{calls.push([url,opts]);return url.startsWith('https://pbs.twimg.com/')?new Response(png,{headers:{'content-type':'image/png'}}):jsonResponse();});
  const source={...context,hasMedia:true,media:[{kind:'image',url:'https://pbs.twimg.com/media/test.png',alt:'页面图片说明'}]};
  const result=await writer.run(source,preferences),payload=JSON.parse(calls[1][1].body);
  assert.equal(calls.length,2);assert.equal(calls[0][1].redirect,'error');assert.equal(calls[0][1].credentials,'omit');assert.equal(result.mediaEvidence.images,1);
  assert.equal(payload.messages[1].content[1].type,'image_url');assert.ok(payload.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
});
test('text-only model does not download images, and identifies unread media',async()=>{
  let calls=0;const {writer}=await setup(async()=>{calls++;return jsonResponse();});await writer.saveSettings({provider:'deepseek',model:'unknown-model'});
  const result=await writer.run({...context,hasMedia:true,media:[{kind:'image',url:'https://pbs.twimg.com/media/test.png'}]},preferences);
  assert.equal(calls,1);assert.equal(result.mediaEvidence.images,0);assert.ok(result.mediaEvidence.limitations.some(x=>x.includes('未确认支持图片')));
});
test('bad image bytes are not forwarded, missing-context result can return zero candidates',async()=>{
  let modelPayload;const {writer}=await setup(async(url,opts)=>url.startsWith('https://pbs.twimg.com/')?new Response('<script>invalid</script>',{headers:{'content-type':'image/png'}}):(modelPayload=JSON.parse(opts.body),jsonResponse({contextStatus:'missing',missingContext:'缺少原帖图片，无法确认语气。',candidates:[]})));
  const result=await writer.run({...context,hasMedia:true,media:[{kind:'image',url:'https://pbs.twimg.com/media/test.png'}]},preferences);
  assert.equal(typeof modelPayload.messages[1].content,'string');assert.equal(result.candidates.length,0);assert.equal(result.mediaEvidence.images,0);
});
test('SSE remains correct when UTF-8 characters and event lines span arbitrary chunks',async()=>{
  const bytes=new TextEncoder().encode(events());const stream=new ReadableStream({start(controller){for(let offset=0;offset<bytes.length;offset+=7)controller.enqueue(bytes.subarray(offset,offset+7));controller.close();}});
  const {writer}=await setup(async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}));assert.equal((await writer.run(context,preferences)).candidates.length,4);
});
test('complete SSE terminator returns without waiting for a server to close its connection',async()=>{
  let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(events()));},cancel(){cancelled=true;}});
  const {writer}=await setup(async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}),{timeoutMs:50});
  assert.equal((await writer.run(context,preferences)).candidates.length,4);assert.equal(cancelled,true);
});
test('direct IPv6 loopback fails locally with actionable address guidance and no request',async()=>{
  let calls=0;const {writer}=await setup(async()=>{calls++;return jsonResponse();});
  await assert.rejects(writer.saveSettings({provider:'ollama',model:'qwen:local',baseUrl:'http://[::1]:11434/v1'}),error=>error.code==='DIRECT_IPV6_UNSUPPORTED'&&error.message.includes('127.0.0.1'));
  await assert.rejects(writer.listModels({provider:'ollama',baseUrl:'http://[::1]:11434/v1'}),{code:'DIRECT_IPV6_UNSUPPORTED'});assert.equal(calls,0);
});
test('lost browser-profile key is reported locally before generation rather than claiming usable credentials',async()=>{
  const {writer,storage}=await setup(async()=>jsonResponse()),other=createDirectWriter({storage,vault:fakeVault(),fetchImpl:async()=>{throw Error('not reached');}});
  assert.equal(await writer.hasConfiguration(),true);assert.equal((await other.readSettings()).keyConfigured,true);
  assert.equal((await other.readSettings()).credentialStorage.available,false);assert.equal((await other.health()).authenticated,false);assert.equal(await other.hasConfiguration(),false);
});
test('keyless local model does not require an available vault',async()=>{
  const vault={async available(){return false;},async seal(){throw Error('unavailable');},async unseal(){throw Error('unavailable');}};
  const writer=createDirectWriter({storage:memoryStorage(),vault,fetchImpl:async()=>jsonResponse()});await writer.saveSettings({provider:'ollama',model:'local'});
  assert.equal(await writer.hasConfiguration(),true);assert.equal((await writer.health()).authenticated,true);assert.equal((await writer.run(context,preferences)).candidates.length,4);
});
test('a pre-aborted signal performs no request or media download',async()=>{
  let calls=0;const {writer}=await setup(async()=>{calls++;return jsonResponse();});const controller=new AbortController();controller.abort();
  await assert.rejects(writer.run(context,preferences,controller.signal),{code:'CANCELLED'});assert.equal(calls,0);
});
test('a provider cannot reflect the selected API key into otherwise-valid public replies',async()=>{
  const body=reply();body.candidates[0].text=`响应意外包含私密内容 ${key}`;
  const {writer}=await setup(async()=>jsonResponse(body));await assert.rejects(writer.run(context,preferences),error=>error.code==='DIRECT_FORMAT'&&!String(error.stack).includes(key));
});
test('a response arriving after headers cancellation has its body cancelled without retry',async()=>{
  let resolveResponse,cancelled=false,calls=0;const {writer}=await setup(async()=>{calls++;return new Promise(resolve=>{resolveResponse=resolve;});},{headersTimeoutMs:5});
  await assert.rejects(writer.run(context,preferences),{code:'DIRECT_HEADERS_TIMEOUT'});
  resolveResponse(new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true);assert.equal(calls,1);
});
