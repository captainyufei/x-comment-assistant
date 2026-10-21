import {validateMedia} from './media-core.js';
import './reply-style-catalog.js';
import {getProvider,isAgentProvider,normalizeModel,normalizeBaseUrl} from './provider-catalog.js';

export const BRIDGE_URL = "http://127.0.0.1:8769";
export const REPLY_PROTOCOL_VERSION = '4';
export const STYLES = new Set(["all", "mix", "witty", "humor", "insight", "story"]);
export const DEFAULT_PREFERENCES = Object.freeze({style: "all", personalExperience: "", tone: ""});
export const DEFAULT_POPUP_PREFERENCES = Object.freeze({enabled: true, tonePreset: "auto"});
const REPLY_STYLE_CATALOG = globalThis.XReplyStyleCatalog;
export const TONE_PRESETS = Object.freeze({auto: '', ...Object.fromEntries(REPLY_STYLE_CATALOG.styles.map(item => [item.id, item.instruction]))});
export function publicToneSnapshot(tonePreset, hasCustomTone = false) {
  return typeof tonePreset === 'string' && Object.hasOwn(TONE_PRESETS, tonePreset) ? {tonePreset, ...(hasCustomTone === true ? {hasCustomTone: true} : {})} : {};
}
export const DEEPSEEK_MODELS = Object.freeze(["deepseek-flash", "deepseek-v4-pro"]);

export function validatePopupPreferences(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["enabled", "tonePreset"].includes(key))) throw new Error("插件偏好无效。");
  const enabled = input.enabled === undefined ? DEFAULT_POPUP_PREFERENCES.enabled : input.enabled;
  const tonePreset = input.tonePreset === undefined ? DEFAULT_POPUP_PREFERENCES.tonePreset : input.tonePreset;
  if (typeof enabled !== "boolean" || typeof tonePreset !== "string" || !Object.hasOwn(TONE_PRESETS, tonePreset)) throw new Error("插件偏好无效。");
  return {enabled, tonePreset};
}

export function generationPreferences(input, popupPreferences) {
  const preferences = validatePreferences(input);
  const {tonePreset} = validatePopupPreferences(popupPreferences);
  const preset = TONE_PRESETS[tonePreset];
  // Only this request gives the explicit selection priority. Preserve the saved
  // custom preference while bounding the composed writer input to 600 characters.
  const selectedTone = preset ? `本次选择语气（优先）：${preset}` : '';
  const supplemental = preferences.tone.trim() ? '补充偏好（不冲突时参考）：' : '';
  const customBudget = 600 - Array.from(selectedTone).length - (selectedTone && supplemental ? 1 : 0) - Array.from(supplemental).length;
  const customTone = supplemental ? supplemental + Array.from(preferences.tone).slice(0, Math.max(0, customBudget)).join('') : '';
  return {...preferences, style: "all", tonePreset, tone: [selectedTone, customTone].filter(Boolean).join("\n")};
}

export function validateWriterSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["provider", "model", "baseUrl", "apiKey"].includes(key)) ||
      !getProvider(input.provider)) throw new Error("模型配置无效。");
  if (isAgentProvider(input.provider)) {
    if (input.model !== undefined || input.baseUrl !== undefined || input.apiKey !== undefined) throw new Error("本地 Agent 使用本机已有登录与模型配置。");
    return {provider: input.provider};
  }
  const model=normalizeModel(input.provider,input.model);
  if(input.baseUrl!==undefined)normalizeBaseUrl(input.provider,input.baseUrl);
  if (input.apiKey !== undefined && (typeof input.apiKey !== "string" ||
      (input.apiKey.trim() && !/^[\x21-\x7e]{12,4096}$/u.test(input.apiKey.trim())))) throw new Error("API Key 格式无效。");
  return {provider: input.provider, model,
    ...(input.baseUrl !== undefined ? {baseUrl:normalizeBaseUrl(input.provider,input.baseUrl)} : {}),
    ...(input.apiKey !== undefined ? {apiKey: input.apiKey.trim()} : {})};
}

