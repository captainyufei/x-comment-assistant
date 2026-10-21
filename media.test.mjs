import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateMedia,publicMediaEvidence} from './extension/media-core.js';
import {prepareMedia} from './media.js';
import {validateInput,CodexRunner,codexArgs} from './bridge.mjs';
import {validateInlineContext,validatePreferences} from './extension/background-core.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WkAAAAASUVORK5CYII=', 'base64');
const image = {kind:'image',url:'https://pbs.twimg.com/media/example.png?format=png&name=small',alt:'原帖里的具体画面'};
const poster = {kind:'video-poster',url:'https://pbs.twimg.com/ext_tw_video_thumb/12345/pu/img/example.jpg',alt:''};
const context = {id:'1234567890123456',url:'https://x.com/example/status/1234567890123456',text:'原帖文字',media:[image],hasMedia:true};
async function temp(t) { const dir=await mkdtemp(join(tmpdir(),'reply-media-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; }
const response = bytes => new Response(bytes,{headers:{'content-type':'image/png'}});
const fourImages = () => Array.from({length:4},(_,i)=>({...image,url:`https://pbs.twimg.com/media/concurrent${i}.png`}));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

test('public post media validation rejects arbitrary network destinations, credentials and excess files', () => {
  assert.deepEqual(validateMedia([image]),[image]);
  for (const url of ['http://pbs.twimg.com/media/a.png','https://127.0.0.1/media/a.png','https://pbs.twimg.com.evil.example/media/a.png','https://user:pass@pbs.twimg.com/media/a.png','https://pbs.twimg.com:4433/media/a.png','https://pbs.twimg.com/profile_images/a.png','https://pbs.twimg.com/media/a.png?token=secret','https://pbs.twimg.com/media/a.png#secret']) assert.throws(()=>validateMedia([{kind:'image',url}]));
  assert.throws(()=>validateMedia(Array.from({length:5},(_,i)=>({...image,url:`https://pbs.twimg.com/media/file${i}.png`}))));
  assert.throws(()=>validateMedia([image,image]));
  assert.throws(()=>validateMedia([{...image,kind:'video'}]));
});

test('pure image context requires actual validated media, not a hasMedia flag or forged evidence', () => {
  assert.equal(validateInput({context:{...context,text:''}}).context.text,'');
  assert.throws(()=>validateInput({context:{...context,text:'',media:[],mediaEvidence:{images:4}}}));
  const validated=validateInput({context:{...context,mediaEvidence:{images:4,videoFrames:4}}});
  assert.equal(validated.context.mediaEvidence,undefined);
  assert.equal(validateInlineContext({contextKind:'composer-visible',id:null,url:null,author:'@example',text:'',media:[image]}).media.length,1);
});

test('all requests strip retired context notes while explicit legacy mix keeps the bounded compatibility field', () => {
  const legacy=validatePreferences({style:'mix',contextNote:'  视频最后是在开玩笑  ',secret:'x'});
  assert.equal(legacy.contextNote,'视频最后是在开玩笑');
  assert.equal(legacy.secret,undefined);
  assert.throws(()=>validatePreferences({style:'mix',contextNote:'字'.repeat(1201)}));
  assert.equal(validateInput({context,preferences:{style:'mix',contextNote:'接一句吐槽'}}).preferences.contextNote,'接一句吐槽');
  assert.throws(()=>validateInput({context,preferences:{style:'mix',contextNote:'字'.repeat(1201)}}));
  for(const contextNote of ['接一句吐槽','字'.repeat(1201),{retired:'不再读取的旧输入'}]) {
    const current=validateInput({context,preferences:{contextNote,secret:'x'}});
    assert.equal(current.preferences.style,'all');
    assert.equal(Object.hasOwn(current.preferences,'contextNote'),false);
    assert.equal(current.preferences.secret,undefined);
  }
});

test('media download saves a private image attachment and counts only actual successfully read pixels', async t => {
  const dir=await temp(t);const calls=[];
  const result=await prepareMedia({...context,media:[image,poster]},dir,{fetchImpl:async(url,options)=>{calls.push({url,options});return response(png);}});
  assert.equal(result.paths.length,2);
  assert.deepEqual(result.evidence,{images:1,videoFrames:0,videoPosters:1,altTexts:[image.alt],limitations:['视频仅读取封面，未读取连续画面、台词或声音。'],attachments:[{index:1,kind:'image'},{index:2,kind:'video-poster'}]});
  assert.deepEqual(await readFile(result.paths[0]),png);
  assert.equal((await stat(result.paths[0])).mode & 0o777,0o600);
  for(const {options} of calls) {assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.deepEqual(Object.keys(options.headers),['accept']);}
});

test('missing, redirected and non-image media degrade explicitly without claiming it was seen', async t => {
  const dir=await temp(t);
  for(const fetchImpl of [async()=>{throw new Error('private network detail');},async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/'}}),async()=>new Response('<html>',{headers:{'content-type':'text/html'}}),async()=>response(Buffer.from('invalid image'))]) {
    const result=await prepareMedia(context,dir,{fetchImpl});
    assert.equal(result.paths.length,0);assert.equal(result.evidence.images,0);
    assert.match(result.evidence.limitations[0],/图片未能读取/);assert.equal(JSON.stringify(result).includes('private network detail'),false);
  }
});

test('declared size and streamed size bounds reject large image bodies before they become attachments', async t => {
  const dir=await temp(t);
  const declared=await prepareMedia(context,dir,{fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png','content-length':String(4*1024*1024+1)}})});
  assert.equal(declared.paths.length,0);
  const streamed=await prepareMedia(context,dir,{fetchImpl:async()=>response(Buffer.alloc(4*1024*1024+1))});
  assert.equal(streamed.paths.length,0);
});

test('total media byte limit is shared across the selected post and never attaches more than four files', async t => {
  const dir=await temp(t);const large=Buffer.alloc(4*1024*1024);png.copy(large);
  const result=await prepareMedia({...context,media:Array.from({length:4},(_,i)=>({...image,url:`https://pbs.twimg.com/media/item${i}.png`}))},dir,{fetchImpl:async()=>response(large)});
  assert.equal(result.paths.length,3);assert.equal(result.evidence.images,3);assert.equal(result.evidence.limitations.length,1);
});

test('canceling a media preparation prevents downloads and reports no fabricated evidence', async t => {
  const dir=await temp(t);const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(prepareMedia(context,dir,{signal:controller.signal,fetchImpl:async()=>{calls++;return response(png);}}));assert.equal(calls,0);
});

test('Codex receives attachment paths through explicit image flags while source remains stdin-only', () => {
  const args=codexArgs({schema:'s',output:'o',instructions:'w',images:['/private/tmp/one.png','/private/tmp/two.jpg']},new Set());
  assert.deepEqual(args.slice(-5),['--image','/private/tmp/one.png','--image','/private/tmp/two.jpg','-']);
});

test('image-only failed download never starts the writing process or fabricates generic replies', async () => {
  let spawns=0;const runner=new CodexRunner({fetchImpl:async()=>{throw new Error('unavailable');},spawnImpl:()=>{spawns++;throw new Error('unexpected');}});
  await assert.rejects(runner.run({...context,text:'',mediaEvidence:{images:4}}, {style:'mix'},new AbortController().signal),error=>error.code==='MEDIA_UNAVAILABLE');assert.equal(spawns,0);
});

test('public evidence is bounded and strips internal paths or arbitrary extra fields', () => {
  assert.deepEqual(publicMediaEvidence({images:1,videoFrames:-1,videoPosters:9,altTexts:['画面'],limitations:['读取限制'],paths:['secret']}),{images:1,videoFrames:0,videoPosters:0,altTexts:['画面'],limitations:['读取限制']});
});

test('two workers overlap requests, stay bounded and return successful attachments in original input order', async t => {
  const dir=await temp(t);
  const pending=Array.from({length:4},deferred);
  const started=Array.from({length:4},deferred);
  const controller=new AbortController();t.after(()=>controller.abort());
  const media=fourImages().map((item,i)=>({...item,kind:i%2?'video-poster':'image'}));
  let calls=0,active=0,maxActive=0;
  const preparation=prepareMedia({...context,media},dir,{signal:controller.signal,fetchImpl:async()=>{
    const index=calls++;active++;maxActive=Math.max(maxActive,active);started[index].resolve();
    try { return await pending[index].promise; } finally {active--;}
  }});
  await Promise.all([started[0].promise,started[1].promise]);
  assert.equal(calls,2);
  pending[1].resolve(response(png));
  await started[2].promise;
  pending[2].resolve(response(Buffer.from('not an actual image')));
  await started[3].promise;
  pending[3].resolve(response(png));
  pending[0].resolve(response(png));
  const result=await preparation;
  assert.equal(maxActive,2);
  assert.deepEqual(result.paths.map(path=>path.split('/').pop()),['original-1.png','original-2.png','original-4.png']);
  assert.deepEqual(result.evidence.attachments,[{index:1,kind:'image'},{index:2,kind:'video-poster'},{index:3,kind:'video-poster'}]);
  assert.equal(result.evidence.images,1);assert.equal(result.evidence.videoPosters,2);
  assert.match(result.evidence.limitations[0],/第 3 张图片未能读取/);
});

test('active streamed buffers share the total budget before either parallel download is committed', async t => {
  const dir=await temp(t);const MiB=1024*1024;
  const large=Buffer.alloc(4*MiB);png.copy(large);
  const thirdWaiting=deferred(),finishThird=deferred();
  let calls=0,overBudgetCanceled=0;
  const result=await prepareMedia({...context,media:fourImages()},dir,{fetchImpl:async()=>{
    const index=calls++;
    if(index<2)return response(large);
    if(index===2){
      let reads=0;
      return {ok:true,headers:new Headers({'content-type':'image/png'}),body:{
        getReader:()=>({read:async()=>{
          reads++;
          if(reads===1)return {done:false,value:large.subarray(0,3*MiB)};
          if(reads===2){thirdWaiting.resolve();return finishThird.promise;}
          return {done:true};
        },cancel:async()=>{},releaseLock:()=>{}}),cancel:async()=>{},
      }};
    }
    await thirdWaiting.promise;
    return {ok:true,headers:new Headers({'content-type':'image/png'}),body:{
      getReader:()=>({read:async()=>({done:false,value:large.subarray(0,3*MiB)}),cancel:async()=>{
        overBudgetCanceled++;
        finishThird.resolve({done:false,value:large.subarray(3*MiB)});
      },releaseLock:()=>{}}),cancel:async()=>{},
    }};
  }});
  assert.equal(calls,4);assert.equal(overBudgetCanceled,1);
  assert.deepEqual(result.paths.map(path=>path.split('/').pop()),['original-1.png','original-2.png','original-3.png']);
  assert.equal((await Promise.all(result.paths.map(stat))).reduce((total,file)=>total+file.size,0),12*MiB);
  assert.match(result.evidence.limitations[0],/第 4 张图片未能读取/);
});

test('failed image bytes release their reservation so three valid four-megabyte images still fit', async t => {
  const dir=await temp(t);const large=Buffer.alloc(4*1024*1024);png.copy(large);let calls=0;
  const result=await prepareMedia({...context,media:fourImages()},dir,{fetchImpl:async()=>{
    const index=calls++;return response(index===0?Buffer.alloc(large.length):large);
  }});
  assert.equal(result.paths.length,3);
  assert.deepEqual(result.paths.map(path=>path.split('/').pop()),['original-2.png','original-3.png','original-4.png']);
  assert.equal(result.evidence.images,3);
  assert.equal(result.evidence.limitations.length,1);
});

test('caller cancellation stops both active readers, skips queued media and creates no attachments', async t => {
  const dir=await temp(t);const controller=new AbortController();const reading=Array.from({length:2},deferred);
  const requests=[];let canceled=0;
  const preparation=prepareMedia({...context,media:fourImages()},dir,{signal:controller.signal,fetchImpl:async(url,options)=>{
    const index=requests.length;requests.push({url,options});let reads=0;
    return {ok:true,headers:new Headers({'content-type':'image/png'}),body:{getReader:()=>({
      read:()=>{if(reads++===0)return Promise.resolve({done:false,value:png});reading[index].resolve();return new Promise(()=>{});},
      cancel:async()=>{canceled++;},releaseLock:()=>{},
    }),cancel:async()=>{}}};
  }});
  await Promise.all(reading.map(item=>item.promise));
  const reason=new Error('user stopped this draft');controller.abort(reason);
  await assert.rejects(preparation,error=>error===reason);
  assert.equal(requests.length,2);assert.equal(canceled,2);
  assert.ok(requests.every(({options})=>options.signal.aborted));
  assert.deepEqual(await readdir(dir),[]);
});

test('batch deadline bounds unresponsive fetches and does not start queued media after timeout', async t => {
  const dir=await temp(t);const requests=[];const late=[];const start=Date.now();
  const result=await prepareMedia({...context,media:fourImages()},dir,{imageTimeoutMs:1000,batchTimeoutMs:25,fetchImpl:(url,options)=>{
    requests.push({url,options});const future=deferred();late.push(future);return future.promise;
  }});
  assert.ok(Date.now()-start<800,'the unresponsive fetch must not determine the batch duration');
  assert.equal(requests.length,2);assert.ok(requests.every(({options})=>options.signal.aborted));
  assert.equal(result.paths.length,0);assert.equal(result.evidence.images,0);
  assert.equal(result.evidence.limitations.length,4);
  let lateCanceled=0;
  for(const future of late)future.resolve({body:{cancel:async()=>{lateCanceled++;}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(lateCanceled,2);assert.deepEqual(await readdir(dir),[]);
});

test('per-image deadlines allow queued items to run while the whole batch remains bounded', async t => {
  const dir=await temp(t);let calls=0;
  const result=await prepareMedia({...context,media:fourImages()},dir,{imageTimeoutMs:15,batchTimeoutMs:250,fetchImpl:()=>{
    calls++;return new Promise(()=>{});
  }});
  assert.equal(calls,4);assert.equal(result.paths.length,0);assert.equal(result.evidence.limitations.length,4);
});

test('invalid test timeout overrides cannot remove the production deadline', async t => {
  const dir=await temp(t);
  for(const value of [0,-1,NaN,Infinity,1.5,'1',120001]){
    await assert.rejects(prepareMedia(context,dir,{imageTimeoutMs:value}),/超时预算无效/);
    await assert.rejects(prepareMedia(context,dir,{batchTimeoutMs:value}),/超时预算无效/);
  }
});
