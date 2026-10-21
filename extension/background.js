import {
  BRIDGE_URL, REPLY_PROTOCOL_VERSION, DEFAULT_PREFERENCES, validateContext, validateInlineContext, validatePreferences,
  buildReplyIntent, isTrustedSender, isTrustedInlineSender, ownsInlineSession,
  publicState, publicHealth, normalizeCandidates, normalizeUnderstanding, validateInlineFeedback,
  DEFAULT_POPUP_PREFERENCES, validatePopupPreferences, generationPreferences, publicToneSnapshot, isTrustedPopupSender,
  validateWriterSettings, publicWriterSettings, validateModelDiscovery, publicModelDiscovery
} from "./background-core.js";
import {captureVisibleTweets} from "./capture.js";
import {publicMediaEvidence} from "./media-core.js";
import {createDirectWriter} from "./direct-api.js";
import {isAgentProvider} from "./provider-catalog.js";

const STATE_KEY = "replySessionState";
const PREFERENCES_KEY = "replyPreferences";
const FEEDBACK_KEY = "replyInlineFeedback";
const POPUP_PREFERENCES_KEY = "replyPopupPreferences";
const TRANSPORT_KEY = "replyTransport";
const directTasks = new Map();
let replyTransport = "direct";
let directWriter;
const getDirectWriter = () => directWriter ??= createDirectWriter();
const MAX_FEEDBACK = 300;
const MENU_ID = "reply-selected-tweet";
const JOB_STATUSES = new Set(["running", "completed", "failed", "cancelled"]);
const INLINE_MESSAGES = new Set(["inlineInit", "inlineGenerate", "inlinePoll", "inlineCancel", "inlineClose", "inlineHealth", "inlineOpenSetup", "inlineFeedback"]);
const SETUP_MESSAGES = new Set(["getState", "checkBridge", "saveSettings"]);
const POPUP_MESSAGES = new Set(["popupState", "savePopupPreferences", "getWriterSettings", "saveWriterSettings", "listWriterModels", "setReplyTransport"]);
const MAX_INLINE_SESSIONS = 32;
let state;
let popupPreferences = {...DEFAULT_POPUP_PREFERENCES};
let queue = Promise.resolve();

const ready = (async () => {
  await chrome.storage.session.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
  await chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
  const [session, local, popupLocal, transportLocal] = await Promise.all([
    chrome.storage.session.get(STATE_KEY), chrome.storage.local.get(PREFERENCES_KEY), chrome.storage.local.get(POPUP_PREFERENCES_KEY), chrome.storage.local.get(TRANSPORT_KEY)
  ]);
  try { popupPreferences = validatePopupPreferences(popupLocal[POPUP_PREFERENCES_KEY]); }
  catch { popupPreferences = {...DEFAULT_POPUP_PREFERENCES}; }
  const saved = session[STATE_KEY] ?? {};
  replyTransport = ["direct", "bridge"].includes(transportLocal[TRANSPORT_KEY]) ? transportLocal[TRANSPORT_KEY] : saved.pairingToken ? "bridge" : "direct";
  let preferences;
  try { const {contextNote, ...savedPreferences} = validatePreferences(local[PREFERENCES_KEY] ?? DEFAULT_PREFERENCES); preferences = {...savedPreferences, style: 'all'}; }
  catch { preferences = {...DEFAULT_PREFERENCES}; }
  state = {
    contexts: [], selectedContext: null, results: [], resultsContext: null,
    pairingToken: "", job: null, captureError: "", ...saved, preferences, pairingVerified: false
  };
  state.inlineSessions = restoreInlineSessions(saved.inlineSessions);
  state.transport = replyTransport;
  let recovered = false;
  for (const holder of [state, ...Object.values(state.inlineSessions)]) {
    if (holder.job?.transport === "direct" && holder.job.status === "running") {
      holder.job = {...holder.job, status: "failed", error: "浏览器后台已重启，请点击重新生成。", code: "DIRECT_WORKER_RESTARTED"};
      recovered = true;
    }
  }
  if (recovered) await persist();
})();

function restoreInlineSessions(saved) {
  const restored = {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return restored;
  for (const [id, value] of Object.entries(saved).slice(0, MAX_INLINE_SESSIONS)) {
    try {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isInteger(value?.owner?.tabId) || value.owner.tabId < 0 ||
          value.owner.frameId !== 0 || typeof value.owner.documentId !== "string" || !value.owner.documentId || value.owner.documentId.length > 200) continue;
      const context = validateInlineContext(value.context);
      const owner = {tabId: value.owner.tabId, documentId: value.owner.documentId, frameId: 0};
      const job = value.job ? normalizeJob(value.job, {context, preferences: validatePreferences(value.job.preferences), ...publicToneSnapshot(value.job.tonePreset, value.job.hasCustomTone)}, {inline: true}) : null;
      restored[id] = {owner, context, job};
    } catch { /* Invalid saved records never grant content access. */ }
  }
  return restored;
}

function serialize(operation) {
  const task = queue.then(async () => { await ready; return operation(); });
  queue = task.catch(() => {});
  return task;
}