export function validateModelDiscovery(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['provider','baseUrl','apiKey'].includes(key))||!getProvider(input.provider)||isAgentProvider(input.provider))throw new Error('模型列表请求无效。');
  if(input.apiKey!==undefined&&(typeof input.apiKey!=='string'||(input.apiKey.trim()&&!/^[\x21-\x7e]{12,4096}$/u.test(input.apiKey.trim()))))throw new Error('API Key 格式无效。');
  return {provider:input.provider,...(input.baseUrl!==undefined?{baseUrl:normalizeBaseUrl(input.provider,input.baseUrl)}:{}),...(input.apiKey!==undefined?{apiKey:input.apiKey.trim()}:{})};
}

export function publicModelDiscovery(input,selection) {
  if(!input||input.provider!==selection.provider||input.source!=='remote'||!Array.isArray(input.models)||input.models.length>2000)throw new Error('模型列表响应无效。');
  const baseUrl=normalizeBaseUrl(selection.provider,input.baseUrl);
  if(selection.baseUrl!==undefined&&baseUrl!==selection.baseUrl)throw new Error('模型列表服务地址不一致。');
  const models=[...new Set(input.models.map(item=>normalizeModel(selection.provider,item?.id)))].map(id=>({id}));
  return {provider:selection.provider,baseUrl,source:'remote',models,...(input.truncated===true?{truncated:true}:{})};
}

export function publicWriterSettings(input) {
  const settings = input?.writerSettings ?? input;
  if (!settings || typeof settings !== "object" || !getProvider(settings.provider) ||
      typeof settings.model !== "string" || (!settings.model && settings.transport !== "direct") || settings.model.length > 160 ||
      typeof settings.keyConfigured !== "boolean" || settings.checkScope !== "local") throw new Error("本机模型配置状态无效。");
  const agent=isAgentProvider(settings.provider);
  const result={provider: settings.provider, model: agent || (settings.transport === "direct" && !settings.model) ? settings.model : normalizeModel(settings.provider,settings.model),
    ...(settings.baseUrl!==undefined?{baseUrl:normalizeBaseUrl(settings.provider,settings.baseUrl)}:{}),
    keyConfigured: settings.keyConfigured, checkScope: "local", ...(settings.transport === "direct" ? {transport: "direct"} : {})};
  if(settings.credentialStorage!==undefined){
    const item=settings.credentialStorage;
    if(!item||!['macos-keychain','windows-dpapi','legacy-plaintext','unsupported','none','browser-aes-gcm'].includes(item.backend)||typeof item.encrypted!=='boolean'||typeof item.legacy!=='boolean')throw new Error('密钥存储状态无效。');
    result.credentialStorage={backend:item.backend,encrypted:item.encrypted,legacy:item.legacy,...(typeof item.available === "boolean" ? {available:item.available} : {})};
  }
  if(settings.profiles!==undefined){
    if(!settings.profiles||typeof settings.profiles!=='object'||Array.isArray(settings.profiles))throw new Error('模型配置列表无效。');
    const profiles={};
    for(const [provider,profile] of Object.entries(settings.profiles)){
      if(!getProvider(provider)||isAgentProvider(provider)||!profile||typeof profile!=='object'||Array.isArray(profile)||
        typeof profile.keyConfigured!=='boolean')throw new Error('模型配置列表无效。');
      profiles[provider]={model:settings.transport === "direct" && profile.model === "" ? "" : normalizeModel(provider,profile.model),baseUrl:normalizeBaseUrl(provider,profile.baseUrl),keyConfigured:profile.keyConfigured};
    }
    result.profiles=profiles;
  }
  if(settings.agents!==undefined){
    if(!Array.isArray(settings.agents)||settings.agents.length>3)throw new Error('本地 Agent 状态无效。');
    result.agents=settings.agents.map(item=>{
      const descriptor=getProvider(item?.id);
      if(descriptor?.kind!=='agent'||typeof item.installed!=='boolean')throw new Error('本地 Agent 状态无效。');
      return {id:descriptor.id,label:descriptor.label,installed:item.installed,supported:descriptor.supported!==false&&item.supported!==false};
    });
  }
  return result;
}


