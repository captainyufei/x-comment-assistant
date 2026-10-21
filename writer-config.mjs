import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,isAbsolute,win32} from 'node:path';
import {getProvider,isAgentProvider,normalizeModel,normalizeBaseUrl} from './extension/provider-catalog.js';
import {createCredentialStore,validateCredentialEnvelope,CredentialStoreError} from './credential-store.mjs';

export const DEEPSEEK_MODELS=Object.freeze(['deepseek-flash','deepseek-v4-pro']);
export function writerConfigDirectory({platform=process.platform,env=process.env,home=homedir()}={}){
  if(platform==='win32')return win32.join(env.LOCALAPPDATA||win32.join(home,'AppData','Local'),'Jieyiju');
  if(platform==='darwin')return join(home,'Library','Application Support','Jieyiju');
  return join(env.XDG_CONFIG_HOME||join(home,'.config'),'Jieyiju');
}
export const WRITER_CONFIG_DIR=writerConfigDirectory();
export const WRITER_STATE_FILE='writer-settings-state.json';
export const MAX_WRITER_CONFIG_BYTES=64*1024;
const storageStatus=Symbol('writerCredentialStorage');
const storageFailure=Symbol('writerCredentialFailure');
const storedProviders=Symbol('writerCredentialProviders');
const storedEnvelopes=Symbol('writerCredentialEnvelopes');
export const credentialStorageFailure=state=>state?.[storageFailure];
export const credentialConfigured=(state,provider)=>Boolean(state?.profiles?.[provider]?.apiKey)||Boolean(state?.[storedProviders]?.has(provider));
export const credentialEnvelopes=state=>structuredClone(state?.[storedEnvelopes]??{});
export function attachCredentialMetadata(state,{credentials,status,unavailable}={}){
  if(status)markStorage(state,status);
  if(credentials){
    Object.defineProperty(state,storedEnvelopes,{value:structuredClone(credentials)});
    Object.defineProperty(state,storedProviders,{value:new Set(Object.keys(credentials))});
  }
  if(unavailable)Object.defineProperty(state,storageFailure,{value:unavailable});
  return state;
}
export function credentialStorageStatus(state){
  return state?.[storageStatus]??{backend:Object.values(state?.profiles??{}).some(item=>item.apiKey)?'legacy-plaintext':'none',encrypted:false,
    legacy:Object.values(state?.profiles??{}).some(item=>item.apiKey)};
}
function markStorage(state,status){Object.defineProperty(state,storageStatus,{value:status});return state;}

export class WriterConfigError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const invalid=()=>new WriterConfigError('WRITER_CONFIG','本机模型配置格式无效。');
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const validKey=value=>typeof value==='string'&&/^[\x21-\x7e]{12,4096}$/u.test(value);

// The original public config remains readable. It is never rewritten on read.
export function parseWriterSettings(config){
  if(!record(config)||Object.keys(config).some(key=>!['version','provider','model'].includes(key))||
    config.version!==1||!['codex','deepseek'].includes(config.provider))throw invalid();
  if(config.provider==='codex'){
    if(config.model!==undefined)throw invalid();
    return {provider:'codex'};
  }
  try{return {provider:'deepseek',model:normalizeModel('deepseek',config.model)};}
  catch{throw invalid();}
}

export async function assertWriterDirectory(appDir,{optional=false}={}){
  if(typeof appDir!=='string'||!isAbsolute(appDir)||/[\0\r\n]/u.test(appDir))
    throw new WriterConfigError('WRITER_CONFIG','本机模型配置目录无效。');
  try{
    const meta=await lstat(appDir);
    if(!meta.isDirectory()||meta.isSymbolicLink()||(process.platform!=='win32'&&(meta.mode&0o022))||
      (process.getuid&&meta.uid!==process.getuid()))throw new Error('unsafe');
  }catch(error){
    if(optional&&error.code==='ENOENT')return false;
    throw new WriterConfigError('WRITER_CONFIG','本机模型配置目录无法安全访问，请检查目录及权限。');
  }
  return true;
}

