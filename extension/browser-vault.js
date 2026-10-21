/** Browser-local protection, not an OS credential vault or a sync store.
 * A non-exportable AES key lives in this extension's IndexedDB; chrome.storage
 * contains only authenticated ciphertext. Losing the browser profile loses it.
 */
export const BROWSER_VAULT_BACKEND = 'browser-aes-gcm';
const DB_NAME = 'x-comment-assistant-vault';
const KEY_ID = 'aes-gcm-v1';
const failure = () => Object.assign(new Error('浏览器本机密钥存储不可用，请检查浏览器配置或重新填写密钥。'), {code:'BROWSER_VAULT_UNAVAILABLE'});
const encode = bytes => {let result='';for(const byte of bytes)result+=String.fromCharCode(byte);return btoa(result);};
function decode(value,max){
  if(typeof value!=='string'||value.length>max||! /^[A-Za-z0-9+/]*={0,2}$/u.test(value))throw failure();
  try{return Uint8Array.from(atob(value),x=>x.charCodeAt(0));}catch{throw failure();}
}
function browserKeyStore(indexedDBImpl){
  let connection;
  const open = () => connection ||= new Promise((resolve,reject)=>{
    if(!indexedDBImpl?.open){reject(failure());return;}
    const request=indexedDBImpl.open(DB_NAME,1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('keys'))request.result.createObjectStore('keys');};
    request.onerror=()=>reject(failure());request.onblocked=()=>reject(failure());request.onsuccess=()=>resolve(request.result);
  });
  return {async getOrCreate(make){
    const db=await open();
    const existing=await new Promise((resolve,reject)=>{const tx=db.transaction('keys','readonly');const request=tx.objectStore('keys').get(KEY_ID);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(failure());tx.onabort=()=>reject(failure());});
    if(existing)return existing;
    const generated=await make();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('keys','readwrite'),store=tx.objectStore('keys'),request=store.get(KEY_ID);let selected;
      request.onsuccess=()=>{selected=request.result||generated;if(!request.result)store.put(generated,KEY_ID);};
      tx.oncomplete=()=>resolve(selected);tx.onerror=()=>reject(failure());tx.onabort=()=>reject(failure());
    });
  }};
}

export function createBrowserVault({cryptoImpl=globalThis.crypto,indexedDBImpl=globalThis.indexedDB,keyStore}={}){
  const store=keyStore||browserKeyStore(indexedDBImpl);let keyPromise;
  const key=()=>keyPromise ||= Promise.resolve().then(async()=>{
    if(!cryptoImpl?.subtle||!cryptoImpl?.getRandomValues)throw failure();
    const value=await store.getOrCreate(()=>cryptoImpl.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']));
    if(value?.type!=='secret'||value.extractable!==false||value.algorithm?.name!=='AES-GCM'||value.algorithm?.length!==256)throw failure();
    return value;
  }).catch(()=>{keyPromise=undefined;throw failure();});
  const aad=provider=>{
    if(typeof provider!=='string'||!/^[a-z][a-z0-9-]{1,40}$/u.test(provider))throw failure();
    return new TextEncoder().encode(`x-comment-assistant:browser-vault:v1:${provider}`);
  };
  return Object.freeze({backend:BROWSER_VAULT_BACKEND,
    async available(){try{await key();return true;}catch{return false;}},
    async seal(provider,secret){
      try{
        if(typeof secret!=='string'||!/^[\x21-\x7e]{12,4096}$/u.test(secret))throw failure();
        const iv=cryptoImpl.getRandomValues(new Uint8Array(12));
        const bytes=await cryptoImpl.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(provider)},await key(),new TextEncoder().encode(secret));
        return {version:1,backend:BROWSER_VAULT_BACKEND,iv:encode(iv),ciphertext:encode(new Uint8Array(bytes))};
      }catch{throw failure();}
    },
    async unseal(provider,record){
      try{
        if(!record||record.version!==1||record.backend!==BROWSER_VAULT_BACKEND||Object.keys(record).some(x=>!['version','backend','iv','ciphertext'].includes(x)))throw failure();
        const iv=decode(record.iv,20),bytes=decode(record.ciphertext,5600);if(iv.length!==12||bytes.length<28)throw failure();
        const plain=await cryptoImpl.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(provider)},await key(),bytes);
        const secret=new TextDecoder('utf-8',{fatal:true}).decode(plain);
        if(!/^[\x21-\x7e]{12,4096}$/u.test(secret))throw failure();return secret;
      }catch{throw failure();}
    },
  });
}