async function persist({preferences = false} = {}) {
  await chrome.storage.session.set({[STATE_KEY]: state});
  if (preferences) await chrome.storage.local.set({[PREFERENCES_KEY]: state.preferences});
  chrome.runtime.sendMessage({type: "stateChanged"}).catch(() => {});
}

function bridgeError(message, code = "BRIDGE_ERROR") {
  return Object.assign(new Error(message), {code});
}

function safeBridgeMessage(message, token) {
  let value = typeof message === "string" ? message : "本机服务暂时无法处理请求，请重试。";
  for (const secret of new Set([token, state.pairingToken])) {
    if (secret) value = value.split(secret).join("[配对码已隐藏]");
  }
  return value.slice(0, 400);
}

function failActiveJobs(message) {
  if (state.job?.status === "running") state.job = {...state.job, status: "failed", error: message};
  for (const session of Object.values(state.inlineSessions)) {
    if (session.job?.status === "running") session.job = {...session.job, status: "failed", error: message};
  }
}

function hasRunningJob() {
  return state.job?.status === "running" || Object.values(state.inlineSessions).some(session => session.job?.status === "running");
}

async function assertIdle() {
  // The previous UI may have closed before its last poll. Reconcile first so a finished job cannot block future reply windows.
  let changed = false;
  const running = [];
  if (state.job?.status === "running") running.push({get: () => state.job, set: job => {
    state.job = job;
    if (job.status === "completed") { state.results = job.candidates; state.resultsContext = job.context; }
  }});
  for (const session of Object.values(state.inlineSessions)) {
    if (session.job?.status === "running") running.push({get: () => session.job, set: job => { session.job = job; }, inline: true});
  }
  for (const entry of running) {
    const previous = entry.get();
    if (previous.transport === "direct") continue;
    try {
      const payload = await requestBridge(`/jobs/${encodeURIComponent(previous.id)}`);
      entry.set(normalizeJob(payload, previous, {inline: entry.inline === true}));
    } catch (error) {
      if (error.httpStatus === 404 || error.code === "JOB_NOT_FOUND") {
        entry.set({...previous, status: "failed", error: "本机服务已找不到这条任务，请重新生成。"});
      } else throw error;
    }
    changed = true;
  }
  if (changed) await persist();
  if (hasRunningJob()) throw bridgeError("已有一条回复正在生成，请等它完成或先取消。", "JOB_RUNNING");
}

