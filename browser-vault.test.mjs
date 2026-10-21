import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createBrowserVault} from './extension/browser-vault.js';
const secret='synthetic-browser-key-123456';
function memoryKeys(){let key;return {async getOrCreate(make){return key||=await make();},get key(){return key;}};}
const options=()=>({cryptoImpl:webcrypto,keyStore:memoryKeys()});
test('browser vault encrypts with an actual non-exportable AES-256 key and authenticates provider',async()=>{
  const opts=options(),vault=createBrowserVault(opts),sealed=await vault.seal('deepseek',secret);
  assert.equal(await vault.available(),true);assert.equal(await vault.unseal('deepseek',sealed),secret);
  assert.equal(opts.keyStore.key.extractable,false);assert.equal(opts.keyStore.key.algorithm.length,256);
  assert.equal(JSON.stringify(sealed).includes(secret),false);
  await assert.rejects(webcrypto.subtle.exportKey('raw',opts.keyStore.key));
  await assert.rejects(vault.unseal('openai',sealed),{code:'BROWSER_VAULT_UNAVAILABLE'});
});
test('ciphertext has a fresh random IV and survives recreation with the same key store',async()=>{
  const opts=options(),first=createBrowserVault(opts),a=await first.seal('kimi',secret),b=await first.seal('kimi',secret);
  assert.notEqual(a.iv,b.iv);assert.notEqual(a.ciphertext,b.ciphertext);
  assert.equal(await createBrowserVault(opts).unseal('kimi',a),secret);
});
test('tampering and an unrelated browser-profile key fail closed without plaintext output',async()=>{
  const vault=createBrowserVault(options()),sealed=await vault.seal('openai',secret);
  const bad={...sealed,ciphertext:(sealed.ciphertext[0]==='A'?'B':'A')+sealed.ciphertext.slice(1)};
  for(const action of [()=>vault.unseal('openai',bad),()=>createBrowserVault(options()).unseal('openai',sealed)]){
    await assert.rejects(action(),error=>error.code==='BROWSER_VAULT_UNAVAILABLE'&&!String(error.stack).includes(secret));
  }
});
test('vault rejects malformed records and invalid keys rather than using plaintext fallback',async()=>{
  const vault=createBrowserVault(options());
  for(const value of [null,{},{version:1,backend:'plaintext',iv:'',ciphertext:secret}])await assert.rejects(vault.unseal('deepseek',value));
  for(const value of ['',secret+'\n','short'])await assert.rejects(vault.seal('deepseek',value));
});
test('missing IndexedDB or crypto explicitly reports unavailable',async()=>{
  const noDb=createBrowserVault({cryptoImpl:webcrypto,indexedDBImpl:{}}),noCrypto=createBrowserVault({cryptoImpl:{},keyStore:memoryKeys()});
  assert.equal(await noDb.available(),false);assert.equal(await noCrypto.available(),false);
  await assert.rejects(noDb.seal('deepseek',secret),{code:'BROWSER_VAULT_UNAVAILABLE'});
});
