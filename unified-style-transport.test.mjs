import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable, PassThrough, Writable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import {REPLY_STYLE_IDS, REPLY_STYLE_LABELS} from './reply-styles.mjs';
import {TONE_PRESETS, REPLY_PROTOCOL_VERSION, generationPreferences, validatePreferences, normalizeCandidates} from './extension/background-core.js';
import {BridgeError, CodexRunner, createBridge, validateInput, PORT, REPLY_PROTOCOL} from './bridge.mjs';
import {DeepSeekRunner} from './deepseek-runner.mjs';
import {AgentRunner, claudeWriterArgs} from './agent-runner.mjs';

const SOURCE = {id:'1234567890123456789',url:'https://x.com/style_fixture/status/1234567890123456789',author:'@style_fixture',
  text:'上线之前，先让真正会用的人试一次，看看他们到底卡在哪里。'};
const SLOTS = ['witty','humor','insight','story'];
const TOKEN = 'unified-style-local-test-token';
const KEY = 'unified-style-test-key-private';
const response = (styles = ['chat','agree','professional','perspective']) => ({contextStatus:'sufficient',missingContext:'',candidates:SLOTS.map((style,i)=>({
  style,replyStyle:styles[i],label:'不可信上游标签',text:[
    '先看别人实际怎么用，确实比自己觉得顺手更有用。人停在哪一步，问题往往就藏在哪里。',
    '这步很值。别人愿意指出哪里难用，才有机会在上线之前把明显的问题改掉。',
    '可以记录对方在哪一步停下来，再确认是入口不好找，还是功能本身没有满足需要。',
    '试用时也值得看看对方原来怎么解决这个问题，可能会发现真正要改的不是按钮的位置。',
  ][i],
}))});
const options = {style:'all',contextStatus:'sufficient',missingContext:''};

function request(bridge, {method='GET',path='/health',body,protocol=REPLY_PROTOCOL}={}) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.method=method;req.url=path;req.headers={host:`127.0.0.1:${PORT}`,'x-reply-bridge-token':TOKEN,
    'x-reply-protocol':protocol,...(body===undefined?{}:{'content-type':'application/json'})};
  return new Promise(resolve=>{
    let status;const res={setHeader(){},writeHead(code){status=code;},end(bytes=''){resolve({status,data:JSON.parse(String(bytes))});}};
    bridge.server.emit('request',req,res);
  });
}

function subprocessWriter(kind, output, calls) {
  return (_executable,args,settings)=>{
    const child=new EventEmitter();child.pid=2_147_483_647;child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>true;
    const call={args,settings,input:''};calls.push(call);
    child.stdin=new Writable({write(chunk,_encoding,next){call.input+=chunk.toString('utf8');next();},final(next){
      next();
      (async()=>{
        if(kind==='codex'){
          call.schema=JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8'));
          await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(output));
        } else child.stdout.write(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify(output)})+'\n');
        child.stdout.end();child.stderr.end();child.emit('close',0);
      })().catch(error=>child.emit('error',error));
    }});
    return child;
  };
}

async function fixtureRunner(kind, output, calls) {
  if(kind==='deepseek'){
    const runner=new DeepSeekRunner({apiKey:KEY,model:'deepseek-flash',BridgeError,fetchImpl:async(_url,settings)=>{
      calls.push(JSON.parse(settings.body));return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}]});
    }});
    await runner.initialize();return runner;
  }
  if(kind==='codex')return new CodexRunner({codexPath:'/fixture/codex',spawnImpl:subprocessWriter(kind,output,calls)});
  const runner=new AgentRunner({model:'haiku',BridgeError,resolveAgentPathImpl:async()=>'/fixture/claude',
    statImpl:async()=>{const error=new Error('absent');error.code='ENOENT';throw error;},
    execFileImpl:async(_path,args)=>({stdout:args[0]==='--version'?'fixture-version':claudeWriterArgs('haiku').join(' ')}),
    spawnImpl:subprocessWriter(kind,output,calls)});
  await runner.initialize();return runner;
}

