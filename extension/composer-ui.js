// Isolated-world UI: never place pairing credentials inside an X page.
(() => {
  const NAMES = {witty: '认可并展开', humor: '幽默接梗', insight: '补充观点', story: '换个角度'};
  const STYLE_LABELS = globalThis.XReplyStyleCatalog?.labels || {};
  const TONES = Object.freeze({auto: '自动匹配', chat: '日常聊天', playful: '轻松有梗', professional: '理性专业', sharp: '犀利克制', ...STYLE_LABELS});
  const CSS = `
    :host{display:block;width:100%;max-width:100%;min-width:0;flex:0 0 auto;align-self:stretch;grid-column:1/-1;margin:10px 0 14px;color:var(--jyj-fg,#0f1419);color-scheme:light dark;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer}button:disabled{cursor:wait;opacity:.55}button:focus-visible{outline:2px solid #1d9bf0;outline-offset:3px}
    .box{border:1px solid var(--jyj-border,#cfe5f4);border-radius:16px;background:var(--jyj-bg,#f7fbfe);overflow:hidden}.head{display:flex;align-items:center;gap:8px;padding:11px 14px}.mark{display:grid;place-items:center;width:23px;height:23px;border-radius:7px;background:#1d9bf0;color:#fff;font-size:12px;font-weight:750}.title{font-weight:700;font-size:14px}.brand{color:var(--jyj-muted,#536471);font-size:11px}.spacer{flex:1}.link{border:0;background:none;color:#1d9bf0;padding:3px 5px;font-size:12px;font-weight:650}.body{padding:0 14px 12px}
    .status{display:flex;align-items:center;gap:7px;color:var(--jyj-muted,#536471);font-size:12px;margin:7px 0}.dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#1d9bf0}.busy .dot{animation:pulse 1s ease-in-out infinite}.status.error{color:var(--jyj-error,#b42318)}.choices{display:grid;gap:7px;max-height:400px;overflow-y:auto;overscroll-behavior:contain}.candidate{position:relative}.copy{position:absolute;right:9px;bottom:5px;font-size:10px;line-height:1.3}.choice{display:block;width:100%;border:1px solid var(--jyj-border,#d9e9f3);border-radius:11px;background:var(--jyj-card,#fff);color:inherit;padding:10px 12px 24px;text-align:left;white-space:normal}.choice:hover{border-color:#1d9bf0}.choice-label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--jyj-muted,#536471);margin-bottom:4px}.tag{color:#1688ce;font-weight:650}.choice-text{display:block;font-size:14px;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap}.arrow{margin-left:auto;color:#1d9bf0}.hint{font-size:11px;color:var(--jyj-muted,#536471);margin:8px 0 0}.actions{display:flex;align-items:center;gap:8px;margin:9px 0 0;flex-wrap:wrap}.primary{border:0;border-radius:20px;padding:7px 14px;background:#1d9bf0;color:#fff;font-size:12px;font-weight:700}.secondary{border:1px solid var(--jyj-border,#cfe5f4);border-radius:20px;padding:6px 12px;background:var(--jyj-card,#fff);color:inherit;font-size:12px}.replace{padding:10px;border-radius:10px;border:1px solid #1d9bf0;margin-top:8px;background:var(--jyj-card,#fff);font-size:12px}.replace p{margin:0 0 6px}[hidden]{display:none!important}@keyframes pulse{50%{opacity:.25}}@media(prefers-reduced-motion:reduce){.busy .dot{animation:none}}
  `;
  function mount(host, handlers) {
    const doc = host.ownerDocument;
    const root = host.attachShadow({mode: 'open'});
    function element(tag, className, text = '') { const node = doc.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
    function button(label, className, action) { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; }
    const style = element('style'); style.textContent = CSS; root.append(style);
    const box = element('section', 'box'); box.setAttribute('aria-label', 'X 评论助手中文 AI 回复'); root.append(box);
    const head = element('div', 'head'); box.append(head);
    head.append(element('span', 'mark', 'AI'), element('span', 'title', '中文 AI 回复'), element('span', 'brand', 'X 评论助手'), element('span', 'spacer'));
    const regenerate = button('生成四条回复', 'primary generate', () => handlers.generate('all'));
    const collapse = button('收起', 'link', () => { body.hidden = !body.hidden; collapse.textContent = body.hidden ? '展开' : '收起'; collapse.setAttribute('aria-expanded', String(!body.hidden)); }); collapse.setAttribute('aria-expanded', 'true'); head.append(regenerate, collapse);
    const body = element('div', 'body'); box.append(body);
    let inserting = false, currentPhase = 'idle', hasCandidates = false;
    const status = element('div', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); const dot = element('span', 'dot'); dot.setAttribute('aria-hidden', 'true'); const statusText = element('span'); status.append(dot, statusText); body.append(status);
    const batchTone = element('p', 'hint batch-tone'); batchTone.hidden = true; body.append(batchTone);
    const choices = element('div', 'choices'); body.append(choices);
    const actions = element('div', 'actions'); body.append(actions);
    const connect = button('重试生成', 'primary', handlers.retry), retry = button('重试', 'secondary', handlers.retry), cancel = button('停止生成', 'link', handlers.cancel);
    const settings = button('配置模型', 'primary configure', handlers.openSettings);
    actions.append(connect, retry, cancel, settings);
    const overwrite = element('div', 'replace'); overwrite.hidden = true; const overwriteText = element('p', '', '回复框里已有文字，你想怎么填入？'); const overwriteActions = element('div', 'actions'); overwrite.append(overwriteText, overwriteActions); body.append(overwrite);
    let pendingCandidate;
    for (const [label, mode] of [['替换原文字', 'replace'], ['接在后面', 'append'], ['取消', 'cancel']]) overwriteActions.append(button(label, mode === 'replace' ? 'primary' : 'secondary', () => { const candidate = pendingCandidate; pendingCandidate = null; overwrite.hidden = true; if (mode !== 'cancel' && candidate) handlers.insert(candidate, mode); }));
    body.append(element('p', 'hint', '挑一句填入或复制，可以继续修改。最后由你点击 X 的“回复”。'));
    function updateDisabled() {
      regenerate.disabled = currentPhase === 'loading' || inserting;
      connect.disabled = inserting; retry.disabled = inserting; cancel.disabled = inserting; settings.disabled = inserting;
      root.querySelectorAll('.choice, .replace button, .copy').forEach(button => { button.disabled = inserting; });
    }
    function setState({phase = 'ready', message = '', candidates = null, tonePreset, hasCustomTone = false, canCancel = false, canRetry = true, retryLabel = '重试'} = {}) {
      currentPhase = phase;
      status.className = `status${phase === 'loading' ? ' busy' : phase === 'error' ? ' error' : ''}`;
      statusText.textContent = message || (phase === 'loading' ? '正在生成四条回复…' : '四条候选，一次生成后挑选。');
      connect.hidden = phase !== 'connect' || !canRetry; retry.hidden = phase !== 'error' || !canRetry; retry.textContent = retryLabel; cancel.hidden = !canCancel;
      settings.hidden = phase !== 'settings';
      if (candidates) {
        hasCandidates = candidates.length > 0;
        batchTone.hidden = !hasCandidates;
        const matched=candidates.length>0&&candidates.every(candidate=>Object.hasOwn(STYLE_LABELS,candidate.replyStyle));
        const actual=matched?[...new Set(candidates.map(candidate=>STYLE_LABELS[candidate.replyStyle]))].join(' · '):'';
        batchTone.textContent = matched
          ? `${tonePreset==='auto'?'自动匹配':'本组风格'}：${actual}${hasCustomTone?' · 含补充偏好':''}`
          : `本组语气：${Object.hasOwn(TONES, tonePreset) ? TONES[tonePreset] + (tonePreset === 'auto' && hasCustomTone === true ? '·含补充偏好' : '') : '未记录（旧结果）'} · 旧结果未记录实际风格`;
        choices.replaceChildren(); overwrite.hidden = true; pendingCandidate = null;
        for (const candidate of candidates) {
          const choice = button('', 'choice', () => handlers.choose(candidate));
          const name=Object.hasOwn(STYLE_LABELS,candidate.replyStyle)?STYLE_LABELS[candidate.replyStyle]:NAMES[candidate.style]||'中文回复';
          const label = element('span', 'choice-label'); label.append(element('span', 'tag', name), element('span', 'arrow', '填入 ↗'));
          choice.append(label, element('span', 'choice-text', candidate.text)); choice.setAttribute('aria-label', `${name}：${candidate.text}`);
          const candidateRow = element('div', 'candidate'); const copy = button('复制', 'link copy', () => handlers.copy(candidate)); copy.setAttribute('aria-label', `复制${name}`); candidateRow.append(choice, copy); choices.append(candidateRow);
        }
      }
      regenerate.textContent = hasCandidates ? '换一组' : '生成四条回复'; updateDisabled();
    }
    setState({phase: 'idle', message: '按原帖匹配风格，点击后一次生成四条候选。'});
    return {setState, setInserting(value) { inserting = value; updateDisabled(); }, askBeforeOverwrite(candidate) { pendingCandidate = candidate; overwrite.hidden = false; }, destroy() { host.remove(); }, root};
  }

  const pendingInserts = new WeakMap();
  const alwaysCurrent = () => true;
  const insertionError = (message, code) => Object.assign(new Error(message), {code});
  function draftLeaves(block) {
    return [...block.querySelectorAll('[data-offset-key]')].filter(node => !node.querySelector('[data-offset-key]'));
  }
  function draftBlockText(block) {
    const last = draftLeaves(block).at(-1);
    // Draft renders one extra LF when its final leaf ends in a soft newline.
    // Remove that display character only; preserve real whitespace/empty blocks.
    return last?.textContent.endsWith('\n\n') ? block.textContent.slice(0, -1) : block.textContent;
  }
  function readDraftText(editor) {
    const contents = editor.querySelector('[data-contents="true"]');
    const blocks = contents && [...contents.querySelectorAll('[data-block="true"]')];
    if (blocks?.length) return blocks.map(draftBlockText).join('\n');
    return editor.innerText ?? editor.textContent ?? '';
  }
  function consistentDraftDOM(editor) {
    const contents = editor.querySelector('[data-contents="true"]');
    return !contents || editor.textContent === contents.textContent;
  }
  function editableRange(editor) {
    const doc = editor.ownerDocument;
    function point(block, end) {
      const leaves = draftLeaves(block);
      const leaf = (end ? leaves.at(-1) : leaves[0]) || block;
      const walker = doc.createTreeWalker(leaf, doc.defaultView.NodeFilter.SHOW_TEXT, {
        acceptNode(node) { return node.parentElement?.closest('[contenteditable="false"]') ? doc.defaultView.NodeFilter.FILTER_REJECT : doc.defaultView.NodeFilter.FILTER_ACCEPT; }
      });
      const nodes = []; let node;
      while ((node = walker.nextNode())) nodes.push(node);
      // Empty BR: Draft uses its keyed span at offset 0. A noneditable
      // entity with text must instead be included in the whole-leaf range.
      if (!nodes.length) return [leaf, end && leaf.textContent ? leaf.childNodes.length : 0];
      const target = end ? nodes.at(-1) : nodes[0];
      const displayLF = end && leaves.length && leaf.textContent.endsWith('\n\n') ? 1 : 0;
      return [target, end ? target.textContent.length - displayLF : 0];
    }
    const contents = editor.querySelector('[data-contents="true"]');
    const blocks = contents && [...contents.querySelectorAll('[data-block="true"]')];
    const start = point(blocks?.[0] || editor, false);
    const end = point(blocks?.at(-1) || editor, true);
    const range = doc.createRange();
    range.setStart(...start); range.setEnd(...end);
    return range;
  }
  function caretAtEnd(editor) {
    const doc = editor.ownerDocument, selection = doc.getSelection();
    if (doc.activeElement !== editor || !selection?.rangeCount || !selection.isCollapsed) return false;
    const current = selection.getRangeAt(0);
    if (!editor.contains(current.startContainer)) return false;
    const end = editableRange(editor); end.collapse(false);
    if (!current.compareBoundaryPoints(doc.defaultView.Range.START_TO_START, end)) return true;
    // Accept an equivalent parent/text boundary within the final block without
    // moving the user's selection or modifying the editor's DOM.
    const element = current.startContainer.nodeType === 1 ? current.startContainer : current.startContainer.parentElement;
    const block = element.closest('[data-block="true"]');
    const endElement = end.startContainer.nodeType === 1 ? end.startContainer : end.startContainer.parentElement;
    if (!block || block !== endElement.closest('[data-block="true"]')) return false;
    const prefix = doc.createRange(); prefix.selectNodeContents(block); prefix.setEnd(current.startContainer, current.startOffset);
    return prefix.toString().length === draftBlockText(block).length;
  }
  function settleFrame(doc) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 40);
      doc.defaultView?.requestAnimationFrame?.(finish);
    });
  }
  function insertDraft(editor, text, mode = 'replace', {isCurrent = alwaysCurrent} = {}) {
    const pending = pendingInserts.get(editor);
    if (pending) {
      if (pending.text === text && pending.mode === mode && pending.isCurrent === isCurrent) return pending.promise;
      return Promise.reject(insertionError('正在填入上一句，请稍等。', 'DRAFT_INSERT_BUSY'));
    }
    const promise = performInsert(editor, text, mode, isCurrent).finally(() => { if (pendingInserts.get(editor)?.promise === promise) pendingInserts.delete(editor); });
    if (editor && typeof editor === 'object') pendingInserts.set(editor, {text, mode, isCurrent, promise});
    return promise;
  }
  async function performInsert(editor, text, mode, isCurrent) {
    const valid = () => editor?.isConnected && editor.getAttribute('contenteditable') === 'true' && isCurrent();
    if (!valid()) throw insertionError('回复框已关闭或对象已变化，请重新点原帖的回复。', 'DRAFT_INSERT_INTERRUPTED');
    if (typeof text !== 'string' || !text || !['replace', 'append'].includes(mode)) throw insertionError('候选文字无效，未填入回复框。', 'DRAFT_INSERT_INTERRUPTED');
    if (!consistentDraftDOM(editor)) throw insertionError('回复框中有未同步的文字，请检查草稿并重新打开回复框。本次未填入。', 'DRAFT_INSERT_UNCERTAIN');
    const previous = readDraftText(editor);
    const value = mode === 'append' && previous ? `${previous}\n${text}` : text;
    const doc = editor.ownerDocument;
    const win = doc.defaultView;
    if (!win?.DataTransfer || !win?.ClipboardEvent) throw insertionError('当前编辑器无法直接填入，请点击候选的“复制”。', 'DRAFT_INSERT_UNSUPPORTED');
    let interrupted = false, selecting = true;
    const onInput = () => { if (selecting) interrupted = true; };
    const onPointer = () => { if (selecting) interrupted = true; };
    editor.addEventListener('beforeinput', onInput, true); editor.addEventListener('input', onInput, true);
    doc.addEventListener('pointerdown', onPointer, true);
    try {
      editor.focus();
      // Focus and DOM selection must reach Draft's onSelect before onPaste reads
      // its EditorState. DOM-only insertText can leave that state/caret stale.
      await settleFrame(doc);
      if (!valid() || interrupted || doc.activeElement !== editor || !consistentDraftDOM(editor) || readDraftText(editor) !== previous) throw insertionError('回复框已变化，本次未填入。请检查当前草稿后再试。', 'DRAFT_INSERT_INTERRUPTED');
      const range = editableRange(editor);
      if (!previous || mode === 'append' || previous === value) range.collapse(false);
      const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      doc.dispatchEvent(new win.Event('selectionchange'));
      await settleFrame(doc);
      if (!valid() || interrupted || doc.activeElement !== editor || !consistentDraftDOM(editor) || readDraftText(editor) !== previous) throw insertionError('回复框已变化，本次未填入。请检查当前草稿后再试。', 'DRAFT_INSERT_INTERRUPTED');
      const current = selection.rangeCount && selection.getRangeAt(0);
      const target = editableRange(editor); if (!previous || mode === 'append' || previous === value) target.collapse(false);
      if (!current || current.compareBoundaryPoints(win.Range.START_TO_START, target) || current.compareBoundaryPoints(win.Range.END_TO_END, target)) throw insertionError('光标位置已变化，本次未填入。请检查当前草稿后再试。', 'DRAFT_INSERT_INTERRUPTED');
      if (previous === value) return value;
      selecting = false;
      const data = new win.DataTransfer(); data.setData('text/plain', mode === 'append' && previous ? `\n${text}` : text);
      const paste = new win.ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true, composed: true});
      // One application-owned paste transaction. Never follow it with a second
      // DOM write, clipboard write, or automatic retry on a partial result.
      editor.dispatchEvent(paste);
      const started = Date.now(); let matchedAt = null;
      while (Date.now() - started < 600) {
        await settleFrame(doc);
        if (!valid()) throw insertionError('回复框已变化，请检查当前草稿。', 'DRAFT_INSERT_UNCERTAIN');
        if (paste.defaultPrevented && consistentDraftDOM(editor) && readDraftText(editor) === value && caretAtEnd(editor)) {
          matchedAt ??= Date.now();
          if (Date.now() - matchedAt >= 80) return value;
        } else matchedAt = null;
        if (!paste.defaultPrevented && consistentDraftDOM(editor) && readDraftText(editor) === previous) break;
      }
      if (!paste.defaultPrevented && consistentDraftDOM(editor) && readDraftText(editor) === previous) throw insertionError('编辑器没有处理填入，原文字保留。可点击候选的“复制”。', 'DRAFT_INSERT_UNSUPPORTED');
      if (paste.defaultPrevented && readDraftText(editor) === previous) throw insertionError('编辑器尚未确认填入，请先检查回复框。本次不会重复填入。', 'DRAFT_INSERT_UNCERTAIN');
      throw insertionError('填入结果与候选不一致，请检查回复框中的文字。本次不会重复填入。', 'DRAFT_INSERT_UNCERTAIN');
    } finally {
      editor.removeEventListener('beforeinput', onInput, true); editor.removeEventListener('input', onInput, true);
      doc.removeEventListener('pointerdown', onPointer, true);
    }
  }
  globalThis.__JieYiJuUI = Object.freeze({mount, insertDraft, readDraftText});
})();
