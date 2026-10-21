// Browser preview adapter. Generation still uses the real, authenticated local bridge.
import {mountPanel} from '/extension/panel.js';
const token = __BRIDGE_TOKEN__;
const context = __PREVIEW_CONTEXT__;
let state = {
  contexts: [context], selectedContext: context, results: [], resultsContext: null,
  preferences: {style:'all', personalExperience:'', tone:'', tonePreset:'auto'},
  settings: {bridgeUrl:'http://127.0.0.1:8769',paired:true}, job:null
};
async function bridge(path, method='GET', body) {
  const response = await fetch(path, {method,headers:{'X-Reply-Bridge-Token':token,'X-Reply-Protocol':'4',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error),{code:result.code});
  return result;
}
async function send(message) {
  try {
    switch(message.type) {
      case 'getState': return {ok:true,state};
      case 'capture': state.contexts=[context]; state.selectedContext=context; return {ok:true,state};
      case 'selectContext': state.selectedContext=context; return {ok:true,state};
      case 'checkBridge': return {ok:true,health:await bridge('/health')};
      case 'saveSettings':
        if(message.pairingCode) {
          const response=await fetch('/pair',{method:'POST',headers:{'Content-Type':'application/json','X-Reply-Bridge-Token':message.pairingCode},body:'{}'});
          if(!response.ok) return {ok:false,error:'配对码无效。请从本机配对页复制。'};
        }
        state.preferences={...state.preferences,...message.preferences}; return {ok:true,state};
      case 'generate': {
        const preferences={...message.preferences,tonePreset:message.preferences?.tonePreset??state.preferences.tonePreset??'auto'};
        const result=await bridge('/jobs','POST',{context:message.context,preferences});
        state.job=result.job; state.preferences=preferences; return {ok:true,job:result.job};
      }
      case 'pollJob':
      case 'cancelJob': {
        const result=await bridge(`/jobs/${encodeURIComponent(message.id)}`,message.type==='cancelJob'?'DELETE':'GET');
        state.job=result.job;
        if(result.job.status==='completed') {
          state.results=result.job.candidates.map(candidate=>({...candidate,context:result.job.context}));
          state.resultsContext=result.job.context;
        }
        return {ok:true,job:result.job,state};
      }
      case 'openReply': {
        const source=new URL(message.context.url);
        const match=/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})$/.exec(source.pathname);
        if(source.origin!=='https://x.com'||!match||match[2]!==message.context.id||![...message.draftText.trim()].length||[...message.draftText].length>280) throw new Error('原帖链接或回复内容不正确。');
        const intent=new URL('https://x.com/intent/post');
        intent.searchParams.set('in_reply_to',match[2]); intent.searchParams.set('text',message.draftText);
        window.open(intent.href,'_blank','noopener'); return {ok:true,opened:true};
      }
      default: return {ok:false,error:'预览未提供此操作。'};
    }
  } catch(error) { return {ok:false,error:error.message,code:error.code}; }
}
const panel=mountPanel(send);
await panel.ready;
const notice=document.getElementById('installation-notice');
notice.textContent='本机界面试用 · 使用固定示例，点击生成会调用当前模型，不会发布到 X。';
notice.hidden=false;
