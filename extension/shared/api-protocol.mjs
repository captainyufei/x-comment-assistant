/** Provider-specific request options. Unknown model IDs use conservative defaults. */
export function apiCapabilities(provider,model){
  const base={vision:false,json:false,reasoning:'provider-default',allowReasoning:true,options:{},lengthField:'max_tokens'};
  if(provider==='deepseek')return ['deepseek-flash','deepseek-v4-pro'].includes(model)?{...base,vision:model==='deepseek-flash',json:true,allowReasoning:false,reasoning:'disabled',options:{thinking:{type:'disabled'},temperature:0.6}}:base;
  if(provider==='openai'){
    const fast=['gpt-5.4-mini','gpt-5.4-nano','gpt-5.4'].includes(model);
    const old=['gpt-4.1','gpt-4.1-mini','gpt-4.1-nano','gpt-4o','gpt-4o-mini'].includes(model);
    return {...base,vision:fast||old,json:fast||old,lengthField:'max_completion_tokens',reasoning:fast?'none':old?'disabled':'provider-default',options:fast?{reasoning_effort:'none'}:{}};
  }
  if(provider==='qwen')return ['qwen-flash','qwen-plus'].includes(model)?{...base,json:true,reasoning:'disabled',options:{enable_thinking:false}}:base;
  if(provider==='kimi'){
    const instant=['kimi-k2.5','kimi-k2.6'].includes(model);
    const k3=model==='kimi-k3';
    return {...base,json:instant,vision:instant,reasoning:instant?'disabled':k3?'low':'provider-default',options:instant?{thinking:{type:'disabled'}}:k3?{reasoning_effort:'low'}:{}};
  }
  if(provider==='minimax'){
    const m3=model==='MiniMax-M3',flash=model==='MiniMax-M3.1-Flash';
    return {...base,vision:m3||flash,reasoning:m3?'disabled':flash?'low':'provider-default',options:m3?{thinking:{type:'disabled'},reasoning_split:true}:flash?{reasoning_effort:'low',reasoning_split:true}:{}};
  }
  if(provider==='doubao'){
    const known=['doubao-seed-2-0-lite-260215','doubao-seed-2-0-mini-260215','doubao-seed-2-0-pro-260215'].includes(model);
    return {...base,json:known,vision:known,reasoning:known?'disabled':'provider-default',options:known?{thinking:{type:'disabled'}}:{}};
  }
  return base;
}
export function buildApiPayload(provider,model,messages,{style='all'}={}){
  const capability=apiCapabilities(provider,model);
  return {model,stream:false,[capability.lengthField]:capability.reasoning==='low'?4096:style==='mix'?1536:2048,
    ...(capability.json?{response_format:{type:'json_object'}}:{}),...capability.options,messages};
}
