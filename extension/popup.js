import {PROVIDERS,getProvider,normalizeModel,normalizeBaseUrl} from './provider-catalog.js';
import './reply-style-catalog.js';

const {styles:REPLY_STYLES,labels:STYLE_LABELS}=globalThis.XReplyStyleCatalog;
const TONES = Object.freeze({auto:'自动匹配',...STYLE_LABELS});
const API_PROVIDERS=PROVIDERS.filter(item=>item.kind==='api');
const LOCAL_PROVIDERS=PROVIDERS.filter(item=>item.kind==='local');
const AGENT_PROVIDERS=PROVIDERS.filter(item=>item.kind==='agent');

export function mountPopup(sendFn, {preview = false} = {}) {
  if(typeof sendFn!=='function')throw new TypeError('mountPopup 需要消息发送函数');
  const doc=document;
  const $=id=>doc.getElementById(id);
  let state={enabled:true,tonePreset:'auto',transport:'direct',connectionStatus:'checking',health:null,writerSettings:null};
  let busy=false,destroyed=false,settingsTab='api';
  const modelRequests={api:0,local:0},modelLoading={api:false,local:false},modelCache=new Map();
  const manualModel={api:false,local:false};
  const listeners=[];
  function listen(node,event,handler){node.addEventListener(event,handler);listeners.push(()=>node.removeEventListener(event,handler));}
  const styleOptions=[{id:'auto',label:TONES.auto,description:'从下方风格中按原帖选择'},...REPLY_STYLES];
  $('tone-menu').replaceChildren();
  for(const style of styleOptions){
    const option=doc.createElement('button'),copy=doc.createElement('span'),label=doc.createElement('strong'),description=doc.createElement('small'),check=doc.createElement('span');
    option.type='button';option.className='tone-option';option.setAttribute('role','option');option.dataset.tone=style.id;
    label.textContent=style.label;description.textContent=style.description;copy.append(label,description);
    check.className='option-check';check.setAttribute('aria-hidden','true');check.textContent='✓';option.append(copy,check);$('tone-menu').append(option);
  }
  function notice(text,{error=false}={}){if(destroyed)return;$('notice').textContent=text;$('notice').className=`notice${error?' error':''}${preview?' preview':''}`;$('notice').hidden=!text;}
  function clearKey(){for(const id of ['api-key','local-api-key']){const node=$(id);if(node)node.value='';}}
  function cancelModelViews(){for(const kind of ['api','local']){modelRequests[kind]++;modelLoading[kind]=false;$(`${kind}-model-refresh`).disabled=busy;}}
  function transport(){return state.transport==='bridge'?'bridge':'direct';}
  function writerRequest(message){return request({...message,transport:transport()});}
  function storageNote(saved){
    if(transport()==='direct')return saved.keyConfigured?'密钥已加密保存在当前浏览器，留空沿用；不通过浏览器同步。':'密钥使用 AES-GCM 加密保存在当前浏览器，不通过浏览器同步。';
    const storage=state.writerSettings?.credentialStorage;
    if(storage?.legacy)return '现有密钥来自旧配置；点击保存后迁移到系统加密存储。';
    if(storage?.backend==='macos-keychain')return saved.keyConfigured?'已保存到 macOS 钥匙串，留空沿用。':'密钥保存到 macOS 钥匙串，各服务商分别保存。';
    if(storage?.backend==='windows-dpapi')return saved.keyConfigured?'已由 Windows 用户账户加密，留空沿用。':'密钥使用 Windows DPAPI 加密，各服务商分别保存。';
    return '密钥由本机后台保管，不存入浏览器同步；保存时检查系统加密能力。';
  }
  function modelNote(kind,text,error=false){$(`${kind}-model-note`).textContent=text;$(`${kind}-model-note`).className=`field-note model-note${error?' error':''}`;}
  function modelChoices(kind,models=[],prompt='请选择模型'){
    const select=$(`${kind}-models`),current=$(`${kind}-model`).value;
    select.replaceChildren();
    const empty=document.createElement('option');empty.value='';empty.textContent=prompt;select.append(empty);
    for(const item of models){const option=document.createElement('option');option.value=item.id;option.textContent=item.id;option.dataset.remoteModel='true';select.append(option);}
    if(current&&!models.some(item=>item.id===current)&&!manualModel[kind]){
      const saved=document.createElement('option');saved.value=current;saved.textContent=`当前：${current}（未在已读取列表中）`;select.append(saved);
    }
    const manual=document.createElement('option');manual.value='__manual__';manual.textContent='手动填写模型名称…';select.append(manual);
    select.value=manualModel[kind]?'__manual__':current||'';
    $(`${kind}-model`).hidden=!manualModel[kind];
  }
  function displayModels(kind,list){
    modelChoices(kind,list.models,list.models.length?'请选择模型':'服务未返回模型，可手动填写');
    modelNote(kind,list.models.length?`已从服务读取${list.truncated?'前':''} ${list.models.length} 个模型，可选择或手填。`:'服务未返回模型，可手动填写。');
  }
  async function readModels(kind,{force=false}={}){
    if(destroyed||busy||preview||$('settings-screen').hidden||settingsTab!==kind)return;
    const local=kind==='local',provider=$(local?'model-provider':'provider').value;
    const descriptor=getProvider(provider);if(!descriptor||descriptor.kind!==(local?'local':'api'))return;
    let baseUrl;try{baseUrl=normalizeBaseUrl(provider,$(`${kind}-base-url`).value.trim());}catch{modelNote(kind,'请先填写有效的服务地址。',true);return;}
    const apiKey=$(local?'local-api-key':'api-key').value.trim();
    if(!local&&!apiKey&&!profile(provider).keyConfigured){modelChoices(kind,[],'先填写 API Key 以获取模型');modelNote(kind,'填写 API Key 后自动读取，也可手动填写模型。');return;}
    const cacheId=`${provider}|${baseUrl}`,cached=modelCache.get(cacheId);
    if(!force&&!apiKey&&cached&&Date.now()-cached.at<60000){displayModels(kind,cached.list);return;}
    const requestId=++modelRequests[kind];modelLoading[kind]=true;render();modelNote(kind,'正在从服务读取模型…');
    const settings={provider,baseUrl,...(apiKey?{apiKey}:{})};
    try{
      const result=await writerRequest({type:'listWriterModels',settings});
      if(destroyed||requestId!==modelRequests[kind])return;
      const list=result.modelList;
      if(!list||list.provider!==provider||list.baseUrl!==baseUrl||list.source!=='remote'||!Array.isArray(list.models)||list.models.length>2000)throw new Error('invalid list');
      const models=[...new Set(list.models.map(item=>normalizeModel(provider,item?.id)))].map(id=>({id}));
      const safeList={...list,models};
      if(!apiKey)modelCache.set(cacheId,{at:Date.now(),list:safeList});
      displayModels(kind,safeList);
    }catch(error){
      if(destroyed||requestId!==modelRequests[kind])return;
      const messages={MODEL_DISCOVERY_UNSUPPORTED:'此服务商暂不提供模型列表，请手填模型或接入点 ID。',MODEL_DISCOVERY_AUTH:'密钥验证失败，请检查当前服务商的 API Key。',API_KEY_REQUIRED:'请填写当前服务商的 API Key 后读取。',MODEL_DISCOVERY_TIMEOUT:'读取超时，可刷新列表或手动填写。',BUSY:'正在读取，请稍后刷新列表。',CREDENTIAL_STORE_UNAVAILABLE:transport()==='direct'?'浏览器密钥存储不可用，请重试。':'系统密钥存储不可用，请解锁钥匙串或检查 Windows 用户环境。'};
      modelNote(kind,messages[error?.code]||'暂时无法读取，可刷新列表或手动填写模型。',true);
    }finally{if(settings.apiKey)settings.apiKey='';if(requestId===modelRequests[kind]){modelLoading[kind]=false;render();}}
  }
  function closeTone(){$('tone-menu').hidden=true;$('tone-toggle').setAttribute('aria-expanded','false');}
  function selectedProvider(){return state.writerSettings?.provider||state.health?.writerProvider;}
  function profile(id){
    const saved=state.writerSettings?.profiles?.[id];
    if(saved&&typeof saved==='object')return saved;
    if(state.writerSettings?.provider===id)return state.writerSettings;
    return selectedProvider()===id?{model:state.health?.writerModel}:{};
  }
  function options(node,items){node.replaceChildren();for(const item of items){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;node.append(option);}}
  options($('provider'),API_PROVIDERS);options($('model-provider'),LOCAL_PROVIDERS);
  function agentState(id){
    const descriptor=getProvider(id),reported=state.writerSettings?.agents?.find(item=>item.id===id);
    const supported=descriptor?.supported!==false&&reported?.supported!==false;
    const installed=reported?.installed;
    return {supported,installed,selectable:transport()==='bridge'&&supported&&(installed===true||(!reported&&id==='codex'))};
  }
  function loadAgents(){
    const current=$('agent-provider').value,active=selectedProvider();
    $('agent-provider').replaceChildren();
    for(const descriptor of AGENT_PROVIDERS){
      const status=agentState(descriptor.id),option=document.createElement('option');
      option.value=descriptor.id;option.disabled=!status.selectable;
      option.textContent=`${descriptor.label} · ${transport()==='direct'?'需连接本机桥接':!status.supported?'暂未适配':status.installed===true?'已安装':status.installed===false?'未安装':'安装状态待检查'}`;
      $('agent-provider').append(option);
    }
    const candidates=[active,current,...AGENT_PROVIDERS.map(item=>item.id)];
    $('agent-provider').value=candidates.find(id=>id&&agentState(id).selectable)||'';
    renderAgentNote();
  }
  function renderAgentNote(){
    if(destroyed)return;
    const descriptor=getProvider($('agent-provider').value);
    $('agent-bridge-actions').hidden=transport()==='bridge'&&state.connectionStatus==='connected';
    $('connect-agent').disabled=busy;
    if(transport()==='direct'){
      $('agent-note').textContent='浏览器不能直接运行本机 Agent。仅此模式需要额外安装可选桥接；模型 API 和本地模型连接无需此桥接。';
      $('save-agent').disabled=true;return;
    }
    $('agent-note').textContent=descriptor?(descriptor.id==='codex'?'Codex 复用本机登录，使用插件的低推理写作配置。':`${descriptor.label} 复用本机登录，以 CLI 默认模型生成；生成时确认登录状态。`):'未找到可用的本地 Agent，请先安装并登录 Codex 或 Claude Code。';
    $('save-agent').disabled=busy||!descriptor||!agentState(descriptor.id).selectable;
  }
  function loadProvider(kind,id){
    cancelModelViews();
    clearKey();
    const descriptor=getProvider(id);
    if(!descriptor||descriptor.kind!==kind)return;
    const saved=profile(id),local=kind==='local',prefix=local?'local':'api';
    $(local?'model-provider':'provider').value=id;
    $(`${prefix}-model`).value=typeof saved.model==='string'&&saved.model?saved.model:'';
    $(`${prefix}-base-url`).value=typeof saved.baseUrl==='string'&&saved.baseUrl?saved.baseUrl:descriptor.baseUrl;
    const key=$(local?'local-api-key':'api-key');
    key.placeholder=saved.keyConfigured?'已保存，留空沿用；填写可更换':local?'未设置认证可留空':`输入 ${descriptor.label} API Key`;
    manualModel[prefix]=false;
    modelChoices(prefix,[],local?'读取本机模型，或手动填写':saved.keyConfigured?'正在读取模型…':'先填写 API Key 以获取模型');
    modelNote(prefix,local?'读取本机服务的模型，不会下载模型。':'填写密钥后自动读取，也可手动填写模型。');
    $(local?'local-key-note':'key-note').textContent=local&&!saved.keyConfigured?'先在本机启动服务并加载模型，不会自动下载。':storageNote(saved);
  }
  async function request(message){const result=await sendFn(message);if(!result?.ok){const error=new Error('操作未完成');error.code=result?.code;throw error;}return result;}
  function render(){
    if(destroyed)return;
    $('enabled').checked=state.enabled!==false;$('enabled').disabled=busy;
    const settings=state.writerSettings||{},provider=settings.provider||state.health?.writerProvider,descriptor=getProvider(provider);
    $('engine-name').textContent=descriptor?.label||(provider?'未知来源':'尚未配置');
    $('engine-model').textContent=settings.model||state.health?.writerModel||(descriptor?.kind==='agent'?'使用 Agent 自身模型':'打开模型设置');
    $('engine-mark').textContent=descriptor?.kind==='local'?'L':provider==='qwen'?'Q':provider==='kimi'?'K':provider==='minimax'?'M':provider==='doubao'?'豆':provider==='openai'?'O':provider==='claude'?'C':provider==='gemini'?'G':provider==='codex'?'C':'D';
    $('engine-mark').className=`engine-mark${descriptor?.kind==='agent'||descriptor?.kind==='local'?' codex':''}`;
    const direct=transport()==='direct';
    const configured=Boolean(descriptor&&settings.model&&(descriptor.kind==='local'||settings.keyConfigured));
    const connection=direct?(state.connectionStatus==='checking'?'checking':configured?'connected':'auth-required'):['connected','unavailable','auth-required'].includes(state.connectionStatus)?state.connectionStatus:'checking';
    $('connection').className=`connection ${connection}${connection==='connected'&&state.writerSettingsError?' settings-unread':''}`;
    $('connection-text').textContent=direct?(connection==='checking'?'正在读取配置…':configured?'模型已配置，生成时验证':'尚未配置模型'):connection==='connected'?'本机服务连接正常':connection==='auth-required'?'本机连接需要恢复':connection==='unavailable'?'本机服务未连接':'正在检查连接…';
    $('refresh-status').disabled=busy;$('refresh-status').hidden=direct?!state.writerSettingsError:connection==='connected'&&!state.writerSettingsError;
    $('reply-transport').value=transport();$('reply-transport').disabled=busy;
    $('transport-note').textContent=direct?'插件可直连 API 或已运行的本地模型服务。切换方式不会复制密钥。':'使用本机桥接配置。切换为浏览器直连后，需另填一次 API Key。';
    const tone=Object.hasOwn(TONES,state.tonePreset)?state.tonePreset:'auto';$('tone-value').textContent=TONES[tone];
    for(const option of document.querySelectorAll('[data-tone]')){option.setAttribute('aria-selected',String(option.dataset.tone===tone));option.disabled=busy;}
    $('tone-toggle').disabled=busy;
    $('usage-note').textContent=state.enabled===false?'助手已暂停，重新启用后可在 X 回复框生成。':'打开 X 回复框，点击生成后挑选四条候选。';
    for(const node of document.querySelectorAll('form input,form select,form button'))node.disabled=busy;
    for(const kind of ['api','local'])$(`${kind}-model-refresh`).disabled=busy||modelLoading[kind];
    for(const id of ['api-tab','agent-tab','local-tab','back-home'])$(id).disabled=busy;
    renderAgentNote();
  }
  function tab(which){
    settingsTab=which;cancelModelViews();clearKey();
    for(const id of ['api','agent','local']){$(`${id}-tab`).setAttribute('aria-selected',String(which===id));$(`${id}-settings`).hidden=which!==id;}
  }
  function showSettings(){
    closeTone();notice('');clearKey();$('home-screen').hidden=true;$('settings-screen').hidden=false;
    const active=selectedProvider(),kind=getProvider(active)?.kind;
    loadProvider('api',kind==='api'?active:API_PROVIDERS[0].id);
    loadProvider('local',kind==='local'?active:LOCAL_PROVIDERS[0].id);
    loadAgents();tab(kind==='agent'?'agent':kind==='local'?'local':'api');
    if(settingsTab!=='agent')void readModels(settingsTab);
  }
  function showHome(){cancelModelViews();clearKey();notice('');$('settings-screen').hidden=true;$('home-screen').hidden=false;}
  async function refresh(){
    if(busy||destroyed)return;busy=true;render();
    try{const result=await request({type:'popupState'});if(destroyed)return;state={...state,...result,writerSettingsError:result.writerSettingsError??null};loadAgents();render();if(state.connectionStatus==='connected'&&state.writerSettingsError)notice('服务已连接，模型设置暂未读取，点击重试。');else if(!preview)notice('');}
    catch{state.connectionStatus='unavailable';render();notice(transport()==='direct'?'暂时无法读取浏览器配置，请重试。':'暂时无法读取本机配置，请重试。',{error:true});}
    finally{busy=false;render();}
  }
  async function savePreferences(update){if(busy||destroyed)return;if(preview){render();notice('这是界面预览，设置请在浏览器扩展小窗修改。');return;}busy=true;render();try{const result=await request({type:'savePopupPreferences',...update});state={...state,enabled:result.enabled,tonePreset:result.tonePreset};notice('');}catch{notice('设置未保存，请重试。',{error:true});}finally{busy=false;render();}}
  async function saveWriter(settings){
    if(busy||destroyed)return;
    if(preview){clearKey();notice('这是界面预览，模型设置请在浏览器扩展小窗保存。');if(settings.apiKey)settings.apiKey='';return;}
    let saved=false;
    busy=true;render();notice(transport()==='direct'?'正在保存浏览器配置…':'正在保存本机配置…');
    try{
      const result=await writerRequest({type:'saveWriterSettings',settings});if(destroyed)return;cancelModelViews();modelCache.clear();clearKey();state.writerSettings=result.writerSettings;
      const next=await request({type:'popupState'});if(destroyed)return;state={...state,...next,writerSettingsError:next.writerSettingsError??null};loadAgents();
      if(getProvider(settings.provider)?.kind==='api')$('key-note').textContent=storageNote(profile(settings.provider));
      if(getProvider(settings.provider)?.kind==='local')$('local-key-note').textContent=storageNote(profile(settings.provider));
      saved=true;
      notice(state.connectionStatus==='connected'&&state.writerSettingsError?'服务已连接，模型设置暂未读取，点击重试。':getProvider(settings.provider)?.kind==='agent'?'已保存本地 Agent 配置，登录和模型状态在生成时确认。':transport()==='direct'?'已保存浏览器配置，生成时验证模型连接。':'已保存本机配置，API 连接会在生成时验证。');
    }catch(error){
      clearKey();const needsKey=['DEEPSEEK_KEY_REQUIRED','API_KEY_REQUIRED','KEY_REQUIRED'].includes(error?.code);
      notice(needsKey?'请填写当前服务商的 API Key 后再保存。':error?.code==='CREDENTIAL_STORE_UNAVAILABLE'?(transport()==='direct'?'浏览器密钥存储不可用，未保存；请重试。':'系统密钥存储不可用，未保存；请检查钥匙串或 Windows 用户环境。'):error?.code==='BUSY'?'正在生成，请完成或停止后再修改配置。':transport()==='direct'?'模型配置未保存，请检查配置后重试。':'模型配置未保存或检查未完成，请确认本机服务后重试。',{error:true});
    }finally{if(settings.apiKey)settings.apiKey='';busy=false;render();if(saved&&settingsTab!=='agent')void readModels(settingsTab);}
  }
  async function switchTransport(next){
    if(busy||destroyed)return;
    if(preview){render();notice('这是界面预览，设置请在浏览器扩展小窗修改。');return;}
    if(next!=='direct'&&next!=='bridge')return;
    cancelModelViews();modelCache.clear();clearKey();busy=true;render();notice('正在切换连接方式…');
    try{
      await request({type:'setReplyTransport',transport:next});
      const result=await request({type:'popupState'});if(destroyed)return;
      state={...state,...result,transport:next,writerSettingsError:result.writerSettingsError??null};
      loadProvider('api',getProvider(selectedProvider())?.kind==='api'?selectedProvider():API_PROVIDERS[0].id);
      loadProvider('local',getProvider(selectedProvider())?.kind==='local'?selectedProvider():LOCAL_PROVIDERS[0].id);loadAgents();
      notice(next==='direct'?'已切换为浏览器直连，请填写自己的 API Key；本机桥接密钥不会复制。':state.connectionStatus==='connected'?'本机桥接已连接，可选择已安装的 Agent。':'尚未连接本机桥接，请先按使用说明安装并启动，然后重试。');
    }catch(error){notice(error?.code==='BUSY'?'正在生成，请完成或停止后再切换。':'连接方式未切换，请重试。',{error:true});}
    finally{busy=false;render();if(settingsTab!=='agent')void readModels(settingsTab);}
  }
  function submitModel(kind){
    const local=kind==='local',prefix=local?'local':'api',provider=$(local?'model-provider':'provider').value;
    let settings;
    try{settings={provider,model:normalizeModel(provider,$(`${prefix}-model`).value.trim()),baseUrl:normalizeBaseUrl(provider,$(`${prefix}-base-url`).value.trim())};}
    catch(error){notice(error.message,{error:true});return;}
    const apiKey=$(local?'local-api-key':'api-key').value.trim();if(apiKey)settings.apiKey=apiKey;saveWriter(settings);
  }
  listen($('enabled'),'change',()=>savePreferences({enabled:$('enabled').checked}));
  listen($('tone-toggle'),'click',()=>{const open=$('tone-menu').hidden;$('tone-menu').hidden=!open;$('tone-toggle').setAttribute('aria-expanded',String(open));if(open)$('tone-menu').querySelector('[aria-selected="true"]')?.scrollIntoView?.({block:'nearest'});});
  for(const option of document.querySelectorAll('[data-tone]'))listen(option,'click',()=>{closeTone();savePreferences({tonePreset:option.dataset.tone});});
  listen(document,'keydown',event=>{if(event.key==='Escape')closeTone();});
  listen($('refresh-status'),'click',refresh);
  listen($('reply-transport'),'change',()=>switchTransport($('reply-transport').value));
  listen($('connect-agent'),'click',()=>transport()==='bridge'?refresh():switchTransport('bridge'));
  listen($('engine-settings'),'click',showSettings);listen($('open-settings'),'click',showSettings);listen($('back-home'),'click',showHome);
  for(const id of ['api','agent','local'])listen($(`${id}-tab`),'click',()=>{notice('');tab(id);if(id!=='agent')void readModels(id);});
  listen($('provider'),'change',()=>{notice('');loadProvider('api',$('provider').value);void readModels('api');});
  listen($('model-provider'),'change',()=>{notice('');loadProvider('local',$('model-provider').value);void readModels('local');});
  for(const kind of ['api','local']){
    listen($(`${kind}-models`),'change',()=>{
      const value=$(`${kind}-models`).value;
      manualModel[kind]=value==='__manual__';$(`${kind}-model`).hidden=!manualModel[kind];
      if(manualModel[kind])$(`${kind}-model`).focus();else $(`${kind}-model`).value=value;
    });
    listen($(`${kind}-model-refresh`),'click',()=>void readModels(kind,{force:true}));
    listen($(kind==='local'?'local-api-key':'api-key'),'input',()=>{modelRequests[kind]++;modelLoading[kind]=false;modelChoices(kind,[],'读取模型，或手动填写');render();});
    listen($(kind==='local'?'local-api-key':'api-key'),'blur',()=>{if($(kind==='local'?'local-api-key':'api-key').value.trim())void readModels(kind,{force:true});});
    listen($(`${kind}-base-url`),'change',()=>{modelRequests[kind]++;modelLoading[kind]=false;modelChoices(kind,[],'读取模型，或手动填写');void readModels(kind,{force:true});});
  }
  listen($('agent-provider'),'change',()=>{notice('');clearKey();renderAgentNote();});
  listen($('api-settings'),'submit',event=>{event.preventDefault();submitModel('api');});
  listen($('local-settings'),'submit',event=>{event.preventDefault();submitModel('local');});
  listen($('agent-settings'),'submit',event=>{event.preventDefault();const provider=$('agent-provider').value;if(!agentState(provider).selectable){notice('请先安装并登录可用的本地 Agent。',{error:true});return;}saveWriter({provider});});
  listen(globalThis,'pagehide',()=>{cancelModelViews();clearKey();});
  loadProvider('api',API_PROVIDERS[0].id);loadProvider('local',LOCAL_PROVIDERS[0].id);loadAgents();render();
  if(preview)notice('界面预览 · 设置请在扩展小窗中保存。');
  const ready=refresh();
  return {ready,refresh,destroy(){destroyed=true;cancelModelViews();modelCache.clear();clearKey();for(const remove of listeners)remove();},get settingsTab(){return settingsTab;}};
}

if (globalThis.chrome?.runtime?.sendMessage) {
  mountPopup(message=>chrome.runtime.sendMessage(message), {preview:globalThis.__X_REPLY_POPUP_PREVIEW__===true});
}