export function sourceFromUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("推文链接无效。"); }
  if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname) || url.port || url.username || url.password) {
    throw new Error("只支持 X / Twitter 推文链接。");
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/);
  if (!match) throw new Error("请选取包含完整原文链接的推文。");
  return {id: match[2], handle: match[1], url: `https://x.com/${match[1]}/status/${match[2]}`};
}

function boundedString(value, max, field, {required = false} = {}) {
  if (value == null) value = "";
  if (typeof value !== "string" || Array.from(value).length > max || (required && !value.trim())) {
    throw new Error(`${field}无效或过长。`);
  }
  return value.trim();
}

export function validateContext(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请先选择一条推文。");
  if (input.contextKind !== undefined) throw new Error("此操作需要包含真实链接的原帖。");
  const source = sourceFromUrl(input.url);
  const media = validateMedia(input.media);
  if (String(input.id) !== source.id) throw new Error("原文链接和推文编号不一致，请重新读取。");
  return {
    id: source.id,
    url: source.url,
    text: boundedString(input.text, 12000, "推文正文", {required: !media.length}),
    author: `@${source.handle}`,
    authorName: boundedString(input.authorName, 200, "作者名称"),
    quote: boundedString(input.quote, 5000, "引用内容"),
    hasMedia: input.hasMedia === true || media.length > 0,
    ...(media.length ? {media} : {}),
    capturedAt: boundedString(input.capturedAt, 100, "读取时间")
  };
}

// Only inline reply sessions may generate from the original shown in X's reply
// dialog when refreshing has removed its permalink. This never invents a post ID.
export function validateInlineContext(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请先选择一条推文。");
  if (input.contextKind === undefined) return validateContext(input);
  if (input.contextKind !== "composer-visible") throw new Error("回复原文来源类型无效。");
  if (input.id !== null || input.url !== null) throw new Error("弹窗原文不能携带未确认的推文编号或链接。");
  if (typeof input.author !== "string" || !/^@[A-Za-z0-9_]{1,15}$/.test(input.author)) throw new Error("回复原文作者无效。");
  const media = validateMedia(input.media);
  return {
    contextKind: "composer-visible", id: null, url: null,
    author: input.author,
    text: boundedString(input.text, 12000, "推文正文", {required: !media.length}),
    authorName: boundedString(input.authorName, 200, "作者名称"),
    quote: boundedString(input.quote, 5000, "引用内容"),
    hasMedia: input.hasMedia === true || media.length > 0,
    ...(media.length ? {media} : {}),
    capturedAt: boundedString(input.capturedAt, 100, "读取时间")
  };
}

export function validatePreferences(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("回复偏好无效。");
  const style = input.style ?? DEFAULT_PREFERENCES.style;
  if (!STYLES.has(style)) throw new Error("回复风格无效。");
  if (input.tonePreset !== undefined && (typeof input.tonePreset !== "string" || !Object.hasOwn(TONE_PRESETS, input.tonePreset))) throw new Error("回复语气无效。");
  return {
    style,
    ...(input.tonePreset !== undefined ? {tonePreset: input.tonePreset} : {}),
    personalExperience: boundedString(input.personalExperience, 3000, "真实经历"),
    tone: boundedString(input.tone, 600, "个人口吻"),
    ...(input.contextNote != null ? {contextNote: boundedString(input.contextNote, 1200, "补充上下文")} : {})
  };
}

