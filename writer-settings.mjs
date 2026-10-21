import {constants} from 'node:fs';
import {mkdir,open,rename,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {WRITER_CONFIG_DIR,WRITER_STATE_FILE,WriterConfigError,
  assertWriterDirectory,readPrivateWriterFile,loadPrivateWriterState,parsePrivateWriterState,
  writerSelectionWithCredentials,credentialStorageStatus,credentialStorageFailure,credentialConfigured,
  credentialEnvelopes,attachCredentialMetadata,parseEncryptedWriterState} from './writer-config.mjs';
import {getProvider,isAgentProvider,normalizeModel,normalizeBaseUrl} from './extension/provider-catalog.js';
import {discoverLocalAgents} from './local-agents.mjs';
import {createCredentialStore,CredentialStoreError} from './credential-store.mjs';
import {discoverModels,ModelDiscoveryError} from './model-discovery.mjs';

export class WriterSettingsError extends Error{
  constructor(code,message,status=400){super(message);this.code=code;this.status=status;}
}

function publicSettings(state,runner,agents=[],storage=credentialStorageStatus(state)){
  const descriptor=getProvider(state.provider),selected=state.profiles[state.provider];
  const profiles=Object.fromEntries(Object.entries(state.profiles).map(([provider,input])=>[provider,
    {model:input.model,baseUrl:input.baseUrl,keyConfigured:credentialConfigured(state,provider)}]));
  const publicAgents=agents.filter(agent=>isAgentProvider(agent?.id)).map(agent=>{
    const item=getProvider(agent.id);
    return {id:item.id,label:item.label,installed:agent.installed===true,supported:item.supported!==false&&agent.supported!==false};
  });
  return {provider:state.provider,model:isAgentProvider(state.provider)?runner.health.writerModel||descriptor.label:selected.model,
    ...(selected?{baseUrl:selected.baseUrl}:{}),keyConfigured:credentialConfigured(state,state.provider),
    allowedModels:[...descriptor.models],checkScope:'local',profiles,agents:publicAgents,credentialStorage:storage};
}

function nextState(input,current){
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(key=>!['provider','model','baseUrl','apiKey'].includes(key))||
    !getProvider(input.provider))
    throw new WriterSettingsError('WRITER_SETTINGS_INVALID','请选择支持的模型服务。');
  const descriptor=getProvider(input.provider);
  if(isAgentProvider(input.provider)){
    if(input.model!==undefined||input.baseUrl!==undefined||input.apiKey!==undefined)
      throw new WriterSettingsError('WRITER_SETTINGS_INVALID','本地 Agent 使用本机已有的模型与登录配置。');
    if(descriptor.supported===false)throw new WriterSettingsError('AGENT_UNSUPPORTED','此本地 Agent 暂未提供安全兼容的生成适配。');
    return {version:2,provider:input.provider,profiles:structuredClone(current.profiles)};
  }
  let model,baseUrl;
  try{model=normalizeModel(input.provider,input.model);baseUrl=normalizeBaseUrl(input.provider,input.baseUrl??current.profiles[input.provider]?.baseUrl);}
  catch{throw new WriterSettingsError('WRITER_SETTINGS_INVALID','模型名称或服务地址无效，请检查当前服务商设置。');}
  if(input.apiKey!==undefined&&typeof input.apiKey!=='string')
    throw new WriterSettingsError('WRITER_SETTINGS_INVALID','API Key 格式无效。');
  const key=input.apiKey?.trim()||current.profiles[input.provider]?.apiKey;
  if((descriptor.keyRequired&&!key)||(key&&!/^[\x21-\x7e]{12,4096}$/u.test(key)))
    throw new WriterSettingsError(input.provider==='deepseek'?'DEEPSEEK_KEY_REQUIRED':'API_KEY_REQUIRED',
      `请填写有效的 ${descriptor.label} API Key；已保存时可留空保留。`);
  return {version:2,provider:input.provider,profiles:{...structuredClone(current.profiles),
    [input.provider]:{model,baseUrl,...(key?{apiKey:key}:{})}}};
}

