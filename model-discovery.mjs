import {getProvider,normalizeBaseUrl,normalizeModel} from './extension/provider-catalog.js';

// Provider documents checked 2026-10-20. Deliberately do not probe invented endpoints.
// https://api-docs.deepseek.com/api/list-models/
// https://platform.openai.com/docs/api-reference/models/list
// https://platform.kimi.com/docs/api/list-models
// https://help.aliyun.com/zh/model-studio/list-models
// https://docs.ollama.com/api/openai-compatibility
// https://lmstudio.ai/docs/developer/openai-compat/models
const OPENAI_LIST_PROVIDERS=new Set(['deepseek','openai','kimi','ollama','lmstudio']);
const MESSAGES={
  MODEL_DISCOVERY_UNSUPPORTED:'该来源暂未接入自动读取模型，请手动填写模型名称或接入点 ID。',
  MODEL_DISCOVERY_CONFIG:'模型列表配置无效，请检查服务商、服务地址和 API Key。',
  MODEL_DISCOVERY_AUTH:'读取模型列表认证失败，请检查该服务商的 API Key 和权限。',
  MODEL_DISCOVERY_RATE_LIMIT:'模型列表请求过于频繁，请稍后重试。',
  MODEL_DISCOVERY_UNAVAILABLE:'该服务暂时无法提供模型列表，请稍后重试或手动填写。',
  MODEL_DISCOVERY_NETWORK:'无法连接模型服务，请检查网络或本地模型服务后重试。',
  MODEL_DISCOVERY_TIMEOUT:'读取模型列表超时，请重试或手动填写模型名称。',
  MODEL_DISCOVERY_RESPONSE:'模型服务返回的模型列表无效，请重试或手动填写。',
};
export class ModelDiscoveryError extends Error{
  constructor(code,status=400){super(MESSAGES[code]||MESSAGES.MODEL_DISCOVERY_RESPONSE);this.name='ModelDiscoveryError';this.code=code;this.status=status;}
}
const fail=(code,status)=>new ModelDiscoveryError(code,status);
function boundedInteger(value,fallback,ceiling){return Number.isSafeInteger(value)&&value>=1&&value<=ceiling?value:fallback;}

function selection(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('MODEL_DISCOVERY_CONFIG');
  const descriptor=getProvider(input.provider);
  if(!descriptor)throw fail('MODEL_DISCOVERY_CONFIG');
  let baseUrl;try{baseUrl=normalizeBaseUrl(descriptor.id,input.baseUrl);}catch{if(descriptor.kind==='agent')throw fail('MODEL_DISCOVERY_UNSUPPORTED');throw fail('MODEL_DISCOVERY_CONFIG');}
  if(!OPENAI_LIST_PROVIDERS.has(descriptor.id)&&descriptor.id!=='qwen')throw fail('MODEL_DISCOVERY_UNSUPPORTED');
  const apiKey=typeof input.apiKey==='string'?input.apiKey.trim():'';
  if((descriptor.keyRequired&&!apiKey)||(apiKey&&!/^[\x21-\x7e]{12,4096}$/u.test(apiKey)))throw fail('MODEL_DISCOVERY_CONFIG');
  return {provider:descriptor.id,baseUrl,apiKey};
}

function dispose(response){try{const result=response?.body?.cancel?.();result?.catch?.(()=>{});}catch{}}
async function readBody(response,limit,wait){
  const length=response.headers?.get?.('content-length');
  if(length!==null&&length!==undefined&&Number(length)>limit){dispose(response);throw fail('MODEL_DISCOVERY_RESPONSE',502);}
  if(!response.body?.getReader)throw fail('MODEL_DISCOVERY_RESPONSE',502);
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{
    for(;;){
      const {done,value}=await wait(reader.read());if(done)break;
      if(!(value instanceof Uint8Array))throw fail('MODEL_DISCOVERY_RESPONSE',502);
      bytes+=value.byteLength;
      if(bytes>limit)throw fail('MODEL_DISCOVERY_RESPONSE',502);
      chunks.push(value);
    }
  }catch(error){try{reader.cancel().catch(()=>{});}catch{}throw error;}
  finally{try{reader.releaseLock();}catch{}}
  const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}catch{throw fail('MODEL_DISCOVERY_RESPONSE',502);}
}
function parsePage(body,qwen){
  if(!body||typeof body!=='object'||Array.isArray(body)||body.error||body.success===false)throw fail('MODEL_DISCOVERY_RESPONSE',502);
  if(!qwen){if(!Array.isArray(body.data))throw fail('MODEL_DISCOVERY_RESPONSE',502);return {entries:body.data,total:body.data.length};}
  if(!body.output||!Array.isArray(body.output.models)||!Number.isSafeInteger(body.output.total)||body.output.total<0)throw fail('MODEL_DISCOVERY_RESPONSE',502);
  return {entries:body.output.models,total:body.output.total};
}