test('unified presets share one eight-style catalogue and carry explicit auto/manual selection without mutating custom preferences',()=>{
  assert.equal(REPLY_PROTOCOL_VERSION,'4');assert.equal(REPLY_PROTOCOL,'4');
  assert.deepEqual(Object.keys(TONE_PRESETS),['auto',...REPLY_STYLE_IDS]);assert.equal(TONE_PRESETS.auto,'');
  const original={style:'mix',tone:'用户原来的表达习惯',personalExperience:'用户提供的真实经历'};
  for(const tonePreset of ['auto',...REPLY_STYLE_IDS]){
    const preferences=generationPreferences(original,{enabled:true,tonePreset});
    assert.equal(preferences.tonePreset,tonePreset);assert.equal(preferences.style,'all');
    assert.equal(preferences.personalExperience,original.personalExperience);
    assert.equal(validatePreferences(preferences).tonePreset,tonePreset);
    assert.equal(validateInput({context:SOURCE,preferences}).preferences.tonePreset,tonePreset);
  }
  assert.deepEqual(original,{style:'mix',tone:'用户原来的表达习惯',personalExperience:'用户提供的真实经历'});
  assert.equal(Object.hasOwn(validatePreferences(original),'tonePreset'),false,'legacy preferences remain distinct from an explicit automatic request');
  for(const tonePreset of ['',null,{},'story','auto-send','professional ']){
    assert.throws(()=>validatePreferences({...original,tonePreset}));
    assert.throws(()=>validateInput({context:SOURCE,preferences:{...original,tonePreset}}));
  }
});

test('public new candidates use canonical matching labels while historical candidates never gain a guessed unified style',()=>{
  const incoming=response().candidates;
  const normalized=normalizeCandidates(incoming,SOURCE,options);
  assert.deepEqual(normalized.map(item=>item.replyStyle),['chat','agree','professional','perspective']);
  assert.deepEqual(normalized.map(item=>item.label),['日常聊天','认可共鸣','理性专业','换个角度']);
  assert.equal(JSON.stringify(normalized).includes('不可信'),false);
  assert.throws(()=>normalizeCandidates(incoming.map(item=>({...item,replyStyle:'auto'})),SOURCE,options));
  assert.throws(()=>normalizeCandidates(incoming,SOURCE,{...options,tonePreset:'professional'}));
  const old=incoming.map(({replyStyle,...item})=>({...item,label:'历史回复角度'}));
  const restored=normalizeCandidates(old,SOURCE,{...options,tonePreset:'auto'});
  assert.ok(restored.every(item=>!Object.hasOwn(item,'replyStyle')&&item.label==='历史回复角度'));
});

for(const kind of ['deepseek','codex','claude']){
  test(`${kind} keeps actual unified styles through one writer and rejects missing or mismatched live style metadata`,async t=>{
    for(const [tonePreset,styles] of [['auto',['chat','agree','professional','perspective']],['professional',Array(4).fill('professional')]]){
      const calls=[],runner=await fixtureRunner(kind,response(styles),calls);
      const parsed=await runner.run({...SOURCE},{style:'all',tonePreset},new AbortController().signal);
      assert.equal(calls.length,1,'understanding and style matching use the same single generation');
      assert.deepEqual(parsed.candidates.map(item=>item.replyStyle),styles);
      assert.deepEqual(parsed.candidates.map(item=>item.label),styles.map(id=>REPLY_STYLE_LABELS[id]));
      if(kind==='codex')assert.deepEqual(calls[0].schema.properties.candidates.items.properties.replyStyle.enum,REPLY_STYLE_IDS);
    }
    for(const output of [response(),{...response(),candidates:response().candidates.map(({replyStyle,...rest})=>rest)}]){
      const calls=[],runner=await fixtureRunner(kind,output,calls);
      await assert.rejects(runner.run({...SOURCE},{style:'all',tonePreset:'professional'},new AbortController().signal),{code:'INVALID_CANDIDATES'});
      assert.equal(calls.length,1,'invalid output is reported without another hidden model call');
    }
  });
}

test('protocol 4 job preserves auto style metadata across API, bridge and extension; cached protocol 3 cannot strip the contract',async t=>{
  const calls=[],runner=await fixtureRunner('deepseek',response(),calls);
  const bridge=createBridge({runner,token:TOKEN});t.after(()=>bridge.stop());
  const preferences=generationPreferences({style:'all',tone:''},{enabled:true,tonePreset:'auto'});
  const stale=await request(bridge,{method:'POST',path:'/jobs',body:{context:SOURCE,preferences},protocol:'3'});
  assert.equal(stale.status,409);assert.equal(stale.data.code,'EXTENSION_UPDATE_REQUIRED');assert.equal(calls.length,0);
  const started=await request(bridge,{method:'POST',path:'/jobs',body:{context:SOURCE,preferences}});
  assert.equal(started.status,202);assert.equal(started.data.job.preferences.tonePreset,'auto');
  await bridge.jobs.get(started.data.job.id).settlement;
  const completed=await request(bridge,{path:`/jobs/${started.data.job.id}`});
  assert.equal(completed.data.job.status,'completed');assert.equal(calls.length,1);
  const accepted=normalizeCandidates(completed.data.job.candidates,SOURCE,{...options,tonePreset:'auto'});
  assert.deepEqual(accepted.map(item=>item.replyStyle),['chat','agree','professional','perspective']);
  assert.equal(JSON.stringify(completed).includes(KEY),false);
});
