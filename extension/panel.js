import './reply-style-catalog.js';
const ACTUAL_STYLES=globalThis.XReplyStyleCatalog.labels;
const STYLES = {
  witty: { label: '认可并展开' }, humor: { label: '幽默接梗' },
  insight: { label: '补充观点' }, story: { label: '换个角度' }
};
const RUNNING = new Set(['running', 'queued', 'pending']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function usablePostUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) && /\/status\/\d+(?:\/|$)/.test(url.pathname)) return url.href;
  } catch {}
  return null;
}

export function mountPanel(sendFn) {
  if (typeof sendFn !== 'function') throw new TypeError('mountPanel 需要一个消息发送函数');
  const $ = id => document.getElementById(id);
  let state = { contexts: [], selectedContext: null, results: [], preferences: { style: 'all', personalExperience: '', tone: '' }, settings: { paired: false }, job: null };
  let preferences = { ...state.preferences };
  let currentContext = null;
  let resultsContext = null;
  let currentJob = null;
  let pending = false;
  let refreshQueued = false;
  let polling = false;
  let pollTimer = null;
  let toastTimer = null;
  let destroyed = false;
  let generationContext = null;
  const listeners = [];
  const draftEdits = new Map();
  ['capture', 'check-bridge'].forEach(id => { $(id).disabled = false; });

  function listen(node, event, handler) {
    node.addEventListener(event, handler);
    listeners.push(() => node.removeEventListener(event, handler));
  }
  function showError(error) {
    if (destroyed) return;
    const value = typeof error === 'string' ? error : error?.message;
    $('error-notice').textContent = value || '操作未完成，请重试。';
    $('error-notice').hidden = false;
  }
  function clearError() { $('error-notice').hidden = true; }
  function toast(value) {
    if (destroyed) return;
    clearTimeout(toastTimer);
    $('toast').textContent = value;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
  }
  async function request(message) {
    const result = await sendFn(message);
    if (!result?.ok) {
      const error = new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || '本机服务没有返回有效响应。');
      error.code = result?.code;
      throw error;
    }
    return result;
  }
  function busy() { return pending || RUNNING.has(currentJob?.status); }
  function updateControls() {
    const active = busy();
    const available = Boolean(currentContext && $('source-text').value.trim());
    $('capture').disabled = active;
    $('context-select').disabled = active;
    $('source-text').disabled = active;
    $('generate').disabled = active || !available || !state.settings?.paired;
    $('generate-label').textContent = active ? '正在生成四种…' : '生成四种回复';
    $('cancel').hidden = !RUNNING.has(currentJob?.status);
    $('check-bridge').disabled = pending;
  }
  function renderPreferences(next) {
    // Removed context/style controls must not be restored by old saved settings.
    const {contextNote, ...rest} = next || {};
    preferences = {...preferences, ...rest, style: 'all'};
  }
  function getPreferences() { return {...preferences, style: 'all'}; }
  function renderConnection() {
    const paired = Boolean(state.settings?.paired);
    $('connection-status').className = `connection-label${paired ? ' connected' : ''}`;
    $('connection-text').textContent = paired ? '已连接 · 可以开聊' : '先连接本机服务';
    if (!paired) {
      $('connection-settings').hidden = false;
      $('settings-toggle').setAttribute('aria-expanded', 'true');
    }
  }
  function renderContext() {
    const contexts = Array.isArray(state.contexts) ? state.contexts : [];
    const selected = typeof state.selectedContext === 'string' ? contexts.find(item => item.id === state.selectedContext) : state.selectedContext;
    currentContext = selected || null;
    const select = $('context-select');
    select.replaceChildren();
    const options = currentContext && !contexts.some(item => item.id === currentContext.id) ? [currentContext, ...contexts] : contexts;
    for (const [index, context] of options.entries()) {
      const option = document.createElement('option');
      option.value = String(context.id);
      option.textContent = `${index + 1}. ${context.authorName || context.author || '推文'} · ${String(context.text || '').replace(/\s+/g, ' ').slice(0, 66)}`;
      option.selected = context.id === currentContext?.id;
      select.append(option);
    }
    $('source-empty').hidden = Boolean(currentContext);
    $('source-editor').hidden = !currentContext;
    $('source-text').value = currentContext?.text || '';
    $('source-note').textContent = currentContext?.hasMedia ? '生成时读取可用图片；缺少关键画面时会明确提示。' : '页面内容仅在你点击时读取。';
    $('quoted-context').hidden = !currentContext?.quote;
    $('quoted-text').textContent = currentContext?.quote || '';
    $('source-author').textContent = currentContext ? [currentContext.authorName, currentContext.author].filter(Boolean).join(' · ') || '当前推文' : '';
    const link = usablePostUrl(currentContext?.url);
    $('source-link').hidden = !link;
    if (link) $('source-link').href = link;
    else $('source-link').removeAttribute('href');
  }
  function contextSnapshot() {
    return currentContext ? { ...currentContext, text: $('source-text').value.trim() } : null;
  }
  function renderJob(job) {
    currentJob = job || null;
    const status = job?.status;
    const display = Boolean(status);
    $('job-status').hidden = !display;
    $('job-status').classList.toggle('terminal', !RUNNING.has(status));
    if (RUNNING.has(status)) $('job-status-text').textContent = '正在生成四种回复…';
    if (status === 'completed') $('job-status-text').textContent = job.contextStatus === 'missing' ? (job.missingContext || '缺少关键图片或视频，无法可靠生成回复。') : '四种回复已生成。挑一句，编辑后发送。';
    if (status === 'cancelled') $('job-status-text').textContent = '已停止生成。';
    if (status === 'failed') $('job-status-text').textContent = '这次没生成出来，可以调整后重试。';
    updateControls();
  }
  function resolveResultContext(candidate, jobContext) {
    return candidate?.context || jobContext || resultsContext || generationContext || currentContext;
  }
  function renderResults(candidates, jobContext) {
    const list = $('results-list');
    list.replaceChildren();
    const values = Array.isArray(candidates) ? candidates : [];
    $('result-empty').hidden = values.length > 0;
    $('result-count').textContent = values.length ? `${values.length} 条草稿` : '等你开聊';
    for (const [index, rawCandidate] of values.entries()) {
      const candidate = typeof rawCandidate === 'string' ? { text: rawCandidate } : rawCandidate;
      const style = candidate.style || ['witty', 'humor', 'insight', 'story'][index % 4];
      const context = resolveResultContext(candidate, jobContext);
      const initialText = candidate.text || candidate.content || '';
      const editKey = `${context?.id || context?.url || ''}:${candidate.id || style}:${initialText}`;
      const card = document.createElement('article');
      card.className = 'reply-card';
      const top = document.createElement('div'); top.className = 'reply-top';
      const title = document.createElement('div'); title.className = 'reply-style';
      const number = document.createElement('span'); number.className = 'reply-number'; number.textContent = String(index + 1).padStart(2, '0');
      const label = document.createElement('span'); label.textContent = Object.hasOwn(ACTUAL_STYLES,candidate.replyStyle)?ACTUAL_STYLES[candidate.replyStyle]:STYLES[style]?.label || candidate.label || '中文回复';
      title.append(number, label);
      top.append(title);
      const editor = document.createElement('textarea'); editor.className = 'reply-text'; editor.rows = 3; editor.value = draftEdits.has(editKey) ? draftEdits.get(editKey) : initialText; editor.setAttribute('aria-label', `编辑${label.textContent}回复`);
      const resize = () => { editor.style.height = 'auto'; editor.style.height = `${Math.max(90, Math.min(editor.scrollHeight, 400))}px`; };
      const reason = document.createElement('p'); reason.className = 'reply-reason'; reason.textContent = candidate.reason || candidate.rationale || ''; reason.hidden = !reason.textContent;
      const meta = document.createElement('div'); meta.className = 'reply-meta';
      const author = document.createElement('span'); author.className = 'reply-author'; author.textContent = context?.author ? `接 ${context.author} 的话` : '回复草稿';
      const count = document.createElement('span'); count.className = 'reply-count';
      const updateCount = () => { count.textContent = `${Array.from(editor.value).length} 字符`; };
      meta.append(author, count);
      const actions = document.createElement('div'); actions.className = 'reply-actions';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button button-secondary'; copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        try { await copyText(editor.value); toast('已复制，带上你的语气去聊聊。'); } catch { showError('复制未完成，请选中草稿后手动复制。'); }
      });
      const open = document.createElement('button'); open.type = 'button'; open.className = 'button button-primary'; open.textContent = '打开 X 回复窗口 ↗';
      open.disabled = !usablePostUrl(context?.url);
      open.addEventListener('click', () => act(async () => {
        await request({ type: 'openReply', context, draftText: editor.value });
        toast('已打开 X。确认内容后，亲自点击「回复」。');
      }));
      editor.addEventListener('input', () => { draftEdits.set(editKey, editor.value); updateCount(); resize(); });
      actions.append(copy, open);
      card.append(top, editor, reason, meta, actions);
      list.append(card);
      updateCount();
      requestAnimationFrame(resize);
    }
    updateControls();
  }
  function applyState(next, { preserveEditor = false, preservePreferences = false } = {}) {
    if (!next || destroyed) return;
    const editingText = $('source-text').value;
    const editingId = currentContext?.id;
    state = { ...state, ...next, settings: { ...state.settings, ...next.settings } };
    renderConnection();
    renderContext();
    if (preserveEditor && editingId === currentContext?.id) $('source-text').value = editingText;
    if (!preservePreferences) renderPreferences(state.preferences);
    resultsContext = state.resultsContext || state.job?.context || resultsContext;
    renderJob(state.job);
    const candidates = state.results?.candidates || state.results;
    renderResults(candidates, state.resultsContext);
    if (state.captureError) showError(state.captureError);
  }
  async function act(task, { lock = false } = {}) {
    if (destroyed || (lock && pending)) return null;
    clearError();
    if (lock) { pending = true; updateControls(); }
    try { return await task(); }
    catch (error) { showError(error); return null; }
    finally {
      if (lock) {
        pending = false;
        if (!destroyed) updateControls();
        if (refreshQueued && !destroyed) { refreshQueued = false; queueMicrotask(refreshState); }
      }
    }
  }
  async function checkConnection({ notify = true } = {}) {
    $('connection-text').textContent = '正在连接回复服务…';
    try {
      const checked = await request({ type: 'checkBridge' });
      if (destroyed) return;
      const latest = await request({ type: 'getState' });
      if (destroyed) return;
      const authenticated = Boolean(checked.health?.authenticated);
      // checkBridge owns automatic connection. getState supplies the updated
      // source/results, while local source and preference edits stay intact.
      const paired = authenticated && Boolean(checked.paired ?? latest.state?.settings?.paired);
      applyState({ ...latest.state, settings: { ...latest.state?.settings, paired } }, { preserveEditor: true, preservePreferences: true });
      $('bridge-detail').textContent = authenticated ? '本机回复服务已就绪，点击后一次生成四类回复。' : '本机服务已启动；请检查模型连接或登录配置。';
      $('connection-status').classList.toggle('error', !authenticated || !paired);
      $('connection-text').textContent = paired ? '已连接 · 可以开聊' : authenticated ? '回复服务尚未连接，请重试。' : '模型连接尚未就绪';
      if (notify) toast(paired ? '已连接，可以生成四类回复。' : authenticated ? '连接尚未完成，可以重新检查。' : '请先检查模型连接或登录配置。');
    } catch (error) {
      if (!destroyed) {
        state.settings = { ...state.settings, paired: false };
        renderConnection();
        $('connection-status').classList.add('error');
        $('bridge-detail').textContent = ['BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT'].includes(error.code) ? '本机回复服务未启动，请启动服务后重试。' : error.message;
      }
      throw error;
    }
  }
  async function refreshState() {
    if (destroyed) return null;
    if (pending) { refreshQueued = true; return null; }
    return act(async () => {
      const result = await request({ type: 'getState' });
      applyState(result.state, { preserveEditor: true, preservePreferences: true });
      startPolling();
    }, { lock: true });
  }
  async function generate() {
    if (busy()) return;
    const context = contextSnapshot();
    if (!context?.text?.trim()) { showError('先选一条推文，并确认原文内容。'); return; }
    const nextPreferences = getPreferences();
    await act(async () => {
      const result = await request({ type: 'generate', context, preferences: nextPreferences });
      generationContext = context;
      resultsContext = context;
      state.preferences = nextPreferences;
      state.job = result.job;
      renderJob(result.job);
      startPolling();
    }, { lock: true });
  }
  function startPolling() {
    clearTimeout(pollTimer);
    if (!destroyed && currentJob?.id && RUNNING.has(currentJob.status)) pollTimer = setTimeout(pollJob, 1500);
  }
  async function pollJob() {
    if (destroyed || polling || !currentJob?.id || !RUNNING.has(currentJob.status)) return;
    const id = currentJob.id;
    polling = true;
    try {
      const result = await request({ type: 'pollJob', id });
      if (destroyed || currentJob?.id !== id) return;
      const job = result.job || result.state?.job;
      if (TERMINAL.has(currentJob?.status) && RUNNING.has(job?.status)) return;
      if (result.state) {
        state = { ...state, ...result.state };
        if (result.state.settings) renderConnection();
      }
      renderJob(job);
      if (job?.status === 'completed') {
        const context = job.context || generationContext || result.state?.resultsContext || resultsContext;
        resultsContext = context;
        renderResults(job.candidates || result.state?.results?.candidates || result.state?.results, context);
      } else if (job?.status === 'failed') showError(job.error || '这次生成没有完成，请重试。');
      if (TERMINAL.has(job?.status)) clearTimeout(pollTimer);
    } catch (error) {
      if (!destroyed) showError(error);
    } finally {
      polling = false;
      startPolling();
    }
  }

  listen($('settings-toggle'), 'click', () => {
    $('connection-settings').hidden = !$('connection-settings').hidden;
    $('settings-toggle').setAttribute('aria-expanded', String(!$('connection-settings').hidden));
  });
  listen($('capture'), 'click', () => act(async () => {
    const result = await request({ type: 'capture' });
    applyState(result.state, { preservePreferences: true });
    if (state.contexts?.length) toast(`读取了 ${state.contexts.length} 条推文，选一条开聊。`);
    else showError('当前页面没有读到可回复的推文。打开 X 时间线，等推文加载后再试。');
  }, { lock: true }));
  listen($('context-select'), 'change', () => act(async () => {
    const result = await request({ type: 'selectContext', id: $('context-select').value });
    applyState(result.state, { preservePreferences: true });
  }, { lock: true }));
  listen($('source-text'), 'input', updateControls);
  listen($('generate'), 'click', () => generate());
  listen($('cancel'), 'click', () => act(async () => {
    const id = currentJob?.id;
    if (!id) return;
    $('cancel').disabled = true;
    try {
      const result = await request({ type: 'cancelJob', id });
      if (currentJob?.id === id) { state.job = result.job || result.state?.job; renderJob(state.job); clearTimeout(pollTimer); }
    } finally { $('cancel').disabled = false; }
  }));
  listen($('check-bridge'), 'click', () => act(() => checkConnection(), { lock: true }));
  listen(document, 'keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && !$('generate').disabled) { event.preventDefault(); generate(); }
  });
  $('installation-notice').hidden = true;
  const ready = act(async () => {
    const result = await request({ type: 'getState' });
    applyState(result.state);
    await checkConnection({ notify: false });
    if (RUNNING.has(currentJob?.status)) { generationContext = currentJob.context || state.resultsContext || currentContext; startPolling(); }
  }, { lock: true });
  return {
    ready,
    refresh: refreshState,
    destroy() { destroyed = true; clearTimeout(pollTimer); clearTimeout(toastTimer); listeners.forEach(remove => remove()); }
  };
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  } catch {}
  const input = document.createElement('textarea');
  input.value = value; input.style.position = 'fixed'; input.style.top = '0'; input.style.left = '-9999px';
  document.body.append(input); input.focus(); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('复制未完成');
}

if (globalThis.chrome?.runtime?.sendMessage) {
  const panel = mountPanel(message => chrome.runtime.sendMessage(message));
  if (chrome.runtime.onMessage?.addListener && chrome.runtime.getURL) {
    const backgroundUrl = chrome.runtime.getURL('background.js');
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type !== 'stateChanged' || sender?.id !== chrome.runtime.id || sender?.tab || (sender?.url && sender.url !== backgroundUrl)) return;
      panel.refresh();
    });
  }
}
else {
  document.getElementById('installation-notice').hidden = false;
  document.getElementById('connection-text').textContent = '请从浏览器插件打开';
  ['capture', 'check-bridge'].forEach(id => { document.getElementById(id).disabled = true; });
}
