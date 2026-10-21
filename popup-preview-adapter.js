// Read-only rendering of the real popup. This page cannot save credentials,
// change the installed extension preferences, read X or generate replies.
globalThis.__X_REPLY_POPUP_PREVIEW__ = true;
async function publicPopupState() {
  let health = null;
  try {
    const response = await fetch('/health', {cache:'no-store', credentials:'omit'});
    if (response.ok) health = await response.json();
  } catch { /* The popup renders its normal offline state. */ }
  const {getProvider} = await import('/extension/provider-catalog.js');
  const descriptor = getProvider(health?.writerProvider);
  const provider = descriptor?.id || 'deepseek';
  const model = health?.writerModel || descriptor?.defaultModel || '';
  const keyConfigured = descriptor?.kind === 'api' && health?.authenticated === true;
  return {ok:true,enabled:true,tonePreset:'auto',health,
    connectionStatus:!health?'unavailable':health.authenticated?'connected':'auth-required',
    writerSettings:{provider,model,keyConfigured,baseUrl:descriptor?.baseUrl,
      profiles:{[provider]:{model,baseUrl:descriptor?.baseUrl,keyConfigured}},agents:[],checkScope:'local'}};
}
globalThis.chrome = {runtime:{async sendMessage(message) {
  if (message?.type === 'popupState') return publicPopupState();
  if (message?.type === 'getWriterSettings') {
    const state = await publicPopupState(); return {ok:true,writerSettings:state.writerSettings};
  }
  return {ok:false,code:'PREVIEW_READ_ONLY',error:'界面预览不保存配置，请在扩展小窗中修改。'};
}}};
