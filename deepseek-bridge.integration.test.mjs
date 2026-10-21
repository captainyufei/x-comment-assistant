import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {CodexRunner,createWriterRunner,createBridge,PORT,REPLY_PROTOCOL} from './bridge.mjs';
import {DeepSeekRunner} from './deepseek-runner.mjs';
import {publicHealth,normalizeCandidates} from './extension/background-core.js';

const fixtureKey='fixture-deepseek-key-private';
const fixtureToken='fixture-extension-token';
const source={contextKind:'composer-visible',id:null,url:null,author:'@example',
  text:'产品上线前，先找五个真正会用的人聊聊。'};
const reply={understanding:{meaning:'作者建议上线前先与真实用户交流。',signals:['建议'],
  evidence:['先找五个真正会用的人聊聊'],contextStatus:'sufficient',missingContext:'',
  replyAction:'认可上线前听取真实需求，并补充早发现问题的价值。'},
  candidates:[{style:'insight',label:'先听需求',text:'早点听到别人为什么不用，比上线后盯着访问量猜原因更有用。五个人不能代表所有用户，但能先把明显的问题问出来。'}]};

async function configDir(t,provider){
  const appDir=await mkdtemp(join(tmpdir(),'jieyiju-deepseek-bridge-'));
  t.after(()=>rm(appDir,{recursive:true,force:true}));
  if(provider){
    await writeFile(join(appDir,'writer-config.json'),JSON.stringify({version:1,provider,model:'deepseek-flash'}),{mode:0o600});
    await writeFile(join(appDir,'deepseek-api-key'),fixtureKey,{mode:0o600});
  }
  return appDir;
}

function request(bridge,{method='GET',path='/health',body}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.method=method;req.url=path;req.headers={host:`127.0.0.1:${PORT}`,
    'x-reply-bridge-token':fixtureToken,'x-reply-protocol':REPLY_PROTOCOL,
    ...(body!==undefined?{'content-type':'application/json'}:{})};
  return new Promise(resolve=>{
    let status;
    const res={setHeader(){},writeHead(code){status=code;},end(bytes=''){resolve({status,data:JSON.parse(String(bytes))});}};
    bridge.server.emit('request',req,res);
  });
}

test('factory defaults to Codex and does not switch merely because an API key exists',async t=>{
  const runner=await createWriterRunner({appDir:await configDir(t),env:{DEEPSEEK_API_KEY:fixtureKey}});
  assert(runner instanceof CodexRunner);
});

test('DeepSeek factory initializes without Codex and protocol 4 preserves an explicitly requested legacy mix candidate',async t=>{
  let calls=0;
  const runner=await createWriterRunner({appDir:await configDir(t,'deepseek'),env:{},
    codexOptions:{spawnImpl(){throw new Error('Codex must not run');}},
    deepseekOptions:{fetchImpl:async(url,options)=>{
      calls++;
      assert.equal(url,'https://api.deepseek.com/chat/completions');
      assert.equal(JSON.parse(options.body).thinking.type,'disabled');
      return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(reply)}}]});
    }}});
  assert(runner instanceof DeepSeekRunner);
  await runner.initialize(); assert.equal(calls,0);
  assert.equal(publicHealth(runner.health).authentication,'DeepSeek API');
  const bridge=createBridge({runner,token:fixtureToken});
  t.after(()=>bridge.stop());
  const health=(await request(bridge)).data;
  assert.equal(health.writerProvider,'deepseek');
  assert.equal(health.writerReasoningEffort,'disabled');
  assert(!JSON.stringify(health).includes(fixtureKey));
  const started=await request(bridge,{method:'POST',path:'/jobs',body:{context:source,preferences:{style:'mix'}}});
  assert.equal(started.status,202);
  await bridge.jobs.get(started.data.job.id).settlement;
  const completed=await request(bridge,{path:`/jobs/${started.data.job.id}`});
  assert.equal(completed.data.job.status,'completed');
  const accepted=normalizeCandidates(completed.data.job.candidates,completed.data.job.context,
    {inline:true,understanding:completed.data.job.understanding,style:'mix'});
  assert.equal(accepted[0].text,reply.candidates[0].text);
  assert.equal(calls,1);
  assert(!JSON.stringify(completed).includes(fixtureKey));
});