async function requestBridge(path, {method = "GET", body, token = state.pairingToken, authenticated = true, timeoutMs = 8000} = {}) {
  if (authenticated && !token) throw bridgeError("插件尚未连接本机服务。点击“连接 Codex”即可连接。", "NOT_PAIRED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(18000, Math.max(1000, timeoutMs)));
  try {
    const response = await fetch(`${BRIDGE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? {"Content-Type": "application/json"} : {}),
        ...(authenticated ? {"X-Reply-Bridge-Token": token, "X-Reply-Protocol": REPLY_PROTOCOL_VERSION} : {})
      },
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw bridgeError("本机服务返回了无法识别的内容，请重启服务。", "INVALID_RESPONSE"); }
    if (!response.ok) {
      // A route/Origin permission error does not revoke a valid service
      // credential. Only authentication failures invalidate owned jobs.
      const authenticationExpired = response.status === 401 || (response.status === 403 && ["UNPAIRED", "PAIRING_EXPIRED"].includes(payload?.code));
      if (authenticated && authenticationExpired) {
        if (token === state.pairingToken) {
          state.pairingToken = "";
          state.pairingVerified = false;
          failActiveJobs("本机服务连接已失效，请重新连接后再生成。");
          await persist();
        }
        throw bridgeError("本机服务已重启或连接已失效。点击“连接 Codex”即可重新连接。", "PAIRING_EXPIRED");
      }
      const safeMessage = safeBridgeMessage(payload.error, token);
      throw Object.assign(bridgeError(safeMessage, typeof payload.code === "string" ? payload.code : "BRIDGE_ERROR"), {httpStatus: response.status});
    }
    return payload;
  } catch (error) {
    if (error.code) throw error;
    if (controller.signal.aborted) throw bridgeError("本机服务响应超时，请稍后重试生成。", "BRIDGE_TIMEOUT");
    throw bridgeError("本机服务暂时未就绪，请稍后重试；若持续失败，运行“启动本机 Codex 服务.command”修复启动。", "BRIDGE_UNAVAILABLE");
  } finally { clearTimeout(timer); }
}

function normalizeJob(payload, previous, {inline = false} = {}) {
  const job = payload?.job ?? payload;
  if (!job || typeof job.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(job.id) || !JOB_STATUSES.has(job.status)) {
    throw bridgeError("本机服务返回的任务格式无效，请重试。", "INVALID_RESPONSE");
  }
  if (previous?.id && job.id !== previous.id) throw bridgeError("任务编号不一致，请重新生成。", "INVALID_RESPONSE");
  const result = {
    id: job.id, status: job.status, context: previous.context,
    ...((job.transport ?? previous.transport) === "direct" ? {transport: "direct"} : {}),
    preferences: previous.preferences,
    ...publicToneSnapshot(previous.tonePreset, previous.hasCustomTone),
    error: typeof job.error === "string" ? safeBridgeMessage(job.error) : "",
    ...(typeof job.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(job.code) ? {code: job.code} : {})
  };
  const mediaEvidence = publicMediaEvidence(job.mediaEvidence);
  if (mediaEvidence) result.mediaEvidence = mediaEvidence;
  if (job.timings && typeof job.timings === 'object' && !Array.isArray(job.timings)) {
    const timings = Object.fromEntries(Object.entries(job.timings).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key) && Number.isFinite(value) && value >= 0));
    if (Object.keys(timings).length) result.timings = timings;
  }
  if (job.status === "completed") {
    if (job.contextStatus !== undefined) {
      if (!['sufficient', 'limited', 'missing'].includes(job.contextStatus) || typeof job.missingContext !== 'string' || Array.from(job.missingContext).length > 300) throw bridgeError('原帖语境状态无效。', 'INVALID_RESPONSE');
      result.contextStatus = job.contextStatus; result.missingContext = job.missingContext;
    }
    if (job.understanding !== undefined) result.understanding = normalizeUnderstanding(job.understanding);
    result.candidates = normalizeCandidates(job.candidates, previous.context, {inline, understanding: result.understanding ?? null, style: previous.preferences?.style ?? 'mix', tonePreset: previous.preferences?.tonePreset, contextStatus: result.contextStatus, missingContext: result.missingContext});
  }
  return result;
}

async function pairWithCode(code) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(code.trim())) {
    throw bridgeError("配对码格式无效，请从本机服务页面完整复制。", "INVALID_PAIRING_CODE");
  }
  const pairingToken = code.trim();
  const health = publicHealth(await requestBridge("/health", {authenticated: false}));
  if (!health.authenticated) throw bridgeError("当前模型尚未就绪，请在插件的模型设置中检查 API 或本地 Agent。", "AUTH_REQUIRED");
  const paired = await requestBridge("/pair", {method: "POST", body: {}, token: pairingToken});
  if (paired.paired !== true) throw bridgeError("本机服务未确认配对，请重试。", "INVALID_RESPONSE");
  state.pairingToken = pairingToken;
  state.pairingVerified = true;
}

async function checkConnection({allowUnauthenticated = false} = {}) {
  try {
    const health = publicHealth(await requestBridge("/health", {authenticated: false}));
    if (!health.authenticated && !allowUnauthenticated) throw bridgeError("当前模型尚未就绪，请在插件的模型设置中检查 API 或本地 Agent。", "AUTH_REQUIRED");
    // Existing temporary credentials remain valid only for this service instance.
    // An approved extension can obtain a replacement without sending it to X.
    if (state.pairingToken) {
      try {
        const paired = await requestBridge("/pair", {method: "POST", body: {}});
        if (paired.paired !== true) throw bridgeError("本机服务未确认连接，请重新连接。", "INVALID_RESPONSE");
      } catch (error) { if (error.code !== "PAIRING_EXPIRED") throw error; }
    }
    if (!state.pairingToken) await connectApprovedExtension();
    const paired = Boolean(state.pairingToken);
    if (state.pairingVerified !== paired) { state.pairingVerified = paired; await persist(); }
    return {paired, health};
  } catch (error) {
    if (state.pairingVerified) { state.pairingVerified = false; await persist(); }
    throw error;
  }
}

async function connectApprovedExtension() {
  let connected;
  try {
    connected = await requestBridge("/extension/connect", {
      method: "POST", body: {extensionId: chrome.runtime.id}, authenticated: false
    });
  } catch (error) {
    if (error.httpStatus === 404 || error.code === "UNPAIRED" || error.code === "NOT_FOUND") {
      throw bridgeError("本机服务版本较旧。请更新并重新启动本机 Codex 服务后，再点击“连接 Codex”。", "BRIDGE_UPDATE_REQUIRED");
    }
    throw error;
  }
  if (connected?.paired !== true || typeof connected.token !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(connected.token)) {
    throw bridgeError("本机服务未返回有效连接。请更新并重新启动本机 Codex 服务后重试。", "INVALID_RESPONSE");
  }
  if (state.pairingToken !== connected.token) failActiveJobs("本机服务连接已更新，请重新生成。");
  state.pairingToken = connected.token;
  state.pairingVerified = true;
  await persist();
}

function inlineSession(message, sender) {
  if (typeof message.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(message.sessionId) ||
      !ownsInlineSession(state.inlineSessions[message.sessionId], sender)) {
    throw bridgeError("回复窗口已变更，请重新打开这条推文的回复窗口。", "INLINE_SESSION_EXPIRED");
  }
  return state.inlineSessions[message.sessionId];
}

function restoreFeedback(records) {
  if (!Array.isArray(records)) return [];
  const result = [];
  for (const record of records.slice(-MAX_FEEDBACK)) {
    try {
      if (!record || typeof record.id !== 'string' || typeof record.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(record.jobId) ||
          typeof record.createdAt !== 'string' || record.createdAt.length > 100 || !Number.isFinite(Date.parse(record.createdAt))) continue;
      const context = validateInlineContext(record.context);
      const understanding = record.understanding === undefined ? null : normalizeUnderstanding(record.understanding);
      const candidates = normalizeCandidates(record.candidates, context, {inline: true, understanding, style: 'humor'}).map(({style, label, text, replyStyle}) => ({style, label, text, ...(replyStyle ? {replyStyle} : {})}));
      const {contextNote = ''} = validatePreferences({contextNote: record.contextNote ?? ''});
      result.push({id: record.id, createdAt: record.createdAt, jobId: record.jobId, context,
        ...(understanding ? {understanding} : {}), candidates, contextNote,
        ...validateInlineFeedback({category: record.category, note: record.note})});
    } catch { /* Corrupt notes cannot create unbounded or credential-bearing records. */ }
  }
  return result;
}

function publicInlineJob(job) {
  return {
    id: job.id, status: job.status, context: {...job.context}, error: job.error ?? "",
    ...(job.transport === "direct" ? {transport: "direct"} : {}),
    ...publicToneSnapshot(job.tonePreset, job.hasCustomTone),
    ...(job.code ? {code: job.code} : {}),
    ...(job.candidates ? {candidates: job.candidates} : {}),
    ...(job.understanding ? {understanding: job.understanding} : {}),
    ...(job.contextStatus !== undefined ? {contextStatus: job.contextStatus, missingContext: job.missingContext} : {}),
    ...(job.timings ? {timings: job.timings} : {}),
    ...(job.mediaEvidence ? {mediaEvidence: job.mediaEvidence} : {})
  };
}

function selectedTransport(message, settings) {
  if (message.transport !== undefined && !["direct", "bridge"].includes(message.transport)) throw bridgeError("模型运行方式无效。", "INVALID_INPUT");
  return settings && isAgentProvider(settings.provider) ? "bridge" : message.transport ?? replyTransport;
}

async function setTransport(transport) {
  if (!["direct", "bridge"].includes(transport)) throw bridgeError("模型运行方式无效。", "INVALID_INPUT");
  await assertIdle();
  replyTransport = transport;
  state.transport = transport;
  await chrome.storage.local.set({[TRANSPORT_KEY]: transport});
  await persist();
}

async function directConnection() {
  const writer = getDirectWriter();
  const health = publicHealth(await writer.health());
  return {paired: true, configured: health.authenticated, transport: "direct", health};
}

function directError(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : "DIRECT_REQUEST_FAILED";
  // Only the engine's fixed public messages are safe. Network/provider errors can contain credentials.
  const messages = {
    DIRECT_CONFIG_REQUIRED: "请先点击工具栏图标，配置模型 API。",
    DIRECT_NOT_CONFIGURED: "请先选择模型并保存该服务商的 API Key。",
    DIRECT_WORKER_RESTARTED: "浏览器后台已重启，请重新生成。",
    DIRECT_AUTH_REQUIRED: "API Key 无效或没有该模型的访问权限。",
    DIRECT_QUOTA: "模型服务余额不足，请检查账户余额。",
    DIRECT_RATE_LIMIT: "模型服务请求频率或并发受限，请稍后再试。",
    DIRECT_CONFIG: "请检查模型名称、API 地址和服务商配置。",
    DIRECT_TIMEOUT: "生成超过一分钟，已停止，请稍后重试。",
    DIRECT_HEADERS_TIMEOUT: "模型服务等待响应超时，已停止，请稍后重试。",
    BROWSER_VAULT_UNAVAILABLE: "浏览器本机密钥存储不可用，请检查浏览器配置后重新保存。",
    INVALID_CANDIDATES: "模型返回的回复格式或内容未通过检查，请重试。"
  };
  return {code, message: messages[code] ?? "模型请求未完成，请检查 API 配置或网络后重试。"};
}

async function startDirectJob(holder, context, preferences, toneSnapshot, {inline = false} = {}) {
  if (!await getDirectWriter().hasConfiguration()) throw bridgeError("请先点击工具栏图标，配置模型 API。", "DIRECT_CONFIG_REQUIRED");
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const initial = {id, status: "running", transport: "direct", context, preferences, ...toneSnapshot, error: ""};
  holder.job = initial;
  directTasks.set(id, controller);
  // Start outside the message queue: polling and cancellation must not wait for model completion.
  Promise.resolve().then(() => getDirectWriter().run(context, preferences, controller.signal)).then(
    result => serialize(async () => {
      if (holder.job?.id !== id || holder.job.status !== "running" || directTasks.get(id) !== controller) return;
      try {
        holder.job = normalizeJob({...result, id, status: "completed", transport: "direct"}, initial, {inline});
        if (holder === state) { state.results = holder.job.candidates; state.resultsContext = context; }
      } catch (error) {
        holder.job = {...initial, status: "failed", error: directError(error).message, code: directError(error).code};
      }
      directTasks.delete(id);
      await persist();
    }),
    error => serialize(async () => {
      if (holder.job?.id !== id || holder.job.status !== "running" || directTasks.get(id) !== controller) return;
      const failure = directError(error);
      holder.job = {...initial, status: "failed", error: failure.message, code: failure.code};
      directTasks.delete(id);
      await persist();
    })
  ).catch(() => {});
  return initial;
}

async function updateDirectJob(holder, {cancel = false} = {}) {
  if (cancel && holder.job.status === "running") {
    directTasks.get(holder.job.id)?.abort();
    directTasks.delete(holder.job.id);
    holder.job = {...holder.job, status: "cancelled", error: ""};
    await persist();
  }
  return holder.job;
}

async function updateInlineJob(session, id, {cancel = false} = {}) {
  if (!session.job || typeof id !== "string" || id !== session.job.id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw bridgeError("没有找到这条生成任务，请重新生成。", "JOB_NOT_FOUND");
  }
  if (session.job.status !== "running") return session.job;
  if (session.job.transport === "direct") return updateDirectJob(session, {cancel});
  try {
    const payload = await requestBridge(`/jobs/${encodeURIComponent(id)}`, {method: cancel ? "DELETE" : "GET"});
    session.job = normalizeJob(payload, session.job, {inline: true});
  } catch (error) {
    if (error.httpStatus === 404 || error.code === "JOB_NOT_FOUND") {
      session.job = {...session.job, status: "failed", error: "本机服务已找不到这条任务，请重新生成。"};
    } else throw error;
  }
  await persist();
  return session.job;
}

async function discardInlineSession(id) {
  const session = state.inlineSessions[id];
  if (!session) return;
  if (session.job?.status === "running") {
    try { await updateInlineJob(session, session.job.id, {cancel: true}); }
    catch (error) {
      if (!["PAIRING_EXPIRED", "NOT_PAIRED"].includes(error.code)) throw error;
      session.job = {...session.job, status: "failed", error: "配对已失效。重新配对后可再次生成。"};
    }
    if (session.job?.status === "running") throw bridgeError("任务仍在停止，请稍后重试。", "JOB_RUNNING");
  }
  delete state.inlineSessions[id];
}

function assertEnabled() {
  if (!popupPreferences.enabled) throw bridgeError("X 评论助手已暂停。请点击工具栏图标开启，再点击生成。", "ASSISTANT_PAUSED");
}

async function dispatchPopup(message) {
  switch (message.type) {
    case "popupState": {
      const result = {...popupPreferences, transport: replyTransport, health: null, connectionStatus: "unavailable", writerSettings: null, writerSettingsError: null};
      if (replyTransport === "direct") {
        try {
          const checked = await directConnection();
          result.health = checked.health;
          result.connectionStatus = checked.configured ? "configured" : "auth-required";
          result.writerSettings = publicWriterSettings(await getDirectWriter().readSettings());
        } catch (error) {
          const failure = directError(error);
          result.error = failure.message; result.code = failure.code;
        }
        return result;
      }
      try {
        const checked = await checkConnection({allowUnauthenticated: true});
        result.health = checked.health;
        result.connectionStatus = !checked.health.authenticated ? "auth-required" : checked.paired ? "connected" : "unavailable";
      } catch (error) {
        result.connectionStatus = error.code === "AUTH_REQUIRED" ? "auth-required" : "unavailable";
        result.error = safeBridgeMessage(error.message);
        result.code = error.code;
        return result;
      }
      // Model settings are a separate capability. A failed read must not
      // relabel a confirmed healthy connection or invalidate a draft job.
      try {
        result.writerSettings = publicWriterSettings(await requestBridge("/writer-settings/read", {method: "POST", body: {}}));
      } catch (error) {
        result.writerSettingsError = {code: error.code ?? "WRITER_SETTINGS_UNAVAILABLE", message: safeBridgeMessage(error.message)};
        if (error.code === "PAIRING_EXPIRED") result.connectionStatus = "auth-required";
      }
      return result;
    }
    case "setReplyTransport": {
      if (Object.keys(message).some(key => !["type", "transport"].includes(key))) throw bridgeError("模型运行方式无效。", "INVALID_INPUT");
      await setTransport(message.transport);
      return {transport: replyTransport};
    }
    case "savePopupPreferences": {
      if (Object.keys(message).some(key => !["type", "enabled", "tonePreset"].includes(key))) throw bridgeError("插件偏好无效。", "INVALID_INPUT");
      const {type, ...changes} = message;
      popupPreferences = validatePopupPreferences({...popupPreferences, ...changes});
      await chrome.storage.local.set({[POPUP_PREFERENCES_KEY]: popupPreferences});
      return {...popupPreferences};
    }
    case "getWriterSettings": {
      if (Object.keys(message).some(key => !["type", "transport"].includes(key))) throw bridgeError("模型配置请求无效。", "INVALID_INPUT");
      if (selectedTransport(message) === "direct") return {transport: "direct", writerSettings: publicWriterSettings(await getDirectWriter().readSettings())};
      await checkConnection({allowUnauthenticated: true});
      return {writerSettings: publicWriterSettings(await requestBridge("/writer-settings/read", {method: "POST", body: {}}))};
    }
    case "saveWriterSettings": {
      if (Object.keys(message).some(key => !["type", "settings", "transport"].includes(key))) throw bridgeError("模型配置无效。", "INVALID_INPUT");
      const settings = validateWriterSettings(message.settings);
      const transport = selectedTransport(message, settings);
      await assertIdle();
      if (transport === "direct") {
        try {
          const writerSettings = publicWriterSettings(await getDirectWriter().saveSettings(settings));
          await setTransport("direct");
          return {transport: "direct", writerSettings};
        } catch (error) { const failure = directError(error); throw bridgeError(failure.message, failure.code); }
        finally { if (settings.apiKey) settings.apiKey = ""; }
      }
      try {
        await checkConnection({allowUnauthenticated: true});
        const writerSettings = publicWriterSettings(await requestBridge("/writer-settings", {method: "POST", body: settings}));
        if (message.transport !== undefined || isAgentProvider(settings.provider)) await setTransport("bridge");
        return {transport: "bridge", writerSettings};
      } catch (error) {
        // A misbehaving local service must not echo a newly supplied key into popup errors.
        throw bridgeError(safeBridgeMessage(error.message, settings.apiKey), error.code ?? "INVALID_SETTINGS");
      }
    }
    case "listWriterModels": {
      if(Object.keys(message).some(key=>!['type','settings','transport'].includes(key)))throw bridgeError('模型列表请求无效。','INVALID_INPUT');
      const selection=validateModelDiscovery(message.settings);
      try{
        if(selectedTransport(message)==='direct')return {transport:'direct',modelList:publicModelDiscovery(await getDirectWriter().listModels(selection),selection)};
        await checkConnection({allowUnauthenticated:true});
        return {modelList:publicModelDiscovery(await requestBridge('/writer-settings/models',{method:'POST',body:selection,timeoutMs:18000}),selection)};
      }catch(error){if(selectedTransport(message)==='direct'){const failure=directError(error);throw bridgeError(failure.message,failure.code);}throw bridgeError(safeBridgeMessage(error.message,selection.apiKey),error.code??'MODELS_UNAVAILABLE');}
      finally{if(selection.apiKey)selection.apiKey='';}
    }
    default: throw bridgeError("无法识别的插件请求。", "UNKNOWN_MESSAGE");
  }
}

async function dispatchInline(message, sender) {
  switch (message.type) {
    case "inlineInit": {
      const context = validateInlineContext(message.context);
      if (popupPreferences.enabled && replyTransport === "bridge") await checkConnection();
      // Reloading X creates a new document. Cancel only this tab's obsolete inline work before accepting its new source.
      for (const [id, session] of Object.entries(state.inlineSessions)) {
        if (session.owner.tabId === sender.tab.id && session.owner.frameId === sender.frameId && session.owner.documentId !== sender.documentId) {
          await discardInlineSession(id);
        }
      }
      if (Object.keys(state.inlineSessions).length >= MAX_INLINE_SESSIONS) {
        throw bridgeError("回复窗口过多，请关闭之前的窗口后重试。", "TOO_MANY_SESSIONS");
      }
      const sessionId = crypto.randomUUID();
      state.inlineSessions[sessionId] = {
        owner: {tabId: sender.tab.id, documentId: sender.documentId, frameId: sender.frameId},
        context, job: null
      };
      await persist();
      return {sessionId, paired: replyTransport === "direct" || state.pairingVerified === true, transport: replyTransport, ...(!popupPreferences.enabled ? {enabled: false} : {})};
    }
    case "inlineHealth": {
      if (!popupPreferences.enabled) return {enabled: false, paired: state.pairingVerified === true};
      return replyTransport === "direct" ? directConnection() : checkConnection();
    }
    case "inlineOpenSetup": {
      await chrome.tabs.create({url: chrome.runtime.getURL(replyTransport === "direct" ? "popup.html" : "setup.html")});
      return {opened: true};
    }
    case "inlineGenerate": {
      const session = inlineSession(message, sender);
      assertEnabled();
      await assertIdle();
      // A source belongs to this document's explicit reply-window capture, never to page-wide panel state.
      if (message.context !== undefined) throw bridgeError("原文已变更，请重新打开回复窗口。", "SOURCE_CHANGED");
      const context = validateInlineContext(session.context);
      if (message.preferences != null && (typeof message.preferences !== 'object' || Array.isArray(message.preferences) || Object.keys(message.preferences).some(key => key !== 'contextNote'))) throw bridgeError('补充上下文格式无效。', 'INVALID_INPUT');
      // Legacy style/context-note values cannot silently revive removed controls.
      const {contextNote, ...existingPreferences} = state.preferences;
      const generationPopupPreferences = validatePopupPreferences(popupPreferences);
      const toneSnapshot = publicToneSnapshot(generationPopupPreferences.tonePreset, Boolean(existingPreferences.tone?.trim()));
      const preferences = generationPreferences({...existingPreferences, style: 'all'}, generationPopupPreferences);
      if (replyTransport === "direct") await startDirectJob(session, context, preferences, toneSnapshot, {inline: true});
      else {
        const payload = await requestBridge("/jobs", {method: "POST", body: {context, preferences}});
        session.job = normalizeJob(payload, {context, preferences, ...toneSnapshot}, {inline: true});
      }
      await persist();
      return {job: publicInlineJob(session.job)};
    }
    case "inlinePoll":
    case "inlineCancel": {
      const session = inlineSession(message, sender);
      const job = await updateInlineJob(session, message.id, {cancel: message.type === "inlineCancel"});
      return {job: publicInlineJob(job)};
    }
    case "inlineFeedback": {
      const session = inlineSession(message, sender);
      if (Object.keys(message).some(key => !['type', 'sessionId', 'id', 'feedback'].includes(key))) throw bridgeError('意见请求不能变更原帖或候选。', 'INVALID_INPUT');
      if (!session.job || session.job.status !== 'completed' || message.id !== session.job.id) throw bridgeError('意见对应的候选已变化，请重新查看当前回复。', 'JOB_NOT_FOUND');
      const feedback = validateInlineFeedback(message.feedback);
      const saved = await chrome.storage.local.get(FEEDBACK_KEY);
      const previous = restoreFeedback(saved[FEEDBACK_KEY]).slice(-(MAX_FEEDBACK - 1));
      const record = {
        id: crypto.randomUUID(), createdAt: new Date().toISOString(), jobId: session.job.id,
        context: validateInlineContext(session.context),
        ...(session.job.understanding ? {understanding: normalizeUnderstanding(session.job.understanding)} : {}),
        candidates: session.job.candidates.map(({style, label, text, replyStyle}) => ({style, label, text, ...(replyStyle ? {replyStyle} : {})})),
        contextNote: session.job.preferences?.contextNote ?? '', ...feedback
      };
      await chrome.storage.local.set({[FEEDBACK_KEY]: [...previous, record]});
      // Feedback is an explicit local note, never an endorsement inferred from
      // filling/copying a draft, and never sent to the model or X automatically.
      return {saved: true, count: previous.length + 1};
    }
    case "inlineClose": {
      inlineSession(message, sender);
      await discardInlineSession(message.sessionId);
      await persist();
      return {closed: true};
    }
    default: throw bridgeError("无法识别的插件请求。", "UNKNOWN_MESSAGE");
  }
}

async function captureFromTab(tab, selectionOnly = false, selectedText = "") {
  if (!tab?.id || !/^https:\/\/(x\.com|twitter\.com)(\/|$)/.test(tab.url ?? "")) {
    state.captureError = "请打开 X 的时间线或推文页面，再点击插件图标读取。";
    await persist();
    return publicState(state);
  }
  try {
    const injection = await chrome.scripting.executeScript({
      target: {tabId: tab.id}, func: captureVisibleTweets, args: [selectionOnly, selectedText]
    });
    const captured = injection[0]?.result;
    const contexts = (captured?.contexts ?? []).map(validateContext);
    state.contexts = contexts;
    state.selectedContext = contexts.find(context => context.id === state.selectedContext?.id) ?? contexts[0] ?? null;
    state.captureError = contexts.length ? "" : captured?.error ?? "当前屏幕没有可读取的文字推文。";
  } catch {
    state.captureError = "页面读取失败。请刷新 X 页面，再点击浏览器工具栏中的插件图标。";
  }
  await persist();
  return publicState(state);
}

async function dispatch(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") throw bridgeError("请求格式无效。", "INVALID_MESSAGE");
  switch (message.type) {
    case "getState": return {state: publicState(state)};
    case "getFeedback": {
      const saved = await chrome.storage.local.get(FEEDBACK_KEY);
      return {feedback: restoreFeedback(saved[FEEDBACK_KEY])};
    }
    case "capture": {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      return {state: await captureFromTab(tab)};
    }
    case "selectContext": {
      const selected = state.contexts.find(context => context.id === message.id);
      if (!selected) throw bridgeError("推文已不在当前列表，请重新读取。", "SOURCE_NOT_FOUND");
      state.selectedContext = selected;
      await persist();
      return {state: publicState(state)};
    }
    case "setPreferences": {
      state.preferences = validatePreferences({...state.preferences, ...message.preferences});
      await persist({preferences: true});
      return {state: publicState(state)};
    }
    case "saveSettings": {
      if (message.bridgeUrl && message.bridgeUrl !== BRIDGE_URL) throw bridgeError("本机服务地址固定为 127.0.0.1:8769。", "INVALID_SETTINGS");
      const preferences = validatePreferences({...state.preferences, ...message.preferences});
      if (message.pairingCode) {
        await pairWithCode(message.pairingCode);
      }
      state.preferences = preferences;
      await persist({preferences: true});
      return {state: publicState(state)};
    }
    case "checkBridge": {
      return replyTransport === "direct" ? directConnection() : checkConnection();
    }
    case "generate": {
      assertEnabled();
      await assertIdle();
      const context = validateContext(message.context ?? state.selectedContext);
      // The panel can correct/expand visible text, while its source must remain a captured tweet.
      const savedSources = [...state.contexts, state.resultsContext].filter(Boolean);
      const known = savedSources.find(item => item.id === context.id && item.url === context.url);
      if (!known) throw bridgeError("原文已变更，请重新读取并选择推文。", "SOURCE_CHANGED");
      const {contextNote, ...existingPreferences} = state.preferences;
      const {contextNote: ignoredNote, ...requestedPreferences} = message.preferences ?? {};
      const savedPreferences = validatePreferences({...existingPreferences, ...requestedPreferences, style: 'all'});
      const generationPopupPreferences = validatePopupPreferences(popupPreferences);
      const toneSnapshot = publicToneSnapshot(generationPopupPreferences.tonePreset, Boolean(savedPreferences.tone?.trim()));
      const preferences = generationPreferences(savedPreferences, generationPopupPreferences);
      if (replyTransport === "direct") await startDirectJob(state, context, preferences, toneSnapshot);
      else {
        const payload = await requestBridge("/jobs", {method: "POST", body: {context, preferences}});
        state.job = normalizeJob(payload, {context, preferences, ...toneSnapshot});
      }
      // Preset instructions apply to this request only; preserve the stored custom tone.
      state.preferences = savedPreferences;
      if (state.job.status === "completed") {
        state.results = state.job.candidates;
        state.resultsContext = context;
      }
      await persist({preferences: true});
      return {job: state.job};
    }
    case "pollJob":
    case "cancelJob": {
      if (!state.job || message.id !== state.job.id || !/^[A-Za-z0-9_-]{1,100}$/.test(message.id)) {
        throw bridgeError("没有找到这条生成任务，请重新生成。", "JOB_NOT_FOUND");
      }
      if (state.job.status !== "running") return {job: state.job, state: publicState(state)};
      if (state.job.transport === "direct") { await updateDirectJob(state, {cancel: message.type === "cancelJob"}); return {job: state.job, state: publicState(state)}; }
      let payload;
      try {
        payload = await requestBridge(`/jobs/${encodeURIComponent(message.id)}`, {method: message.type === "cancelJob" ? "DELETE" : "GET"});
      } catch (error) {
        if (error.httpStatus === 404 || error.code === "JOB_NOT_FOUND") {
          state.job = {...state.job, status: "failed", error: "本机服务已找不到这条任务，请重新生成。"};
          await persist();
          return {job: state.job, state: publicState(state)};
        }
        throw error;
      }
      state.job = normalizeJob(payload, state.job);
      if (state.job.status === "completed") {
        state.results = state.job.candidates;
        state.resultsContext = state.job.context;
      }
      await persist();
      return {job: state.job, state: publicState(state)};
    }
    case "openReply": {
      const url = buildReplyIntent(message.context, message.draftText);
      await chrome.tabs.create({url});
      return {opened: true};
    }
    default: throw bridgeError("无法识别的插件请求。", "UNKNOWN_MESSAGE");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "stateChanged") return false;
  const trustedPopup = POPUP_MESSAGES.has(message?.type) && isTrustedPopupSender(sender, chrome.runtime.id);
  const trustedExtensionPage = !POPUP_MESSAGES.has(message?.type) && isTrustedSender(sender, chrome.runtime.id);
  const isSetup = sender?.url === `chrome-extension://${chrome.runtime.id}/setup.html`;
  const trustedPanel = trustedExtensionPage && (!isSetup || SETUP_MESSAGES.has(message?.type));
  const trustedInline = INLINE_MESSAGES.has(message?.type) && isTrustedInlineSender(sender, chrome.runtime.id);
  if (!trustedPopup && !trustedPanel && !trustedInline) {
    sendResponse({ok: false, error: "仅允许插件面板执行此操作。", code: "UNTRUSTED_SENDER"});
    return false;
  }
  serialize(() => trustedPopup ? dispatchPopup(message) : trustedInline ? dispatchInline(message, sender) : dispatch(message)).then(
    result => sendResponse({ok: true, ...result}),
    error => sendResponse({ok: false, error: error.message ?? "操作失败，请重试。", code: error.code ?? "INVALID_REQUEST"})
  );
  return true;
});

chrome.tabs.onRemoved?.addListener(tabId => {
  serialize(async () => {
    let changed = false;
    for (const [id, session] of Object.entries(state.inlineSessions)) {
      if (session.owner.tabId !== tabId) continue;
      await discardInlineSession(id);
      changed = true;
    }
    if (changed) await persist();
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll().then(() => chrome.contextMenus.create({
    id: MENU_ID, title: "打开 X 评论助手设置", contexts: ["selection"],
    documentUrlPatterns: ["https://x.com/*", "https://twitter.com/*"]
  })).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // Chrome 127+ supports non-policy-installed extensions. Keep this inside the
  // context-menu gesture; a compatibility error never opens a side panel or reads X.
  try { chrome.action.openPopup?.(Number.isInteger(tab?.windowId) ? {windowId: tab.windowId} : {}).catch(() => {}); }
  catch { /* The toolbar's default_popup remains the entry on older browsers. */ }
});