export function buildReplyIntent(context, draftText) {
  const source = validateContext(context);
  const text = boundedString(draftText, 280, "回复内容", {required: true});
  const url = new URL("https://x.com/intent/post");
  url.searchParams.set("in_reply_to", source.id);
  url.searchParams.set("text", text);
  return url.href;
}

export function isTrustedSender(sender, runtimeId) {
  if (sender?.id !== runtimeId) return false;
  if (sender.url === `chrome-extension://${runtimeId}/setup.html`) return true;
  return !sender.tab && sender.url === `chrome-extension://${runtimeId}/panel.html`;
}

export function isTrustedPopupSender(sender, runtimeId) {
  return sender?.id === runtimeId && sender.url === `chrome-extension://${runtimeId}/popup.html` && (sender.frameId === undefined || sender.frameId === 0);
}

export function isTrustedInlineSender(sender, runtimeId) {
  if (sender?.id !== runtimeId || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0 ||
      sender.frameId !== 0 || typeof sender.documentId !== "string" || !sender.documentId || sender.documentId.length > 200) return false;
  let url;
  try { url = new URL(sender.url); } catch { return false; }
  return url.protocol === "https:" && ["x.com", "twitter.com"].includes(url.hostname) && !url.port && !url.username && !url.password;
}

export function ownsInlineSession(session, sender) {
  return session?.owner?.tabId === sender.tab?.id && session.owner.documentId === sender.documentId &&
    session.owner.frameId === sender.frameId;
}

export function publicHealth(input) {
  const health = input?.health ?? input;
  if (!health || typeof health !== "object" || Array.isArray(health)) throw new Error("本机服务返回的状态无效，请重试。");
  return {
    service: typeof health.service === "string" ? health.service.slice(0, 100) : "",
    version: typeof health.version === "string" ? health.version.slice(0, 100) : "",
    codexVersion: typeof health.codexVersion === "string" ? health.codexVersion.slice(0, 100) : "",
    authenticated: health.authenticated === true,
    authentication: typeof health.authentication === "string" ? health.authentication.slice(0, 100) : "unknown",
    ...Object.fromEntries(["writerProvider", "writerModel", "writerReasoningEffort"].filter(key => typeof health[key] === "string").map(key => [key, health[key].slice(0, 100)]))
  };
}

export function publicState(state) {
  return {
    contexts: state.contexts ?? [],
    selectedContext: state.selectedContext ?? null,
    results: state.results ?? [],
    resultsContext: state.resultsContext ?? null,
    preferences: state.preferences ?? {...DEFAULT_PREFERENCES},
    settings: {bridgeUrl: BRIDGE_URL, paired: Boolean(state.pairingToken) && state.pairingVerified === true},
    job: state.job ?? null,
    captureError: state.captureError ?? ""
  };
}

export function normalizeUnderstanding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('原帖理解格式无效，请重试。');
  const list = (value, count, limit, field) => {
    if (!Array.isArray(value) || value.length > count) throw new Error(`${field}格式无效。`);
    return value.map(item => boundedString(item, limit, field, {required: true}));
  };
  if (!['sufficient', 'limited', 'missing'].includes(input.contextStatus)) throw new Error('原帖语境状态无效。');
  const result = {
    meaning: boundedString(input.meaning, 200, '原帖含义', {required: true}),
    signals: list(input.signals, 4, 30, '表达线索'),
    evidence: list(input.evidence, 3, 200, '理解依据'),
    contextStatus: input.contextStatus,
    missingContext: boundedString(input.missingContext, 300, '缺失语境'),
    replyAction: boundedString(input.replyAction, 80, '回复方向', {required: true})
  };
  if (result.contextStatus === 'missing' && !result.missingContext) throw new Error('缺少语境时需要说明具体缺口。');
  return result;
}

export function validateInlineFeedback(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['category', 'note'].includes(key))) throw new Error('意见格式无效。');
  if (!['understanding', 'voice', 'useful', 'other'].includes(input.category)) throw new Error('意见类型无效。');
  return {category: input.category, note: boundedString(input.note, 1200, '意见', {required: true})};
}

