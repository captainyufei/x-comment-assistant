import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverModels,ModelDiscoveryError} from './model-discovery.mjs';

const key='synthetic-key-123456789';
const api=(provider='deepseek',extra={})=>({provider,apiKey:key,...extra});
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const list=(ids=['deepseek-flash'])=>({object:'list',data:ids.map(id=>({id,object:'model'}))});
function failure(code){return error=>error instanceof ModelDiscoveryError&&error.code===code&&!String(error.stack).includes(key)&&!JSON.stringify(error).includes(key);}

test('models are fetched from approved provider and result only exposes model IDs',async()=>{
  let call;
  const result=await discoverModels(api(),{fetchImpl:async(...args)=>{call=args;return response({...list(),secret:key,extra:'ignored'});}});
  assert.equal(call[0],'https://api.deepseek.com/models');
  assert.equal(call[1].method,'GET');
  assert.equal(call[1].redirect,'error');
  assert.equal(call[1].headers.Authorization,`Bearer ${key}`);
  assert.deepEqual(result.models,[{id:'deepseek-flash'}]);
  assert.equal(result.source,'remote');
  assert.equal(result.baseUrl,'https://api.deepseek.com');
  assert.equal(result.truncated,false);
  assert.ok(Date.parse(result.checkedAt));
  assert.equal(JSON.stringify(result).includes(key),false);
});
for(const [provider,baseUrl,expected] of [
  ['deepseek','https://api.deepseek.com/v1','https://api.deepseek.com/v1/models'],
  ['openai',undefined,'https://api.openai.com/v1/models'],
  ['kimi',undefined,'https://api.moonshot.cn/v1/models'],
  ['kimi','https://api.moonshot.ai/v1','https://api.moonshot.ai/v1/models'],
  ['ollama',undefined,'http://127.0.0.1:11434/v1/models'],
  ['lmstudio','http://localhost:1234/v1','http://127.0.0.1:1234/v1/models'],
])test(`${provider} uses documented model list endpoint ${expected}`,async()=>{
  const result=await discoverModels({provider,baseUrl,...(provider==='ollama'||provider==='lmstudio'?{}:{apiKey:key})},{fetchImpl:async(url,options)=>{
    assert.equal(url,expected);
    if(provider==='ollama'||provider==='lmstudio')assert.equal(Object.hasOwn(options.headers,'Authorization'),false);
    return response(list(['org/model:latest']));
  }});
  assert.deepEqual(result.models,[{id:'org/model:latest'}]);
});
test('Qwen uses same validated origin native list API and paginates without following supplied links',async()=>{
  const calls=[];
  const result=await discoverModels(api('qwen',{baseUrl:'https://workspace-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}),{fetchImpl:async url=>{
    calls.push(url);const page=new URL(url).searchParams.get('page_no');
    return response({success:true,output:{total:2,models:[{model:page==='1'?'qwen-flash':'qwen-plus',name:key}]},next:'https://evil.test'});
  }});
  assert.equal(calls.length,2);
  for(const url of calls){const parsed=new URL(url);assert.equal(parsed.origin,'https://workspace-test.cn-beijing.maas.aliyuncs.com');assert.equal(parsed.pathname,'/api/v1/models');assert.equal(parsed.searchParams.get('capabilities'),'TG');}
  assert.deepEqual(result.models,[{id:'qwen-flash'},{id:'qwen-plus'}]);
});
test('Qwen honors international configured origin',async()=>{
  await discoverModels(api('qwen',{baseUrl:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'}),{fetchImpl:async url=>{
    assert.equal(new URL(url).origin,'https://dashscope-intl.aliyuncs.com');return response({output:{total:0,models:[]}});
  }});
});
for(const provider of ['minimax','doubao','codex','claude','gemini'])test(`${provider} explicitly reports unsupported rather than returning presets`,async()=>{
  let calls=0;
  await assert.rejects(discoverModels(api(provider),{fetchImpl:async()=>{calls++;}}),failure('MODEL_DISCOVERY_UNSUPPORTED'));
  assert.equal(calls,0);
});
for(const input of [null,{},api('unknown'),api('deepseek',{baseUrl:'https://api.deepseek.com.evil.test'}),api('deepseek',{baseUrl:'https://evil.test/v1'}),api('deepseek',{baseUrl:'https://api.deepseek.com/?key=secret'}),api('deepseek',{baseUrl:'https://user:pass@api.deepseek.com'}),api('deepseek',{baseUrl:'http://127.0.0.1:1234/v1'}),api('deepseek',{apiKey:'short'}),api('deepseek',{apiKey:'bad\nnewline-value'}),{provider:'ollama',baseUrl:'http://192.168.1.1:11434/v1'},{provider:'ollama',baseUrl:'http://127.0.0.1:8769/v1'}])test(`invalid configuration rejected before network ${JSON.stringify(input)}`,async()=>{
  let calls=0;await assert.rejects(discoverModels(input,{fetchImpl:async()=>{calls++;}}),failure('MODEL_DISCOVERY_CONFIG'));assert.equal(calls,0);
});
for(const [status,code] of [[401,'AUTH'],[403,'AUTH'],[429,'RATE_LIMIT'],[404,'UNAVAILABLE'],[500,'UNAVAILABLE'],[302,'UNAVAILABLE']])test(`HTTP ${status} discards untrusted error content`,async()=>{
  await assert.rejects(discoverModels(api(),{fetchImpl:async()=>response({error:{message:key}},status)}),failure(`MODEL_DISCOVERY_${code}`));
});
for(const body of [{},[],null,{error:{message:key}},list([key]),{data:[null]},{data:[{}]},list(['<script>bad</script>']),list(['../escape']),list(['https://evil.test']),{success:false,data:[]}])test(`malformed list rejected ${JSON.stringify(body)}`,async()=>{
  await assert.rejects(discoverModels(api(),{fetchImpl:async()=>response(body)}),failure('MODEL_DISCOVERY_RESPONSE'));
});
test('invalid JSON is a sanitized response failure',async()=>{
  await assert.rejects(discoverModels(api(),{fetchImpl:async()=>new Response(`invalid ${key}`)}),failure('MODEL_DISCOVERY_RESPONSE'));
});
test('network exception details and key are discarded',async()=>{
  await assert.rejects(discoverModels(api(),{fetchImpl:async()=>{throw new Error(`secret ${key}`);}}),failure('MODEL_DISCOVERY_NETWORK'));
});
test('fetch timeout returns even if fetch implementation ignores AbortSignal',async()=>{
  let signal;
  await assert.rejects(discoverModels(api(),{timeoutMs:10,fetchImpl:async(_,options)=>{signal=options.signal;return new Promise(()=>{});}}),failure('MODEL_DISCOVERY_TIMEOUT'));
  assert.equal(signal.aborted,true);
});
test('body timeout aborts and does not hang waiting for reader cancellation',async()=>{
  const body=new ReadableStream({start(){},cancel(){return new Promise(()=>{});}});
  await assert.rejects(discoverModels(api(),{timeoutMs:10,fetchImpl:async()=>new Response(body)}),failure('MODEL_DISCOVERY_TIMEOUT'));
});
test('declared response size over limit rejected before reading',async()=>{
  await assert.rejects(discoverModels(api(),{maxResponseBytes:100,fetchImpl:async()=>new Response('{}',{headers:{'content-length':'101'}})}),failure('MODEL_DISCOVERY_RESPONSE'));
});
test('stream body size is bounded without content length',async()=>{
  await assert.rejects(discoverModels(api(),{maxResponseBytes:100,fetchImpl:async()=>response(list(['a'.repeat(120)]))}),failure('MODEL_DISCOVERY_RESPONSE'));
});
test('model IDs deduplicate and limit has explicit truncated status',async()=>{
  const result=await discoverModels(api(),{maxModels:2,fetchImpl:async()=>response(list(['one','one','two','three']))});
  assert.deepEqual(result.models,[{id:'one'},{id:'two'}]);assert.equal(result.truncated,true);
});
test('empty provider list is a real empty list, not substituted presets',async()=>{
  const result=await discoverModels(api(),{fetchImpl:async()=>response(list([]))});assert.deepEqual(result.models,[]);assert.equal(result.source,'remote');
});
test('Qwen invalid total or non-progress page is rejected',async()=>{
  for(const output of [{models:[]},{total:2,models:[]}])await assert.rejects(discoverModels(api('qwen'),{fetchImpl:async()=>response({output})}),failure('MODEL_DISCOVERY_RESPONSE'));
});
test('Qwen page cap is explicit even if provider total never ends',async()=>{
  let calls=0;const result=await discoverModels(api('qwen'),{fetchImpl:async()=>response({output:{total:100000,models:[{model:`qwen-${++calls}`}]}})});
  assert.equal(calls,10);assert.equal(result.truncated,true);
});
test('unexpected followed redirect is rejected and not reissued',async()=>{
  let calls=0;await assert.rejects(discoverModels(api(),{fetchImpl:async()=>{calls++;return {ok:true,redirected:true};}}),failure('MODEL_DISCOVERY_RESPONSE'));assert.equal(calls,1);
});
