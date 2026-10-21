import {createBrowserVault,BROWSER_VAULT_BACKEND} from './browser-vault.js';
import {getProvider,normalizeModel,normalizeBaseUrl,isApiProvider} from './provider-catalog.js';
import {validateWriterSettings,validateModelDiscovery,validateInlineContext,validatePreferences} from './background-core.js';
import {buildMessages,parseReply} from './shared/prompt.js';
import {apiCapabilities,buildApiPayload} from './shared/api-protocol.mjs';
import {discoverModels} from './shared/model-discovery.mjs';
import {validateMedia} from './media-core.js';

export const DIRECT_SETTINGS_KEY='directWriterSettings';
const RESPONSE_LIMIT=128*1024,MEDIA_LIMIT=4*1024*1024,MEDIA_TOTAL_LIMIT=8*1024*1024;
const err=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const cancel=target=>{try{Promise.resolve(target?.cancel?.()).catch(()=>{});}catch{}};
function directBaseUrl(provider,value){
  const normalized=normalizeBaseUrl(provider,value);
  if(getProvider(provider)?.kind==='local'&&new URL(normalized).hostname==='[::1]')throw err('DIRECT_IPV6_UNSUPPORTED','浏览器直连本地模型请使用 127.0.0.1 地址，例如 http://127.0.0.1:11434/v1。');
  return normalized;
}
function abortable(value,signal,onAbort){
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);onAbort?.();reject(signal.reason||err('CANCELLED','已取消生成。'));};
    if(signal.aborted){abort();Promise.resolve(value).catch(()=>{});return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(value).then(x=>{signal.removeEventListener('abort',abort);resolve(x);},e=>{signal.removeEventListener('abort',abort);reject(e);});
  });
}
async function readBytes(response,limit,signal,onChunk){
  if(response.redirected||Number(response.headers?.get('content-length'))>limit){cancel(response.body);throw err('OUTPUT_LIMIT','模型返回内容过长或发生跳转，已停止。');}
  const reader=response.body?.getReader();if(!reader)throw err('DIRECT_FORMAT','服务没有返回可读取的内容。');
  let size=0;const chunks=[];
  try{
    for(;;){const item=await abortable(reader.read(),signal,()=>cancel(reader));if(item.done)break;
      if(!(item.value instanceof Uint8Array))throw err('DIRECT_FORMAT','服务返回的数据格式无效。');
      size+=item.value.byteLength;if(size>limit)throw err('OUTPUT_LIMIT','模型返回内容过长，已停止。');
      if(onChunk){if(onChunk(item.value)===false){cancel(reader);break;}}else chunks.push(item.value);
    }
  }catch(error){cancel(reader);throw error;}finally{try{reader.releaseLock();}catch{}}
  const bytes=new Uint8Array(onChunk?0:size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
const base64=bytes=>{let text='';for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(text);};
function imageType(bytes){
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
  if(bytes.length>=12&&new TextDecoder().decode(bytes.subarray(0,4))==='RIFF'&&new TextDecoder().decode(bytes.subarray(8,12))==='WEBP')return 'image/webp';
  return '';
}
async function prepareBrowserMedia(context,capability,fetchImpl,parentSignal){
  const media=validateMedia(context.media),hasMedia=context.hasMedia||media.length>0;
  const evidence={images:0,videoFrames:0,videoPosters:0,attachments:[],altTexts:media.map(x=>x.alt).filter(Boolean),limitations:[]},images=[];
  if(!hasMedia)return {evidence,images};
  evidence.limitations.push('未读取完整视频、连续动作、对白或声音；视频封面只代表该封面。');
  if(!capability.vision){evidence.limitations.push('当前所选模型接入未确认支持图片；本次仅依据原帖文字和替代文字。');return {evidence,images};}
  if(!media.length){evidence.limitations.push('页面未提供可读取的原帖图片或视频封面。');return {evidence,images};}
  const controller=new AbortController(),abort=()=>controller.abort(parentSignal.reason);parentSignal.addEventListener('abort',abort,{once:true});
  if(parentSignal.aborted)abort();const timer=setTimeout(()=>controller.abort(err('MEDIA_TIMEOUT','媒体读取超过十二秒。')),12000);let total=0,failed=0;
  try{
    for(const item of media){
      try{
        const pending=Promise.resolve().then(()=>fetchImpl(item.url,{method:'GET',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal}));
        pending.then(response=>{if(controller.signal.aborted)cancel(response?.body);},()=>{});
        const response=await abortable(pending,controller.signal);
        if(!response?.ok||response.redirected){cancel(response?.body);throw err('MEDIA_UNAVAILABLE','图片读取失败。');}
        const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
        if(!['image/jpeg','image/png','image/webp'].includes(type)){cancel(response.body);throw err('MEDIA_UNAVAILABLE','图片类型不支持。');}
        const bytes=await readBytes(response,Math.min(MEDIA_LIMIT,MEDIA_TOTAL_LIMIT-total),controller.signal);
        if(imageType(bytes)!==type)throw err('MEDIA_UNAVAILABLE','图片内容与类型不符。');
        total+=bytes.length;images.push({type:'image_url',image_url:{url:`data:${type};base64,${base64(bytes)}`}});
        if(item.kind==='image')evidence.images++;else evidence.videoPosters++;
        evidence.attachments.push({index:images.length,kind:item.kind});
      }catch{failed++;if(parentSignal.aborted)throw parentSignal.reason;}
      if(controller.signal.aborted||total>=MEDIA_TOTAL_LIMIT)break;
    }
  }finally{clearTimeout(timer);parentSignal.removeEventListener('abort',abort);controller.abort();}
  if(failed||images.length<media.length)evidence.limitations.push('部分原帖图片或封面未读取成功，不能推断缺失画面的内容。');
  return {evidence,images};
}
function responseError(status){
  if([401,403].includes(status))return err('DIRECT_AUTH_REQUIRED','API Key 无效或没有该模型的访问权限。',status);
  if(status===402)return err('DIRECT_QUOTA','模型服务余额不足，请检查账户余额。',402);
  if(status===429)return err('DIRECT_RATE_LIMIT','模型服务请求频率或并发受限，请稍后再试。',429);
  if([400,404,422].includes(status))return err('DIRECT_CONFIG','服务不接受当前模型或请求设置，请检查模型名称和地址。',status);
  return err('DIRECT_NETWORK','模型服务暂时连接失败，请稍后再试。',502);
}
function checkTools(value){
  if(value?.function_call!=null||(value?.tool_calls!=null&&(!Array.isArray(value.tool_calls)||value.tool_calls.length))||value?.refusal!=null)throw err('DIRECT_FORMAT','模型返回了工具调用或拒绝内容，未作为评论显示。');
}
async function completionText(response,capability,signal){
  const contentType=(response.headers?.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(contentType==='application/json'){
    let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(response,RESPONSE_LIMIT,signal)));}catch(error){if(error?.code)throw error;throw err('DIRECT_FORMAT','模型返回格式无效，请重试。');}
    const choice=body?.choices?.[0],message=choice?.message;
    if(!Array.isArray(body?.choices)||body.choices.length!==1||message?.role!=='assistant'||typeof message.content!=='string'||choice.finish_reason!=='stop')throw err('DIRECT_FORMAT','模型回复未完整结束，未显示不完整内容。');
    checkTools(message);if(!capability.allowReasoning&&message.reasoning_content)throw err('DIRECT_FORMAT','模型未按快速模式返回内容，请检查模型设置。');
    return message.content;
  }
  if(contentType!=='text/event-stream'){cancel(response.body);throw err('DIRECT_FORMAT','模型服务没有返回支持的 JSON 或流式格式。');}
  let pending='',content='',done=false,stopped=false;const decoder=new TextDecoder('utf-8',{fatal:true});
  const processLine=line=>{
    if(!line.startsWith('data:'))return;const data=line.slice(5).trim();if(!data)return;
    if(data==='[DONE]'){done=true;return;}if(done)throw err('DIRECT_FORMAT','模型流在结束后返回了额外内容。');
    let event;try{event=JSON.parse(data);}catch{throw err('DIRECT_FORMAT','模型流式数据无效。');}
    if(event?.error)throw err('DIRECT_FORMAT','模型服务返回了生成错误。');
    if(!Array.isArray(event?.choices)||event.choices.length>1)throw err('DIRECT_FORMAT','模型返回了不支持的候选流。');
    if(!event.choices.length)return;
    const choice=event.choices[0],delta=choice.delta;
    if(choice.index!==0||!record(delta)||delta.role!=null&&delta.role!=='assistant')throw err('DIRECT_FORMAT','模型流式角色或内容无效。');
    checkTools(delta);if(!capability.allowReasoning&&delta.reasoning_content)throw err('DIRECT_FORMAT','模型未按快速模式返回内容，请检查模型设置。');
    if(delta.content!=null){if(typeof delta.content!=='string'||stopped)throw err('DIRECT_FORMAT','模型流式内容无效。');content+=delta.content;}
    if(choice.finish_reason!=null){if(choice.finish_reason!=='stop')throw err('DIRECT_FORMAT','模型回复未完整结束，未显示不完整内容。');stopped=true;}
  };
  const feed=text=>{pending+=text;let split;while((split=pending.indexOf('\n'))>=0){processLine(pending.slice(0,split).replace(/\r$/u,''));pending=pending.slice(split+1);}};
  await readBytes(response,RESPONSE_LIMIT,signal,bytes=>{feed(decoder.decode(bytes,{stream:true}));return !done;});
  feed(decoder.decode());if(pending)processLine(pending.replace(/\r$/u,''));
  if(!done||!stopped||!content)throw err('DIRECT_FORMAT','模型回复未完整结束，未显示不完整内容。');return content;
}