export async function readPrivateWriterFile(path,{optional=false}={}){
  let file;
  try {
    const before=await lstat(path);
    if(before.isSymbolicLink())throw new Error('unsafe');
    file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const meta=await file.stat();
    if(!meta.isFile()||meta.nlink!==1||meta.size>MAX_WRITER_CONFIG_BYTES||(process.platform!=='win32'&&(meta.mode&0o077))||
      (before.ino!==meta.ino||before.dev!==meta.dev)||
      (process.getuid&&meta.uid!==process.getuid()))throw new Error('unsafe');
    const content=await file.readFile();
    if(content.length>MAX_WRITER_CONFIG_BYTES)throw new Error('too large');
    return content.toString('utf8');
  }catch(error){
    if(optional&&error.code==='ENOENT')return null;
    throw new WriterConfigError('WRITER_CONFIG','本机模型配置无法安全读取，请检查配置文件及权限。');
  }finally{await file?.close();}
}

function profile(provider,input){
  const descriptor=getProvider(provider);
  if(!descriptor||descriptor.kind==='agent'||!record(input)||
    Object.keys(input).some(key=>!['model','baseUrl','apiKey'].includes(key))||
    (input.apiKey!==undefined&&!validKey(input.apiKey)))throw invalid();
  try{
    return {model:normalizeModel(provider,input.model),baseUrl:normalizeBaseUrl(provider,input.baseUrl),
      ...(input.apiKey!==undefined?{apiKey:input.apiKey}:{})};
  }catch{throw invalid();}
}

// Legacy v1/v2 normalize to the in-memory shape. Only an explicit save commits
// encrypted v3 metadata; reads never rewrite legacy credentials.
export function parsePrivateWriterState(config){
  if(!record(config))throw invalid();
  if(config.version===1){
    if(Object.keys(config).some(key=>!['version','provider','model','deepseekApiKey'].includes(key))||
      (config.deepseekApiKey!==undefined&&!validKey(config.deepseekApiKey)))throw invalid();
    const {deepseekApiKey,...legacy}=config;
    const selected=parseWriterSettings(legacy);
    const profiles={};
    if(selected.provider==='deepseek'||deepseekApiKey)profiles.deepseek=profile('deepseek',{
      model:selected.provider==='deepseek'?selected.model:undefined,...(deepseekApiKey?{apiKey:deepseekApiKey}:{})});
    return {version:2,provider:selected.provider,profiles};
  }
  if(config.version!==2||Object.keys(config).some(key=>!['version','provider','profiles'].includes(key))||
    !getProvider(config.provider)||!record(config.profiles))throw invalid();
  const profiles={};
  for(const [provider,input] of Object.entries(config.profiles)){
    const normalized=profile(provider,input);
    Object.defineProperty(profiles,provider,{value:normalized,enumerable:true,writable:true,configurable:true});
  }
  if(!isAgentProvider(config.provider)&&!Object.hasOwn(profiles,config.provider))throw invalid();
  return {version:2,provider:config.provider,profiles};
}

export function publicSelectionFromPrivateWriterState(config){
  const state=config?.version===3?parseEncryptedWriterState(config):parsePrivateWriterState(config);
  if(isAgentProvider(state.provider))return {provider:state.provider};
  const {model,baseUrl}=state.profiles[state.provider];
  return {provider:state.provider,model,baseUrl};
}

export function parseEncryptedWriterState(config){
  if(!record(config)||config.version!==3||Object.keys(config).some(key=>!['version','provider','profiles'].includes(key))||
    !getProvider(config.provider)||!record(config.profiles))throw invalid();
  const profiles={};
  for(const [provider,input] of Object.entries(config.profiles)){
    if(!record(input)||Object.keys(input).some(key=>!['model','baseUrl','credential'].includes(key)))throw invalid();
    const normalized=profile(provider,{model:input.model,baseUrl:input.baseUrl});
    if(input.credential!==undefined){try{normalized.credential=validateCredentialEnvelope(provider,input.credential);}catch{throw invalid();}}
    Object.defineProperty(profiles,provider,{value:normalized,enumerable:true,writable:true,configurable:true});
  }
  if(!isAgentProvider(config.provider)&&!Object.hasOwn(profiles,config.provider))throw invalid();
  return {version:3,provider:config.provider,profiles};
}