/** Read-only discovery. A provider listing does not guarantee chat support, balance or generation access. */
export async function discoverModels(input,options={}){
  const current=selection(input),fetchImpl=options.fetchImpl||globalThis.fetch;
  if(typeof fetchImpl!=='function')throw fail('MODEL_DISCOVERY_CONFIG');
  const timeoutMs=boundedInteger(options.timeoutMs,8000,30000),limit=boundedInteger(options.maxResponseBytes,1024*1024,2*1024*1024),maxModels=boundedInteger(options.maxModels,500,1000);
  const controller=new AbortController();let timer,timedOut=false;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(fail('MODEL_DISCOVERY_TIMEOUT',504));},timeoutMs);});
  const wait=promise=>Promise.race([promise,deadline]);
  const qwen=current.provider==='qwen',models=[],seen=new Set();let truncated=false,totalRead=0;
  try{
    for(let page=1;page<=(qwen?10:1);page++){
      const url=qwen?new URL('/api/v1/models',current.baseUrl):new URL(`${current.baseUrl}/models`);
      if(qwen){url.searchParams.set('capabilities','TG');url.searchParams.set('page_no',String(page));url.searchParams.set('page_size','100');}
      const response=await wait(Promise.resolve().then(()=>fetchImpl(url.href,{method:'GET',headers:{Accept:'application/json',...(current.apiKey?{Authorization:`Bearer ${current.apiKey}`}:{})},redirect:'error',signal:controller.signal})));
      if(!response||response.redirected){dispose(response);throw fail('MODEL_DISCOVERY_RESPONSE',502);}
      if(!response.ok){
        dispose(response);
        const status=response.status;
        if(status===401||status===403)throw fail('MODEL_DISCOVERY_AUTH',status);
        if(status===429)throw fail('MODEL_DISCOVERY_RATE_LIMIT',429);
        throw fail('MODEL_DISCOVERY_UNAVAILABLE',502);
      }
      const parsed=parsePage(await readBody(response,limit,wait),qwen);
      totalRead+=parsed.entries.length;
      for(const entry of parsed.entries){
        if(!entry||typeof entry!=='object'||Array.isArray(entry))throw fail('MODEL_DISCOVERY_RESPONSE',502);
        const rawId=qwen?entry.model:entry.id;
        if(typeof rawId!=='string')throw fail('MODEL_DISCOVERY_RESPONSE',502);
        let id;try{id=normalizeModel(current.provider,rawId);}catch{throw fail('MODEL_DISCOVERY_RESPONSE',502);}
        // Even a malformed upstream must not reflect the credential into public model metadata.
        if(current.apiKey&&id.includes(current.apiKey))throw fail('MODEL_DISCOVERY_RESPONSE',502);
        if(seen.has(id))continue;
        if(models.length>=maxModels){truncated=true;break;}
        seen.add(id);models.push({id});
      }
      if(models.length>=maxModels&&parsed.total>totalRead)truncated=true;
      if(!qwen||truncated||totalRead>=parsed.total)break;
      if(parsed.entries.length===0)throw fail('MODEL_DISCOVERY_RESPONSE',502);
      if(page===10)truncated=true;
    }
    return {provider:current.provider,baseUrl:current.baseUrl,models,source:'remote',checkedAt:new Date().toISOString(),truncated};
  }catch(error){
    if(timedOut)throw fail('MODEL_DISCOVERY_TIMEOUT',504);
    if(error instanceof ModelDiscoveryError)throw error;
    throw fail('MODEL_DISCOVERY_NETWORK',502);
  }finally{clearTimeout(timer);controller.abort();}
}