/** No localhost bridge, Node.js, API proxy, sync storage or plaintext fallback. */
export function createDirectWriter({storage=globalThis.chrome?.storage?.local,fetchImpl=globalThis.fetch,vault,cryptoImpl=globalThis.crypto,indexedDBImpl=globalThis.indexedDB,timeoutMs=60000,headersTimeoutMs=28000}={}){
  const secrets=vault||createBrowserVault({cryptoImpl,indexedDBImpl});
  let mutation=Promise.resolve();
  const load=async()=>{
    const value=(await storage.get(DIRECT_SETTINGS_KEY))?.[DIRECT_SETTINGS_KEY];
    if(value===undefined)return {version:1,provider:'deepseek',profiles:{}};
    if(!record(value)||value.version!==1||!isApiProvider(value.provider)||!record(value.profiles))throw err('DIRECT_SETTINGS','浏览器模型配置损坏，请重新保存。');
    const state={version:1,provider:value.provider,profiles:{}};
    for(const [provider,item] of Object.entries(value.profiles)){
      if(!isApiProvider(provider)||!record(item)||Object.keys(item).some(x=>!['model','baseUrl','credential'].includes(x)))throw err('DIRECT_SETTINGS','浏览器模型配置无效。');
      state.profiles[provider]={model:normalizeModel(provider,item.model),baseUrl:directBaseUrl(provider,item.baseUrl),...(item.credential?{credential:item.credential}:{})};
    }return state;
  };
  const metadata=async state=>{
    const profile=state.profiles[state.provider];let available=await secrets.available();
    if(available&&profile?.credential){try{await secrets.unseal(state.provider,profile.credential);}catch{available=false;}}
    return {provider:state.provider,model:profile?.model||'',...(profile?{baseUrl:profile.baseUrl}:{}),keyConfigured:!!profile?.credential,checkScope:'local',transport:'direct',
      profiles:Object.fromEntries(Object.entries(state.profiles).map(([id,p])=>[id,{model:p.model,baseUrl:p.baseUrl,keyConfigured:!!p.credential}])),
      credentialStorage:{backend:BROWSER_VAULT_BACKEND,encrypted:true,available,legacy:false},agents:[]};
  };
  const selected=async()=>{
    const state=await load(),descriptor=getProvider(state.provider),profile=state.profiles[state.provider];
    if(!profile?.model||descriptor.keyRequired&&!profile.credential)throw err('DIRECT_NOT_CONFIGURED','请先在模型设置中选择模型并保存 API Key。');
    return {provider:state.provider,...profile,apiKey:profile.credential?await secrets.unseal(state.provider,profile.credential):''};
  };
  return Object.freeze({
    async readSettings(){return metadata(await load());},
    async saveSettings(input){
      const operation=mutation.catch(()=>{}).then(async()=>{
        const selection=validateWriterSettings(input);if(!isApiProvider(selection.provider))throw err('DIRECT_AGENT_UNSUPPORTED','本地 Agent 需要另行安装本机连接器，请切换到本机连接模式。');
        const state=await load(),previous=state.profiles[selection.provider],descriptor=getProvider(selection.provider),apiKey=selection.apiKey||'';
        if(descriptor.keyRequired&&!apiKey&&!previous?.credential)throw err('DIRECT_NOT_CONFIGURED','请先填写该服务商的 API Key。');
        const credential=apiKey?await secrets.seal(selection.provider,apiKey):previous?.credential;
        const profile={model:selection.model,baseUrl:directBaseUrl(selection.provider,selection.baseUrl),...(credential?{credential}:{})};
        const next={version:1,provider:selection.provider,profiles:{...state.profiles,[selection.provider]:profile}};
        await storage.set({[DIRECT_SETTINGS_KEY]:next});return metadata(next);
      });mutation=operation.then(()=>{},()=>{});return operation;
    },
    async listModels(input){
      const selection=validateModelDiscovery(input),state=await load(),profile=state.profiles[selection.provider];
      const apiKey=selection.apiKey||(profile?.credential?await secrets.unseal(selection.provider,profile.credential):'');
      return discoverModels({...selection,apiKey,baseUrl:directBaseUrl(selection.provider,selection.baseUrl??profile?.baseUrl)},{fetchImpl,timeoutMs:8000,maxResponseBytes:RESPONSE_LIMIT});
    },
    async hasConfiguration(){try{const state=await load(),profile=state.profiles[state.provider];if(!profile?.model||getProvider(state.provider).keyRequired&&!profile.credential)return false;if(profile.credential)await secrets.unseal(state.provider,profile.credential);return true;}catch{return false;}},
    async health(){const settings=await metadata(await load());return {service:'x-comment-assistant-direct',version:'1',authenticated:!!settings.model&&(!getProvider(settings.provider).keyRequired&&!settings.keyConfigured||settings.keyConfigured&&settings.credentialStorage.available),authentication:'浏览器直连 API；实际访问权限在生成时确认',writerProvider:settings.provider,writerModel:settings.model,writerReasoningEffort:apiCapabilities(settings.provider,settings.model).reasoning,transport:'direct'};},
    async run(rawContext,rawPreferences={},signal){
      const startedAt=performance.now(),controller=new AbortController();let body,headerTimer;
      const onAbort=()=>controller.abort(err('CANCELLED','已取消生成。'));if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
      const timer=setTimeout(()=>controller.abort(err('DIRECT_TIMEOUT','生成超过一分钟，已停止，请稍后重试。')),Math.min(60000,Math.max(1,timeoutMs)));
      try{
        const selection=await abortable(selected(),controller.signal);
        const context=validateInlineContext(rawContext),preferences={...validatePreferences(rawPreferences),style:'all',tonePreset:rawPreferences.tonePreset??'auto'};
        const capability=apiCapabilities(selection.provider,selection.model);
        const prepared=await prepareBrowserMedia(context,capability,fetchImpl,controller.signal);context.mediaEvidence=prepared.evidence;
        if(!context.text?.trim()&&!context.quote?.trim()&&!prepared.images.length)throw err('MEDIA_UNAVAILABLE','未读取到原帖文字或图片，无法生成可靠回复。');
        const messages=buildMessages(context,preferences);if(prepared.images.length)messages[1].content=[{type:'text',text:messages[1].content},...prepared.images];
        const mediaReadyAt=performance.now(),payload={...buildApiPayload(selection.provider,selection.model,messages,preferences),stream:true};
        headerTimer=setTimeout(()=>controller.abort(err('DIRECT_HEADERS_TIMEOUT','模型服务等待响应超过二十八秒，已停止，请稍后重试。')),Math.min(28000,Math.max(1,headersTimeoutMs)));
        const fetchPromise=Promise.resolve().then(()=>fetchImpl(`${selection.baseUrl}/chat/completions`,{method:'POST',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'content-type':'application/json',accept:'text/event-stream, application/json',...(selection.apiKey?{authorization:`Bearer ${selection.apiKey}`}:{})},body:JSON.stringify(payload)}));
        fetchPromise.then(response=>{if(controller.signal.aborted)cancel(response?.body);},()=>{});
        const response=await abortable(fetchPromise,controller.signal);body=response?.body;clearTimeout(headerTimer);
        const headersAt=performance.now();if(!response?.ok){cancel(body);throw responseError(response?.status);}if(response.redirected){cancel(body);throw err('DIRECT_FORMAT','模型服务发生了不允许的跳转。');}
        const content=await completionText(response,capability,controller.signal),bodyAt=performance.now();if(controller.signal.aborted)throw controller.signal.reason;
        if(selection.apiKey&&content.includes(selection.apiKey))throw err('DIRECT_FORMAT','模型响应含不应显示的凭据内容，已停止。');let result;
        try{result=parseReply(content,'all',{personalExperience:preferences.personalExperience,tonePreset:preferences.tonePreset});}catch{throw err('INVALID_CANDIDATES','模型返回的回复格式或内容未通过检查，请重试。');}
        const completedAt=performance.now();return {...result,mediaEvidence:prepared.evidence,timings:{mediaPreparationMs:Math.round(mediaReadyAt-startedAt),responseHeadersMs:Math.round(headersAt-mediaReadyAt),responseBodyMs:Math.round(bodyAt-headersAt),responseParseMs:Math.round(completedAt-bodyAt),processAndModelMs:Math.round(completedAt-mediaReadyAt),totalMs:Math.round(completedAt-startedAt),cliReconnects:0}};
      }catch(error){cancel(body);if(controller.signal.aborted)throw controller.signal.reason;if(error?.code)throw error;throw err('DIRECT_NETWORK','无法连接模型服务，请检查网络、地址和浏览器访问权限。',502);}
      finally{clearTimeout(timer);clearTimeout(headerTimer);signal?.removeEventListener('abort',onAbort);controller.abort();}
    },
  });
}