export async function loadPrivateWriterState({appDir=WRITER_CONFIG_DIR,env=process.env,credentialStore=createCredentialStore(),allowUnavailable=false}={}){
  await assertWriterDirectory(appDir,{optional:true});
  const raw=await readPrivateWriterFile(join(appDir,WRITER_STATE_FILE),{optional:true});
  if(raw!==null){
    try{
      const parsed=JSON.parse(raw);
      if(parsed.version!==3)return parsePrivateWriterState(parsed);
      const encrypted=parseEncryptedWriterState(parsed),profiles={};let unavailable;
      for(const [provider,input] of Object.entries(encrypted.profiles)){
        const {credential,...settings}=input;
        profiles[provider]={...settings};
        if(credential){try{profiles[provider].apiKey=await credentialStore.unseal(provider,credential);}
          catch(error){if(!allowUnavailable)throw error;unavailable=error instanceof CredentialStoreError?error:new CredentialStoreError();}}
      }
      const state=parsePrivateWriterState({version:2,provider:encrypted.provider,profiles});
      const hasCredentials=Object.values(encrypted.profiles).some(item=>item.credential);
      let legacy=true;
      try{legacy=Boolean((await readPrivateWriterFile(join(appDir,'deepseek-api-key'),{optional:true}))?.trim());}catch{}
      return attachCredentialMetadata(state,{credentials:Object.fromEntries(Object.entries(encrypted.profiles).filter(([,input])=>input.credential).map(([provider,input])=>[provider,input.credential])),
        status:{backend:encrypted.profiles[encrypted.provider]?.credential?.backend??(isAgentProvider(encrypted.provider)?'none':credentialStore.backend),encrypted:hasCredentials,legacy},unavailable});
    }
    catch(error){if(error instanceof WriterConfigError||error instanceof CredentialStoreError)throw error;throw invalid();}
  }
  const legacy=await readPrivateWriterFile(join(appDir,'writer-config.json'),{optional:true});
  let selected={provider:'codex'};
  if(legacy!==null){try{selected=parseWriterSettings(JSON.parse(legacy));}catch(error){if(error instanceof WriterConfigError)throw error;throw invalid();}}
  const stored=await readPrivateWriterFile(join(appDir,'deepseek-api-key'),{optional:true});
  const source=stored??(selected.provider==='deepseek'?env.DEEPSEEK_API_KEY:undefined);
  const deepseekApiKey=typeof source==='string'?source.trim():undefined;
  return parsePrivateWriterState({version:1,...selected,...(deepseekApiKey?{deepseekApiKey}:{})});
}

export function writerSelectionWithCredentials(config){
  const state=parsePrivateWriterState(config);
  const selected=publicSelectionFromPrivateWriterState(state);
  if(isAgentProvider(state.provider))return selected;
  const descriptor=getProvider(state.provider),{apiKey}=state.profiles[state.provider];
  if(descriptor.keyRequired&&!apiKey)throw new WriterConfigError(state.provider==='deepseek'?'DEEPSEEK_KEY_REQUIRED':'API_KEY_REQUIRED',
    `尚未配置有效的 ${descriptor.label} API Key。`);
  return {...selected,...(apiKey?{apiKey}:{})};
}

// Credentials stay outside extension source/runtime. Environment keys never
// select a provider or override an explicitly saved credential.
export async function loadWriterConfig({appDir=WRITER_CONFIG_DIR,env=process.env,credentialStore=createCredentialStore()}={}){
  await assertWriterDirectory(appDir,{optional:true});
  const raw=await readPrivateWriterFile(join(appDir,WRITER_STATE_FILE),{optional:true});
  if(raw!==null){try{
    const parsed=JSON.parse(raw);
    if(parsed.version===3){const encrypted=parseEncryptedWriterState(parsed);if(isAgentProvider(encrypted.provider))return {provider:encrypted.provider};}
    const state=await loadPrivateWriterState({appDir,env,credentialStore,allowUnavailable:true});
    if(credentialConfigured(state,state.provider)&&!state.profiles[state.provider]?.apiKey&&credentialStorageFailure(state))
      throw credentialStorageFailure(state);
    return writerSelectionWithCredentials(state);}
    catch(error){if(error instanceof WriterConfigError||error instanceof CredentialStoreError)throw error;throw invalid();}}
  const legacy=await readPrivateWriterFile(join(appDir,'writer-config.json'),{optional:true});
  if(legacy===null)return {provider:'codex'};
  let selected;
  try{selected=parseWriterSettings(JSON.parse(legacy));}catch(error){if(error instanceof WriterConfigError)throw error;throw invalid();}
  // Rollback to the local agent must not touch an unrelated unsafe API key.
  if(selected.provider==='codex')return selected;
  return writerSelectionWithCredentials(await loadPrivateWriterState({appDir,env,credentialStore}));
}