export function normalizeCandidates(candidates, context, {inline = false, understanding = null, style = 'mix', tonePreset, contextStatus, missingContext} = {}) {
  // Protocol 4 preserves unified reply styles and compact context status; legacy cached interpretation jobs
  // keep their original validation path and remain editable after worker restore.
  const meaning = understanding === null ? null : normalizeUnderstanding(understanding);
  if (!STYLES.has(style)) throw new Error('回复风格无效。');
  const compact = style === 'all' || contextStatus !== undefined || missingContext !== undefined;
  if (compact) {
    const status = contextStatus ?? meaning?.contextStatus;
    const gap = boundedString(missingContext ?? meaning?.missingContext, 300, '缺失语境');
    if (!['sufficient', 'limited', 'missing'].includes(status)) throw new Error('原帖语境状态无效。');
    const genericGap = /^(?:不清楚|不确定|不知道|看不懂|无法理解|不知道怎么回复|缺(?:少)?(?:语境|上下文|背景|信息)|(?:语境|上下文|背景|信息)不足|暂无(?:语境|上下文|背景|信息)|需要(?:补充|更多)?(?:语境|上下文|背景|信息)|请(?:补充|提供)(?:更多)?(?:语境|上下文|背景|信息))[。！？.!?\s]*$/u;
    if (status === 'sufficient' ? Boolean(gap) : !gap || !/\p{Script=Han}/u.test(gap) || genericGap.test(gap)) throw new Error('原帖语境状态与缺口说明不一致。');
    if (!Array.isArray(candidates) || (status === 'missing' ? candidates.length !== 0 || !gap : candidates.length !== 4)) throw new Error('四类回复格式不完整，请重试。');
  } else {
    const validCount = meaning ? candidates?.length <= (style === 'mix' ? 2 : 4) : [2, 4].includes(candidates?.length);
    if (!Array.isArray(candidates) || !validCount) throw new Error('返回的候选格式不完整，请重试。');
    if (meaning && ((meaning.contextStatus === 'missing' && candidates.length !== 0) || (meaning.contextStatus === 'sufficient' && candidates.length === 0) || (!candidates.length && !meaning.missingContext))) throw new Error('原帖语境与候选回复不一致，请重试。');
  }
  const source = inline ? validateInlineContext(context) : validateContext(context);
  const texts = new Set(), styles = new Set();
  return candidates.map(candidate => {
    if (!candidate || !STYLES.has(candidate.style) || ["mix", "all"].includes(candidate.style)) throw new Error("候选回复的风格无效。");
    if (compact && styles.has(candidate.style)) throw new Error('四类回复风格重复，请重试。');
    styles.add(candidate.style);
    const text = boundedString(candidate.text, 280, "候选回复", {required: true});
    if (texts.has(text)) throw new Error("候选回复有重复内容，请重新生成。");
    texts.add(text);
    const hasReplyStyle = candidate.replyStyle !== undefined;
    if (hasReplyStyle && (typeof candidate.replyStyle !== 'string' || !Object.hasOwn(REPLY_STYLE_CATALOG.labels, candidate.replyStyle))) throw new Error('候选回复的语气无效。');
    if (hasReplyStyle && tonePreset !== undefined && tonePreset !== 'auto' && candidate.replyStyle !== tonePreset) throw new Error('候选回复与所选语气不一致。');
    // New results use the canonical public catalogue. Old cached batches keep
    // their own historical label and never gain an inferred match after restore.
    return {style: candidate.style, text,
      label: hasReplyStyle ? REPLY_STYLE_CATALOG.labels[candidate.replyStyle] : boundedString(candidate.label, 24, "候选标签", {required: true}),
      ...(hasReplyStyle ? {replyStyle: candidate.replyStyle} : {}), context: {...source}};
  });
}
