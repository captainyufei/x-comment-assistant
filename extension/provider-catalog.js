/** Public provider metadata shared by the popup and local bridge. Never contains credentials. */
const entries = [
  {id:'deepseek',label:'DeepSeek',kind:'api',baseUrl:'https://api.deepseek.com',defaultModel:'deepseek-flash',models:['deepseek-flash','deepseek-v4-pro'],hosts:['api.deepseek.com'],paths:['','/v1']},
  {id:'openai',label:'OpenAI',kind:'api',baseUrl:'https://api.openai.com/v1',defaultModel:'gpt-5.4-mini',models:['gpt-5.4-mini'],hosts:['api.openai.com'],paths:['/v1']},
  {id:'qwen',label:'千问 · Qwen',kind:'api',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',defaultModel:'qwen-flash',models:['qwen-flash','qwen-plus'],hosts:['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'],paths:['/compatible-mode/v1'],workspaceHost:true},
  {id:'kimi',label:'Kimi',kind:'api',baseUrl:'https://api.moonshot.cn/v1',defaultModel:'kimi-k2.6',models:['kimi-k2.6','kimi-k2.5'],hosts:['api.moonshot.cn','api.moonshot.ai'],paths:['/v1']},
  {id:'minimax',label:'MiniMax',kind:'api',baseUrl:'https://api.minimax.cn/v1',defaultModel:'MiniMax-M3',models:['MiniMax-M3','MiniMax-M3.1-Flash'],hosts:['api.minimax.cn','api.minimax.io'],paths:['/v1']},
  {id:'doubao',label:'豆包 · 火山方舟',kind:'api',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',defaultModel:'',models:[],hosts:['ark.cn-beijing.volces.com'],paths:['/api/v3']},
  {id:'codex',label:'Codex',kind:'agent',defaultModel:'',models:[]},
  {id:'claude',label:'Claude Code',kind:'agent',defaultModel:'',models:[]},
  {id:'gemini',label:'Gemini CLI',kind:'agent',defaultModel:'',models:[],supported:false},
  {id:'ollama',label:'Ollama',kind:'local',baseUrl:'http://127.0.0.1:11434/v1',defaultModel:'',models:[]},
  {id:'lmstudio',label:'LM Studio',kind:'local',baseUrl:'http://127.0.0.1:1234/v1',defaultModel:'',models:[]},
];
export const PROVIDERS = Object.freeze(entries.map(item=>Object.freeze({...item,keyRequired:item.kind==='api',models:Object.freeze(item.models),...(item.hosts?{hosts:Object.freeze(item.hosts)}:{}),...(item.paths?{paths:Object.freeze(item.paths)}:{})})));
export function getProvider(id){return PROVIDERS.find(item=>item.id===id)||null;}
export function isAgentProvider(id){return getProvider(id)?.kind==='agent';}
export function isApiProvider(id){return ['api','local'].includes(getProvider(id)?.kind);}
export function normalizeModel(provider,model){
  const descriptor=getProvider(provider);
  if(!descriptor)throw new Error('请选择支持的模型来源。');
  if(descriptor.kind==='agent'){
    if(model!==undefined&&model!=='')throw new Error('本地 Agent 使用自身模型配置。');
    return '';
  }
  const value=model===undefined?descriptor.defaultModel:model;
  if(typeof value!=='string'||!value||value.length>160||!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)||/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)||value.split('/').some(part=>part==='..'||part==='.'))throw new Error('请填写有效的模型名称或接入点 ID。');
  return value;
}
export function normalizeBaseUrl(provider,value){
  const descriptor=getProvider(provider);
  if(!descriptor||descriptor.kind==='agent')throw new Error('模型服务地址无效。');
  const input=value===undefined||value===''?descriptor.baseUrl:value;
  if(typeof input!=='string'||input.length>500||/[\s\0]/u.test(input))throw new Error('模型服务地址无效。');
  let url;try{url=new URL(input);}catch{throw new Error('请填写完整的模型服务地址。');}
  if(url.username||url.password||url.search||url.hash)throw new Error('服务地址不能包含凭据、查询参数或片段。');
  const path=url.pathname.replace(/\/+$/u,'');
  if(descriptor.kind==='local'){
    if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.port||url.port==='8769'||path!=='/v1')throw new Error('本地模型请使用本机 HTTP 地址和 /v1 路径，例如 http://127.0.0.1:11434/v1。');
    if(url.hostname==='localhost')url.hostname='127.0.0.1';
  }else{
    const workspace=descriptor.workspaceHost&&/^[a-z0-9][a-z0-9-]*\.cn-beijing\.maas\.aliyuncs\.com$/u.test(url.hostname);
    if(url.protocol!=='https:'||url.port||(!descriptor.hosts.includes(url.hostname)&&!workspace)||!descriptor.paths.includes(path))throw new Error('请使用该服务商的官方 API 地址。');
  }
  return url.origin+path;
}
