import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCredentialStore,runCredentialProcess,CredentialStoreError,DPAPI_PROGRAM,validateCredentialEnvelope} from './credential-store.mjs';
import {writerConfigDirectory} from './writer-config.mjs';

const KEY='synthetic-api-key-with-quote-\"-and-backslash-\\';
function macProcess(){
  const records=new Map(),calls=[];
  return {records,calls,async run(command,args,input){
    calls.push({command,args,input});
    if(args.includes('-i')){
      const match=input.match(/^add-generic-password -s ([\w.-]+) -a ([\w-]+) -w ([A-Za-z0-9+/=]+)\n$/u);assert.ok(match);
      records.set(match[2],match[3]);return '';
    }
    const reference=args[args.indexOf('-a')+1];
    if(args[0]==='delete-generic-password'){records.delete(reference);return '';}
    if(!records.has(reference))throw new Error(KEY);return records.get(reference)+'\n';
  }};
}
test('macOS encrypts provider key with random Keychain wrapping key; argv never contains secret and authenticated ciphertext rejects edits',async()=>{
  const fake=macProcess(),store=createCredentialStore({platform:'darwin',runProcess:fake.run});
  const envelope=await store.seal('deepseek',KEY);
  assert.equal(envelope.backend,'macos-keychain');assert.equal(await store.unseal('deepseek',envelope),KEY);
  assert.ok(!JSON.stringify(envelope).includes(KEY));
  assert.ok(fake.calls.every(call=>!JSON.stringify(call.args).includes(KEY)&&!call.input.includes(KEY)));
  assert.ok(fake.calls.find(call=>call.args.includes('-i')).input.length<4096);
  await assert.rejects(store.unseal('openai',envelope),error=>error instanceof CredentialStoreError);
  await assert.rejects(store.unseal('deepseek',{...envelope,ciphertext:Buffer.from('tampered').toString('base64')}),error=>!error.message.includes(KEY));
  await store.discard('deepseek',envelope);assert.equal(fake.records.size,0);
});
test('long credentials fit macOS security stdin line while retaining exact key',async()=>{
  const fake=macProcess(),store=createCredentialStore({platform:'darwin',runProcess:fake.run}),long='x'.repeat(4096);
  assert.equal(await store.unseal('openai',await store.seal('openai',long)),long);
  assert.ok(fake.calls.every(call=>call.input.length<4096));
});
test('Windows DPAPI uses static program, stdin only, CurrentUser scope, and provider-bound entropy',async()=>{
  const calls=[],records=new Map();
  const store=createCredentialStore({platform:'win32',env:{SystemRoot:'C:\\Windows'},runProcess:async(command,args,input)=>{
    calls.push({command,args,input});const request=JSON.parse(input);
    if(request.operation==='protect'){
      const encrypted=Buffer.from('synthetic-encrypted-record-for-'+request.provider).toString('base64');records.set(request.provider+encrypted,request.value);return encrypted;
    }
    const result=records.get(request.provider+request.value);if(!result)throw new Error(KEY);return result;
  }});
  const envelope=await store.seal('qwen',KEY);
  assert.equal(envelope.backend,'windows-dpapi');assert.equal(await store.unseal('qwen',envelope),KEY);
  assert.ok(calls.every(call=>!JSON.stringify(call.args).includes(KEY)&&call.args.at(-1)===DPAPI_PROGRAM));
  assert.ok(DPAPI_PROGRAM.includes('DataProtectionScope]::CurrentUser'));assert.ok(DPAPI_PROGRAM.includes('$request.provider'));
  await assert.rejects(store.unseal('openai',envelope));
});
test('unsupported platform or foreign encrypted record never silently uses plaintext',async()=>{
  const store=createCredentialStore({platform:'linux',runProcess:async()=>{throw new Error('unexpected');}});
  await assert.rejects(store.seal('deepseek',KEY),{code:'CREDENTIAL_STORE_UNSUPPORTED'});
  const fake=macProcess(),mac=createCredentialStore({platform:'darwin',runProcess:fake.run});
  await assert.rejects(mac.unseal('deepseek',{backend:'windows-dpapi',ciphertext:Buffer.alloc(32).toString('base64')}),{code:'CREDENTIAL_STORE_PLATFORM_MISMATCH'});
  assert.equal(fake.calls.length,0);
  assert.throws(()=>validateCredentialEnvelope('openai',{backend:'macos-keychain',reference:'deepseek-00000000-0000-0000-0000-000000000000'}));
});
test('process runner captures but never propagates child stderr or raw error',async()=>{
  const spawnImpl=(_command,_args,options)=>{
    assert.equal(options.shell,false);assert.deepEqual(options.stdio,['pipe','pipe','pipe']);
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.end=input=>{assert.equal(input,KEY);queueMicrotask(()=>{child.stderr.emit('data',Buffer.from(KEY));child.emit('close',1);});};child.kill=()=>{};return child;
  };
  await assert.rejects(runCredentialProcess('test',[],KEY,{spawnImpl}),error=>error.code==='CREDENTIAL_STORE_UNAVAILABLE'&&!error.message.includes(KEY));
});
test('configuration path uses platform data directories rather than macOS paths on Windows',()=>{
  assert.equal(writerConfigDirectory({platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\Test\\AppData\\Local'},home:'C:\\Users\\Test'}),'C:\\Users\\Test\\AppData\\Local\\Jieyiju');
  assert.equal(writerConfigDirectory({platform:'darwin',env:{},home:'/Users/Test'}),'/Users/Test/Library/Application Support/Jieyiju');
});
