// Runs only on X/Twitter, in an isolated content-script world. Never sends a post.
(() => {
  if (!['x.com', 'twitter.com'].includes(location.hostname) || window.top !== window || globalThis.__JieYiJuComposerInstalled) return;
  globalThis.__JieYiJuComposerInstalled = true;
  const source = globalThis.__JieYiJuSource;
  const ui = globalThis.__JieYiJuUI;
  if (!source || !ui || !globalThis.chrome?.runtime?.sendMessage) return;
  const EDITORS = '[data-testid^="tweetTextarea_"][contenteditable="true"][role="textbox"]';
  const POLL_RETRY_DELAYS = [1000, 2000, 3000];
  const instances = new Map();
  let clicked = null;
  let scanTimer;

  async function send(message) {
    let response;
    try { response = await chrome.runtime.sendMessage(message); }
    catch { throw Object.assign(new Error('插件已更新或连接中断，请刷新 X 页面后再试。'), {code: 'EXTENSION_RELOADED'}); }
    if (!response?.ok) throw Object.assign(new Error(response?.error || '暂时无法生成中文回复，请重试。'), {code: response?.code});
    return response;
  }
  function timelineContexts() {
    return [...document.querySelectorAll('article[data-testid="tweet"]')]
      .filter(article => !article.closest('[role="dialog"]'))
      .map(article => source.extractArticle(article, location.href)).filter(Boolean);
  }
  function contextFor(scope, timeline, editor) {
    const replyScope = scope.tagName === 'MAIN' && editor ? editor.closest('[data-testid$="_label"]') || editor.parentElement : null;
    return source.getReplyContext(scope, {clickedContext: clicked && Date.now() - clicked.at < 300000 ? clicked.context : null, locationHref: location.href, timelineContexts: timeline, replyScope, allowComposerVisible: true});
  }
  const identityText = value => String(value ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const mediaIdentity = value => JSON.stringify((value.media || []).map(item => {
    let url = item.url;
    try { const parsed = new URL(url); url = `${parsed.origin}${parsed.pathname}${parsed.searchParams.has('format') ? `?format=${parsed.searchParams.get('format')}` : ''}`; } catch {}
    return {kind: item.kind, url, alt: item.alt || ''};
  }));
  function sameSource(left, right) {
    return Boolean(left && right && (left.contextKind ?? 'permalink') === (right.contextKind ?? 'permalink') && left.id === right.id && left.url === right.url && String(left.author).toLowerCase() === String(right.author).toLowerCase() && identityText(left.text) === identityText(right.text) && identityText(left.quote) === identityText(right.quote) && mediaIdentity(left) === mediaIdentity(right));
  }
  function mountAnchor(editor, scope) {
    let anchor = editor.closest('[data-testid$="_label"]') || editor.closest('[data-testid$="RichTextInputContainer"]') || editor.parentElement;
    if (scope.tagName === 'MAIN') {
      // On detail pages X nests a column of editor wrappers inside a horizontal
      // editor + send-actions row. A nearby column is not the whole composer.
      // Place below the smallest row containing this editor and its own reply
      // button, without reaching the main timeline or another comment editor.
      for (let row = anchor; row && row !== scope; row = row.parentElement) {
        if (!row.querySelector('[data-testid="tweetButtonInline"]')) continue;
        if (row.querySelectorAll(EDITORS).length !== 1) return null;
        anchor = row;
        // The compact detail composer centers its avatar against the whole row.
        // Keep the AI panel outside that row too, so its height cannot drag the
        // avatar and send buttons down alongside the candidate list.
        for (let outer = row.parentElement; outer && outer !== scope; outer = outer.parentElement) {
          if (outer.querySelectorAll(EDITORS).length !== 1 || outer.querySelector('article[data-testid="tweet"]')) break;
          const avatar = outer.querySelector('[data-testid^="UserAvatar-Container"]');
          if (avatar && !row.contains(avatar)) { anchor = outer; break; }
        }
        break;
      }
    }
    // X wraps its label in additional horizontal flex rows. Insert below the entire
    // row, in a column/block parent, so the panel never competes with the textbox.
    while (anchor?.parentElement && scope.contains(anchor.parentElement)) {
      const parent = anchor.parentElement;
      const layout = getComputedStyle(parent);
      const horizontal = ['flex', 'inline-flex'].includes(layout.display) && !layout.flexDirection.startsWith('column');
      if (!horizontal && layout.display !== 'contents') return anchor;
      if (parent === scope) return null;
      anchor = parent;
    }
    return null;
  }
  function explicitlyHidden(editor) {
    for (let node = editor; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return true;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    }
    return false;
  }
  function errorState(view, error, canCancel = false, canRetry = true) {
    if (error.code === 'EXTENSION_UPDATE_REQUIRED') canRetry = false;
    const phase = error.code === 'DIRECT_CONFIG_REQUIRED' ? 'settings' : !canCancel && ['NOT_PAIRED', 'PAIRING_EXPIRED', 'BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT'].includes(error.code) ? 'connect' : 'error';
    view.setState({phase, message: error.message, canCancel, canRetry, retryLabel: canCancel ? '继续查看' : '重试'});
  }
  function createInstance(editor, scope, context, timeline) {
    const anchor = mountAnchor(editor, scope);
    if (!anchor) return null;
    const host = document.createElement('div'); host.dataset.jieyiju = 'reply-options';
    const colors = getComputedStyle(editor);
    const dark = (() => { const rgb = colors.color.match(/\d+/g); return rgb && Number(rgb[0]) + Number(rgb[1]) + Number(rgb[2]) > 500; })();
    if (dark) { host.style.setProperty('--jyj-fg', '#e7e9ea'); host.style.setProperty('--jyj-muted', '#a1a9b0'); host.style.setProperty('--jyj-bg', '#101b24'); host.style.setProperty('--jyj-card', '#15202b'); host.style.setProperty('--jyj-border', '#304452'); host.style.setProperty('--jyj-error', '#ff998d'); }
    anchor.after(host);
    let closed = false;
    let sessionId = '';
    let job = null;
    let busy = false;
    let paired = false;
    let pollTimer;
    let pollFailures = 0;
    let pollVersion = 0;
    let cancelling = false;
    let lastInserted = '';
    let inserting = false;
    let updateRequired = false;
    const selectedStyle = 'all';
    let requested = false;
    const stillCurrent = () => {
      if (closed || !editor.isConnected || !host.isConnected) return false;
      const current = contextFor(scope, timeline, editor);
      return sameSource(current, context);
    };
    function handleError(error) {
      busy = false; clearTimeout(pollTimer);
      if (error.code === 'EXTENSION_UPDATE_REQUIRED') updateRequired = true;
      if (['NOT_PAIRED', 'PAIRING_EXPIRED'].includes(error.code)) { paired = false; job = null; }
      if (error.code === 'INLINE_SESSION_EXPIRED') { sessionId = ''; job = null; }
      if (!closed) errorState(view, error, job?.status === 'running', requested);
    }
    const view = ui.mount(host, {
      generate() {
        if (updateRequired || busy || inserting || cancelling) return;
        // A failed result lookup never turns the same click into a second AI job.
        if (requested && job?.status === 'running') { resumePoll(); return; }
        clearTimeout(pollTimer); pollFailures = 0; pollVersion++;
        job = null; requested = true; initialize();
      },
      retry: async () => { if (updateRequired || !requested || busy || inserting || cancelling) return; scan(); if (closed) return; if (job?.status === 'running') await resumePoll(); else await initialize(); },
      openSettings: async () => {
        if (busy || inserting || cancelling) return;
        try { await send({type: 'inlineOpenSetup'}); }
        catch (error) { handleError(error); }
      },
      cancel: async () => {
        if (inserting || cancelling || !sessionId || !job?.id) return;
        clearTimeout(pollTimer); pollVersion++; cancelling = true; busy = true;
        view.setState({phase: 'loading', message: '正在停止生成…', canRetry: false});
        try { const result = await send({type: 'inlineCancel', sessionId, id: job.id}); if (!closed) { job = result.job; busy = false; requested = false; pollFailures = 0; view.setState({message: updateRequired ? '已停止。请重新加载插件并刷新 X 后再生成。' : '已停止，点击“生成四条回复”再开始。'}); } }
        catch (error) { handleError(error); }
        finally { cancelling = false; }
      },
      choose: candidate => {
        if (inserting) return;
        if (!stillCurrent()) { view.setState({phase: 'error', canRetry: false, message: '回复对象已变化，请关闭后重新点原帖的回复。'}); return; }
        const existing = ui.readDraftText(editor);
        if (existing && existing !== lastInserted) view.askBeforeOverwrite(candidate);
        else insert(candidate, 'replace');
      },
      insert,
      copy: async candidate => {
        if (inserting) return;
        try { await navigator.clipboard.writeText(candidate.text); if (!closed) view.setState({message: '已复制，可以粘贴到回复框。'}); }
        catch { if (!closed) view.setState({phase: 'error', canRetry: false, message: '浏览器未允许复制，请选择候选文字复制。'}); }
      }
    });
    async function insert(candidate, mode) {
      if (inserting) return;
      if (!stillCurrent()) { view.setState({phase: 'error', canRetry: false, message: '回复对象已变化，草稿未填入。请重新打开原帖回复。'}); return; }
      inserting = true; view.setInserting(true);
      try {
        lastInserted = await ui.insertDraft(editor, candidate.text, mode, {isCurrent: stillCurrent});
        if (!closed) view.setState({message: '已填入。可以修改，再点击 X 的“回复”。'});
      } catch (error) {
        if (closed) return;
        view.setState({phase: 'error', canRetry: false, message: `${error.message} 候选仍保留在下面。`});
      } finally { inserting = false; if (!closed) view.setInserting(false); }
    }
    async function initialize() {
      if (!requested || closed || busy || inserting) return;
      if (!context || !stillCurrent()) { view.setState({phase: 'error', canRetry: false, message: '没有定位到原帖，请关闭弹窗，再从原帖点击回复。'}); return; }
      busy = true;
      view.setState({phase: 'loading', message: '正在连接回复服务…'});
      try {
        if (!sessionId) {
          const initialized = await send({type: 'inlineInit', context});
          sessionId = initialized.sessionId; paired = initialized.paired;
          if (initialized.enabled === false) throw Object.assign(new Error('X Comment Assistant 已暂停。请点击工具栏图标开启，再点击生成。'), {code: 'ASSISTANT_PAUSED'});
          if (closed) { send({type: 'inlineClose', sessionId}).catch(() => {}); return; }
        } else {
          const health = await send({type: 'inlineHealth'}); paired = health.paired;
          if (health.enabled === false) throw Object.assign(new Error('X Comment Assistant 已暂停。请点击工具栏图标开启，再点击生成。'), {code: 'ASSISTANT_PAUSED'});
        }
        if (!stillCurrent()) return;
        if (!paired) { view.setState({phase: 'connect', message: '本机服务尚未连接。启动后点击“重试生成”。'}); return; }
        view.setState({phase: 'loading', message: '正在生成四条回复…', candidates: []});
        const result = await send({type: 'inlineGenerate', sessionId, style: selectedStyle});
        if (!stillCurrent()) return;
        job = result.job;
        await displayJob();
      } catch (error) { handleError(error); }
      finally { if (!job || job.status !== 'running') busy = false; }
    }
    async function displayJob() {
      clearTimeout(pollTimer);
      if (closed) return;
      if (job?.status === 'failed' && job.code === 'EXTENSION_UPDATE_REQUIRED') {
        handleError({code: job.code, message: job.error || '请重新加载“X Comment Assistant”并刷新 X 后再生成。'});
        return;
      }
      if (job?.status === 'completed') {
        busy = false; requested = false;
        const missing = job.contextStatus === 'missing' || job.candidates?.length === 0;
        view.setState({message: missing ? (job.missingContext || '缺少关键图片或视频，无法可靠生成回复。') : '四条候选已生成，挑一句填入或复制。', candidates: job.candidates, tonePreset: job.tonePreset, hasCustomTone: job.hasCustomTone});
      }
      else if (job?.status === 'running') { view.setState({phase: 'loading', canCancel: true}); pollTimer = setTimeout(poll, 1200); }
      else { busy = false; view.setState({phase: 'error', message: job?.error || (job?.status === 'cancelled' ? '已停止生成，点击“换一组”重新来。' : '生成没有完成，请重试。')}); }
    }
    async function poll() {
      if (cancelling || !requested || !stillCurrent() || !sessionId || !job?.id || job.status !== 'running') return;
      const version = pollVersion, ownedSession = sessionId, ownedJob = job.id;
      const ownsPoll = () => !cancelling && requested && stillCurrent() && version === pollVersion && sessionId === ownedSession && job?.id === ownedJob && job.status === 'running';
      try {
        const result = await send({type: 'inlinePoll', sessionId: ownedSession, id: ownedJob});
        if (!ownsPoll()) return;
        pollFailures = 0;
        job = result.job;
        await displayJob();
      } catch (error) {
        if (!ownsPoll()) return;
        if (['BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT'].includes(error.code)) {
          const retryDelay = POLL_RETRY_DELAYS[pollFailures];
          if (retryDelay !== undefined) {
            pollFailures++; busy = true;
            view.setState({phase: 'loading', message: `本机连接暂时中断，正在恢复查看（${pollFailures}/${POLL_RETRY_DELAYS.length}）…`, canCancel: true});
            pollTimer = setTimeout(poll, retryDelay);
            return;
          }
          error = {...error, message: '连接暂未恢复。点击“继续查看”继续查询这条任务，或停止生成。'};
        }
        handleError(error);
      }
    }
    async function resumePoll() {
      clearTimeout(pollTimer); pollFailures = 0; busy = true;
      view.setState({phase: 'loading', message: '正在继续查看这条回复…', canCancel: true});
      await poll();
    }
    view.setState({phase: 'idle', message: context ? '按原帖匹配风格，点击后一次生成四条候选。' : '等待原帖内容显示，点击“生成四条回复”再开始。'});
    return {
      host, context, scope, currentContext: () => contextFor(scope, timeline, editor),
      place() { const next = mountAnchor(editor, scope); if (next && (host.parentElement !== next.parentElement || host.previousElementSibling !== next)) next.after(host); },
      destroy() { closed = true; clearTimeout(pollTimer); pollVersion++; view.destroy(); if (sessionId) send({type: 'inlineClose', sessionId}).catch(() => {}); }
    };
  }
  function scan() {
    clearTimeout(scanTimer);
    // A mounted editor can briefly have zero width during X's layout updates.
    // Treat explicit hiding/disconnection as closure, not transient geometry.
    const editors = [...document.querySelectorAll(EDITORS)].filter(editor => editor.isConnected && !explicitlyHidden(editor) && (instances.has(editor) || editor.getBoundingClientRect().width > 0));
    const seen = new Set();
    let timeline;
    for (const editor of editors) {
      const scope = editor.closest('[role="dialog"]') || (/^\/[^/]+\/status\/\d{5,25}\/?$/.test(location.pathname) ? editor.closest('main') : null);
      if (!scope || !source.isReplyComposer(scope)) continue;
      // A detail page can also contain editors replying to comments. Only its original
      // reply field is supported here; comment replies are supported through their dialog.
      if (scope.tagName === 'MAIN' && scope.querySelector(EDITORS) !== editor) continue;
      seen.add(editor);
      let existing = instances.get(editor);
      if (existing) existing.place();
      if (existing && !existing.host.isConnected) { existing.destroy(); instances.delete(editor); existing = null; }
      if (existing) {
        const next = existing.currentContext();
        if (existing.scope === scope && sameSource(next, existing.context)) continue;
        timeline ||= timelineContexts();
        const refreshed = contextFor(scope, timeline, editor);
        if (!existing.context && !refreshed && existing.scope === scope) continue;
        if (existing.scope === scope && sameSource(refreshed, existing.context)) continue;
        existing.destroy(); instances.delete(editor);
      }
      timeline ||= timelineContexts();
      const instance = createInstance(editor, scope, contextFor(scope, timeline, editor), timeline);
      if (instance) instances.set(editor, instance);
    }
    for (const [editor, instance] of instances) if (!seen.has(editor) || !instance.host.isConnected) { instance.destroy(); instances.delete(editor); }
  }
  function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 100); }
  function rememberReply(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const reply = target?.closest('[data-testid="reply"]');
    if (!reply) return;
    const article = reply.closest('article[data-testid="tweet"]');
    const context = article && source.extractArticle(article, location.href);
    clicked = context ? {context, at: Date.now()} : null;
    scheduleScan();
  }
  document.addEventListener('pointerdown', rememberReply, true);
  document.addEventListener('click', rememberReply, true);
  const observer = new MutationObserver(records => {
    const needsScan = records.some(record => {
      if (record.target instanceof Element && record.target.closest('[data-jieyiju="reply-options"]')) return false;
      if (record.type === 'attributes' || record.type === 'characterData') return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => {
        if (!(node instanceof Element) || node.dataset.jieyiju !== 'reply-options') return true;
        // Our own insertion/removal needs no scan. If X removes a live panel,
        // restore it on the next scan without treating it as a closed editor.
        return !node.isConnected && [...instances.values()].some(instance => instance.host === node);
      });
    });
    if (needsScan) scheduleScan();
  });
  const observeOptions = {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'src', 'srcset', 'poster', 'alt']};
  observer.observe(document.documentElement, observeOptions);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
  window.addEventListener('focus', scan);
  window.addEventListener('pagehide', () => { observer.disconnect(); clearTimeout(scanTimer); for (const instance of instances.values()) instance.destroy(); instances.clear(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { observer.observe(document.documentElement, observeOptions); scan(); } });
  scan();
})();