// Only the final rename selects new configuration. A failed stage leaves the
// previous private state, legacy key and running writer untouched.
export async function savePrivateWriterState(appDir,state,{credentialStore=createCredentialStore(),legacyKeyToRetire,
  retainedCredentials={},previousKeys={}}={}){
  const safeState=parsePrivateWriterState(state);
  let staged,committed=false;const sealed=[];
  try{
    await assertWriterDirectory(appDir,{optional:true});
    await mkdir(appDir,{recursive:true,mode:0o700});
    await assertWriterDirectory(appDir);
    const target=join(appDir,WRITER_STATE_FILE);
    const priorRaw=await readPrivateWriterFile(target,{optional:true});
    let previousCredentials={};
    if(priorRaw){const parsed=JSON.parse(priorRaw);if(parsed.version===3)previousCredentials=Object.fromEntries(
      Object.entries(parseEncryptedWriterState(parsed).profiles).filter(([,item])=>item.credential).map(([provider,item])=>[provider,item.credential]));}
    const profiles={};
    for(const [provider,input] of Object.entries(safeState.profiles)){
      const {apiKey,...settings}=input;
      profiles[provider]={...settings};
      const retained=retainedCredentials[provider];
      if(retained&&JSON.stringify(retained)!==JSON.stringify(previousCredentials[provider]))
        throw new CredentialStoreError('CREDENTIAL_STORE_CHANGED','本机密钥配置已更改，请重新打开设置后保存。');
      if(retained&&(!apiKey||apiKey===previousKeys[provider])){
        profiles[provider].credential=retained;
      }else if(apiKey){
        const credential=await credentialStore.seal(provider,apiKey);
        sealed.push({provider,credential});profiles[provider].credential=credential;
      }
    }
    staged=join(appDir,`.writer-settings-${randomBytes(16).toString('hex')}.tmp`);
    const file=await open(staged,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
    try{await file.writeFile(JSON.stringify({version:3,provider:safeState.provider,profiles})+'\n','utf8');await file.sync();}
    finally{await file.close();}
    await assertWriterDirectory(appDir);
    await readPrivateWriterFile(target,{optional:true});
    await rename(staged,target);
    staged=null;committed=true;
    // Best effort durability after commit must not turn success into an
    // ambiguous failure or cause the bridge to keep the old in-memory writer.
    try{const dir=await open(appDir,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}catch{}
    // Retire only a legacy plaintext key proven present in encrypted storage.
    // Unexpected legacy data is retained and clearly reported to the UI.
    let legacy=true;
    try{
      const legacyPath=join(appDir,'deepseek-api-key'),old=await readPrivateWriterFile(legacyPath,{optional:true});
      legacy=Boolean(old?.trim());
      if(legacy&&(safeState.profiles.deepseek?.apiKey===old.trim()||legacyKeyToRetire===old.trim())){
        await rm(legacyPath);legacy=false;
      }
    }catch{}
    const credentials=Object.fromEntries(Object.entries(profiles).filter(([,item])=>item.credential).map(([provider,item])=>[provider,item.credential]));
    // Delete retired Keychain wrapping keys only after the metadata commit.
    // Unchanged and unavailable credentials keep their exact existing envelope.
    for(const [provider,credential] of Object.entries(previousCredentials)){
      if(JSON.stringify(credential)!==JSON.stringify(credentials[provider]))
        await credentialStore.discard(provider,credential).catch(()=>{});
    }
    return {credentials,credentialStorage:{backend:credentials[safeState.provider]?.backend??(isAgentProvider(safeState.provider)?'none':credentialStore.backend),encrypted:Object.keys(credentials).length>0,legacy}};
  }catch(error){
    if(error instanceof CredentialStoreError)throw error;
    throw new WriterSettingsError('WRITER_SETTINGS_SAVE_FAILED','模型配置未保存，请检查本机配置目录及权限。',503);
  }finally{
    if(staged)await rm(staged,{force:true}).catch(()=>{});
    if(!committed)for(const {provider,credential} of sealed)await credentialStore.discard(provider,credential).catch(()=>{});
  }
}

export async function createWriterSettingsController({appDir=WRITER_CONFIG_DIR,env=process.env,
  initialRunner,createRunner,commitState=savePrivateWriterState,discoverAgents=discoverLocalAgents,
  credentialStore=createCredentialStore(),discoverModelsImpl=discoverModels}={}){
  if(!initialRunner||typeof createRunner!=='function')throw new TypeError('writer settings dependencies required');
  let state=await loadPrivateWriterState({appDir,env,credentialStore,allowUnavailable:true});
  let storage=credentialStorageStatus(state),selectedRunner=initialRunner,busy=false,modelsBusy=false;
  const read=async()=>{
    if(credentialStorageFailure(state)){
      try{state=await loadPrivateWriterState({appDir,env,credentialStore,allowUnavailable:true});storage=credentialStorageStatus(state);}catch{}
    }
    let agents;
    try{agents=await discoverAgents({env});}catch{agents=[];}
    return publicSettings(state,selectedRunner,Array.isArray(agents)?agents:[],storage);
  };
  return {
    read,
    async models(input){
      if(modelsBusy)throw new WriterSettingsError('BUSY','正在读取模型列表，请稍后重试。',409);
      if(!input||typeof input!=='object'||Array.isArray(input)||
        Object.keys(input).some(key=>!['provider','baseUrl','apiKey'].includes(key))||
        !getProvider(input.provider)||isAgentProvider(input.provider))
        throw new WriterSettingsError('WRITER_SETTINGS_INVALID','请选择支持读取模型列表的 API 或本地模型服务。');
      let baseUrl;
      try{baseUrl=normalizeBaseUrl(input.provider,input.baseUrl??state.profiles[input.provider]?.baseUrl);}
      catch{throw new WriterSettingsError('WRITER_SETTINGS_INVALID','服务地址无效。');}
      if(input.apiKey!==undefined&&typeof input.apiKey!=='string')throw new WriterSettingsError('WRITER_SETTINGS_INVALID','API Key 格式无效。');
      const apiKey=input.apiKey?.trim()||state.profiles[input.provider]?.apiKey,descriptor=getProvider(input.provider);
      if(!input.apiKey?.trim()&&credentialConfigured(state,input.provider)&&!apiKey&&credentialStorageFailure(state))throw credentialStorageFailure(state);
      if((descriptor.keyRequired&&!apiKey)||(apiKey&&!/^[\x21-\x7e]{12,4096}$/u.test(apiKey)))
        throw new WriterSettingsError('API_KEY_REQUIRED',`请填写有效的 ${descriptor.label} API Key；已保存时可留空保留。`);
      modelsBusy=true;
      try{return await discoverModelsImpl({provider:input.provider,baseUrl,...(apiKey?{apiKey}:{})});}
      catch(error){if(error instanceof ModelDiscoveryError)throw error;throw new WriterSettingsError('MODEL_DISCOVERY_FAILED','暂时无法读取模型列表，请稍后重试或手动填写。',503);}
      finally{modelsBusy=false;}
    },
    async write(input){
      if(busy)throw new WriterSettingsError('BUSY','模型配置正在保存，请稍后重试。',409);
      busy=true;
      try{
        if(!isAgentProvider(input?.provider)&&credentialConfigured(state,input?.provider)&&
          !state.profiles[input.provider]?.apiKey&&!input.apiKey?.trim()&&credentialStorageFailure(state))
          throw credentialStorageFailure(state);
        const candidate=nextState(input,state);
        let runner;
        try{
          runner=await createRunner(writerSelectionWithCredentials(candidate));
          await runner.initialize();
        }catch{
          const descriptor=getProvider(candidate.provider);
          throw new WriterSettingsError('WRITER_INITIALIZE_FAILED',descriptor.kind==='agent'
            ?`未找到兼容且已登录的本机 ${descriptor.label}，原配置已保留。`
            :`${descriptor.label} 本机配置检查失败，原配置已保留。`,503);
        }
        let committed;
        try{committed=await commitState(appDir,candidate,{credentialStore,legacyKeyToRetire:state.profiles.deepseek?.apiKey,
          retainedCredentials:credentialEnvelopes(state),previousKeys:Object.fromEntries(Object.entries(state.profiles).map(([provider,item])=>[provider,item.apiKey]))});
          storage=committed?.credentialStorage??credentialStorageStatus(candidate);}
        catch(error){if(error instanceof CredentialStoreError)throw error;throw new WriterSettingsError('WRITER_SETTINGS_SAVE_FAILED','模型配置未保存，原配置已保留。',503);}
        const credentials=committed?.credentials??credentialEnvelopes(state);
        state=attachCredentialMetadata(candidate,{credentials,status:storage,
          unavailable:Object.entries(credentials).some(([provider])=>!candidate.profiles[provider]?.apiKey)?credentialStorageFailure(state)??new CredentialStoreError():undefined});
        selectedRunner=runner;
        return {runner,settings:{...await read(),saved:true}};
      }catch(error){
        if(error instanceof WriterSettingsError)throw error;
        if(error instanceof CredentialStoreError)throw new WriterSettingsError(error.code,error.message,503);
        if(error instanceof WriterConfigError)throw new WriterSettingsError('WRITER_SETTINGS_INVALID','模型配置无效，原配置已保留。');
        throw new WriterSettingsError('WRITER_SETTINGS_SAVE_FAILED','模型配置未保存，原配置已保留。',503);
      }finally{busy=false;}
    },
  };
}