test('protocol 4 default generates all four compact replies in one DeepSeek call through factory, runner, bridge and extension normalization',async t=>{
  const rawCandidates = [
    {style:'story',text:'比如试用的人反复找入口，作者才发现按钮藏得太深。聊半小时功能，不如看他真正用五分钟，卡住的地方可能就露出来了。'},
    {style:'humor',text:'先让五个人泼点冷水，省得上线以后，只有服务器在热情响应。有人肯说哪里难用，总比一句“挺好的”更好改。'},
    {style:'witty',text:'这步值得做。早点听到“我为什么不用”，比上线后盯着访问量猜原因有用，也能少做几个只有自己喜欢的功能。'},
    {style:'insight',text:'可以请对方直接操作一次。嘴上说想要某个功能很容易，在哪一步停下来、找不到入口，往往才是应该先改的地方。'},
  ];
  let calls=0;
  const runner=await createWriterRunner({appDir:await configDir(t,'deepseek'),env:{},
    codexOptions:{spawnImpl(){throw new Error('Compact DeepSeek generation must not invoke Codex');}},
    deepseekOptions:{fetchImpl:async(url,options)=>{
      calls++;
      assert.equal(url,'https://api.deepseek.com/chat/completions');
      const body=JSON.parse(options.body);
      assert.equal(body.thinking.type,'disabled');
      assert.deepEqual(body.response_format,{type:'json_object'});
      assert.equal(body.stream,false);
      assert.match(body.messages[0].content,/contextStatus/u);
      assert.doesNotMatch(body.messages[0].content,/顶层恰好 understanding 和 candidates/u,'the adapter must not override the compact task with the legacy schema');
      const prompt=typeof body.messages[1].content==='string'?body.messages[1].content:body.messages[1].content[0].text;
      assert.match(prompt,/"requestedStyle":"all"/u);
      assert.doesNotMatch(prompt,/RETIRED_CONTEXT_MARKER/u);
      return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({contextStatus:'sufficient',missingContext:'',candidates:rawCandidates})}}]});
    }}});
  await runner.initialize();
  const bridge=createBridge({runner,token:fixtureToken});t.after(()=>bridge.stop());
  assert.equal(REPLY_PROTOCOL,'4');
  assert.equal((await request(bridge)).data.replyProtocol,'4');
  assert.equal(calls,0,'initialization and health never generate replies');
  const started=await request(bridge,{method:'POST',path:'/jobs',body:{context:source,preferences:{contextNote:{retired:'RETIRED_CONTEXT_MARKER'}}}});
  assert.equal(started.status,202);
  assert.equal(started.data.job.preferences.style,'all');
  assert.equal(Object.hasOwn(started.data.job.preferences,'contextNote'),false);
  await bridge.jobs.get(started.data.job.id).settlement;
  const completed=await request(bridge,{path:`/jobs/${started.data.job.id}`});
  assert.equal(completed.data.job.status,'completed');
  assert.equal(completed.data.job.contextStatus,'sufficient');
  assert.equal(completed.data.job.missingContext,'');
  assert.equal(Object.hasOwn(completed.data.job,'understanding'),false);
  const accepted=normalizeCandidates(completed.data.job.candidates,completed.data.job.context,
    {inline:true,style:'all',contextStatus:completed.data.job.contextStatus,missingContext:completed.data.job.missingContext});
  assert.deepEqual(accepted.map(item=>item.style),['witty','humor','insight','story']);
  assert.deepEqual(accepted.map(item=>item.label),['认可并展开','幽默接梗','补充观点','换个角度']);
  assert.equal(accepted.length,4);
  assert.ok(accepted.every(item=>item.context.author===source.author&&item.context.id===null&&[...item.text].length<=140));
  assert.equal(calls,1,'four choices require exactly one upstream request');
  assert.equal(JSON.stringify(completed).includes(fixtureKey),false);
  assert.equal(JSON.stringify(completed).includes(fixtureToken),false);
});

test('compact missing-video result crosses the DeepSeek and extension boundary with zero replies instead of inventing four',async t=>{
  let calls=0;
  const gap='缺少原帖视频对白，无法判断“真是天才”是在夸赞还是反讽。';
  const runner=await createWriterRunner({appDir:await configDir(t,'deepseek'),env:{},
    deepseekOptions:{fetchImpl:async()=>{
      calls++;
      return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({contextStatus:'missing',missingContext:gap,candidates:[]})}}]});
    }}});
  await runner.initialize();
  const bridge=createBridge({runner,token:fixtureToken});t.after(()=>bridge.stop());
  const started=await request(bridge,{method:'POST',path:'/jobs',body:{context:{...source,text:'真是天才。',hasMedia:true}}});
  assert.equal(started.status,202);
  await bridge.jobs.get(started.data.job.id).settlement;
  const completed=await request(bridge,{path:`/jobs/${started.data.job.id}`});
  assert.equal(completed.data.job.status,'completed');
  assert.equal(completed.data.job.contextStatus,'missing');
  assert.equal(completed.data.job.missingContext,gap);
  assert.equal(completed.data.job.understanding,undefined);
  assert.deepEqual(normalizeCandidates(completed.data.job.candidates,completed.data.job.context,
    {inline:true,style:'all',contextStatus:completed.data.job.contextStatus,missingContext:completed.data.job.missingContext}),[]);
  assert.equal(calls,1);
});

test('provider authentication errors remain helpful and secret-free across the bridge',async t=>{
  const runner=await createWriterRunner({appDir:await configDir(t,'deepseek'),env:{},
    deepseekOptions:{fetchImpl:async()=>new Response(fixtureKey,{status:401})}});
  await runner.initialize();
  const bridge=createBridge({runner,token:fixtureToken});t.after(()=>bridge.stop());
  const started=await request(bridge,{method:'POST',path:'/jobs',body:{context:source,preferences:{style:'mix'}}});
  await bridge.jobs.get(started.data.job.id).settlement;
  const failed=await request(bridge,{path:`/jobs/${started.data.job.id}`});
  assert.equal(failed.data.job.status,'failed');
  assert.equal(failed.data.job.code,'DEEPSEEK_AUTH_REQUIRED');
  assert.match(failed.data.job.error,/DeepSeek API Key/u);
  assert(!JSON.stringify(failed).includes(fixtureKey));
});
