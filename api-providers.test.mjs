import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiRunner} from './deepseek-runner.mjs';
import {buildApiPayload} from './api-protocol.mjs';
import {PROVIDERS,normalizeModel,normalizeBaseUrl} from './extension/provider-catalog.js';
const key='provider-fixture-secret-key-123456';
const replies={contextStatus:'sufficient',missingContext:'',candidates:['witty','humor','insight','story'].map((style,i)=>({style,text:`这是中文候选内容第${i}条，有具体观察和自己的看法。`}))};
test('all configured API providers share four-angle parsing with provider-scoped endpoint and parameters',async()=>{
  for(const provider of PROVIDERS.filter(item=>item.kind!=='agent')){
    const model=provider.defaultModel||'local-model:latest';
    const calls=[];
    const runner=new ApiRunner({provider:provider.id,model,apiKey:provider.kind==='local'?undefined:key,fetchImpl:async(url,options)=>{
      calls.push({url,options});return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(replies),reasoning_content:provider.id==='minimax'?'private chain':undefined}}]});
    }});
    await runner.initialize();
    const output=await runner.run({text:'这个观察可以展开聊聊。'},{style:'all'});
    assert.equal(output.candidates.length,4);assert.equal(calls.length,1);
    assert.equal(calls[0].url,provider.baseUrl+'/chat/completions');
    assert.equal(calls[0].options.redirect,'error');
    assert.equal(calls[0].options.headers.authorization,provider.kind==='local'?undefined:`Bearer ${key}`);
    assert.equal(runner.health.writerProvider,provider.id);
    assert.equal(JSON.stringify(output).includes('private chain'),false);
  }
});
test('provider payloads do not send incompatible reasoning or token options',()=>{
  const messages=[{role:'user',content:'JSON'}];
  const openai=buildApiPayload('openai','gpt-5.4-mini',messages);
  assert.equal(openai.reasoning_effort,'none');assert.ok(openai.max_completion_tokens);assert.equal(openai.max_tokens,undefined);
  const kimi=buildApiPayload('kimi','kimi-k2.6',messages);
  assert.equal(kimi.thinking.type,'disabled');assert.equal(kimi.temperature,undefined);
  const k3=buildApiPayload('kimi','kimi-k3',messages);assert.equal(k3.thinking,undefined);assert.equal(k3.reasoning_effort,'low');
  const minimax=buildApiPayload('minimax','MiniMax-M3.1-Flash',messages);
  assert.equal(minimax.thinking,undefined);assert.equal(minimax.reasoning_effort,'low');assert.equal(minimax.response_format,undefined);
  const local=buildApiPayload('ollama','user-model:latest',messages);assert.equal(local.thinking,undefined);assert.equal(local.response_format,undefined);
});
test('model IDs and endpoint validation support official regions and reject URL injection or local network escalation',()=>{
  assert.equal(normalizeModel('ollama','qwen3:8b'),'qwen3:8b');
  for(const model of ['http://untrusted','../model','a/../b','bad model','model\nvalue'])assert.throws(()=>normalizeModel('qwen',model));
  assert.equal(normalizeBaseUrl('qwen','https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(normalizeBaseUrl('ollama','http://localhost:11434/v1/'),'http://127.0.0.1:11434/v1');
  for(const url of ['http://192.168.1.1:11434/v1','http://127.0.0.1:8769/v1','http://127.0.0.1:11434/v1?api_key=secret','http://user:pass@127.0.0.1:11434/v1','http://127.0.0.1:11434/api'])assert.throws(()=>normalizeBaseUrl('ollama',url));
  assert.throws(()=>normalizeBaseUrl('openai','https://example.com/v1'));
});
test('generic API failures are fixed public messages and never leak credentials or upstream text',async()=>{
  const runner=new ApiRunner({provider:'qwen',model:'qwen-flash',apiKey:key,fetchImpl:async()=>Response.json({error:{message:key}},{status:401})});
  await assert.rejects(runner.run({text:'原帖内容'},{style:'all'}),error=>error.code==='API_AUTH_REQUIRED'&&!error.message.includes(key)&&error.message.includes('千问'));
});
test('empty compatibility tool fields are harmless while real or malformed tool calls stay rejected',async()=>{
  for(const fields of [{tool_calls:null},{tool_calls:[]},{function_call:null},{tool_calls:null,function_call:null}]){
    const runner=new ApiRunner({provider:'lmstudio',model:'local-model',fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(replies),...fields}}]})});
    assert.equal((await runner.run({text:'原文内容'},{style:'all'})).candidates.length,4);
  }
  for(const fields of [{tool_calls:[{type:'function',function:{name:'unsafe'}}]},{tool_calls:{}},{function_call:{name:'unsafe'}}]){
    const runner=new ApiRunner({provider:'lmstudio',model:'local-model',fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(replies),...fields}}]})});
    await assert.rejects(runner.run({text:'原文内容'},{style:'all'}),{code:'INVALID_CANDIDATES'});
  }
});
test('unrecognized models never inherit unverified image, JSON or thinking controls',()=>{
  for(const provider of ['deepseek','openai','qwen','kimi','minimax','doubao']){
    const request=buildApiPayload(provider,'future-model-unverified',[{role:'user',content:'JSON'}]);
    assert.equal(request.thinking,undefined);assert.equal(request.enable_thinking,undefined);
    assert.equal(request.reasoning_effort,undefined);assert.equal(request.response_format,undefined);
  }
});
