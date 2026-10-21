import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const root = new URL('./', import.meta.url);
const fixture = await readFile(new URL('fixtures/observed-reply-20261010.html', root), 'utf8');
const scripts = await Promise.all(['reply-style-catalog.js', 'composer-source.js', 'composer-ui.js', 'composer.js'].map(file => readFile(new URL(`extension/${file}`, root), 'utf8')));
const candidates = ['witty', 'humor', 'insight', 'story'].map((style, i) => ({style, label: ['换个角度', '轻松接话', '补充条件', '假设场景'][i], text: `这是一条中文候选${i + 1}，结合原帖补充一个具体角度。`}));
const naturalCandidates = [
  {style: 'witty', label: '接一句', text: '活还是两小时，只是改成教它干了。'},
  {style: 'humor', label: '另一句', text: '活没交，需求文档倒是写完了。'}
];
const understanding = {meaning: '作者在反讽加班，想有人接住吐槽。', signals: ['反讽', '吐槽'], evidence: ['太好了与凌晨加班形成反差。'], contextStatus: 'sufficient', missingContext: '', replyAction: '顺着加班的吐槽接一句，不祝贺。'};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function clickGenerate(h) { await until(() => h.shadow()?.querySelector('.generate')); h.shadow().querySelector('.generate').click(); }
async function until(condition, timeout = 1500) { const start = Date.now(); while (!condition()) { if (Date.now() - start > timeout) throw new Error('DOM condition timed out'); await delay(20); } }

function harness({paired = true, intercept, html = fixture, simulatedWidth = () => 600, nestedFlex = false, pasteMode = 'handled', pasteDelay = 24, decorateContext = context => context, modalFocusTrap = false, fastPolling = false} = {}) {
  // Only trusted fixture markup and our source files execute; external resources never load.
  const dom = new JSDOM(html, {url: 'https://x.com/compose/post', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  const pollWaits = [];
  if (fastPolling) {
    const nativeTimeout = w.setTimeout.bind(w);
    // Keep the production delay observable while accelerating only long polling
    // waits in this isolated fixture; editor and lifecycle timers stay native.
    w.setTimeout = (callback, ms, ...args) => {
      if (ms >= 1000) { pollWaits.push(ms); return nativeTimeout(callback, 80, ...args); }
      return nativeTimeout(callback, ms, ...args);
    };
  }
  const calls = []; const inputs = []; const copies = []; const pastes = []; const models = new WeakMap(); let sendClicks = 0; let contextReads = 0;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {get() { return this.textContent; }, set(value) { this.textContent = value; }, configurable: true});
  // jsdom does not lay out flex containers. These explicit widths model lifecycle
  // transitions only; structural ancestry assertions are separate from real layout.
  w.HTMLElement.prototype.getBoundingClientRect = function () { const width = simulatedWidth(this); return {width, height: 120, top: 0, bottom: 120, left: 0, right: width}; };
  if (nestedFlex) {
    const label = w.document.querySelector('[role=dialog] [data-testid="tweetTextarea_0_label"]');
    const column = w.document.createElement('div'); column.dataset.fixture = 'composer-column'; column.style.cssText = 'display:flex;flex-direction:column';
    const row = w.document.createElement('div'); row.dataset.fixture = 'avatar-input-row'; row.style.cssText = 'display:flex;flex-direction:row';
    const avatar = w.document.createElement('span'); avatar.textContent = '头像'; avatar.style.cssText = 'flex:0 0 40px';
    const inputRow = w.document.createElement('div'); inputRow.dataset.fixture = 'inner-input-row'; inputRow.style.cssText = 'display:flex;flex-direction:row;flex:1;min-width:0';
    const toolbar = w.document.createElement('div'); toolbar.dataset.fixture = 'composer-toolbar'; toolbar.textContent = '回复工具栏';
    label.replaceWith(column); inputRow.append(label); row.append(avatar, inputRow); column.append(row, toolbar);
  }
  Object.defineProperty(w.navigator, 'clipboard', {value: {async writeText(text) { copies.push(text); }}});
  // Draft keeps its own text/selection model. A plain DOM write or insertText
  // cannot stand in for its paste transaction: these tests require selection to
  // reach the model before paste, then rebuild the editable leaf asynchronously.
  w.document.execCommand = () => { throw new Error('Unexpected execCommand mutation'); };
  w.DataTransfer = class {
    #data = new Map();
    setData(type, value) { this.#data.set(type, String(value)); }
    getData(type) { return this.#data.get(type) || ''; }
    get types() { return [...this.#data.keys()]; }
  };
  w.ClipboardEvent = class extends w.Event {
    constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData ?? null; }
  };
  const textbox = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('[contenteditable=true][role=textbox]');
  function offsetWithin(editor, container, offset) {
    const prefix = w.document.createRange(); prefix.selectNodeContents(editor); prefix.setEnd(container, offset); return prefix.toString().length;
  }
  function renderDraft(editor, text, caret = null) {
    const contents = w.document.createElement('div'); contents.dataset.contents = 'true';
    const block = w.document.createElement('div'); block.dataset.block = 'true'; block.dataset.offsetKey = 'fixture-0-0';
    const keyedLeaf = w.document.createElement('span'); keyedLeaf.dataset.offsetKey = 'fixture-0-0';
    const leaf = w.document.createElement('span'); leaf.dataset.text = 'true';
    leaf.append(text ? w.document.createTextNode(text) : w.document.createElement('br')); keyedLeaf.append(leaf); block.append(keyedLeaf); contents.append(block); editor.replaceChildren(contents);
    if (caret !== null) {
      const range = w.document.createRange(); const node = text ? leaf.firstChild : leaf;
      range.setStart(node, text ? caret : 0); range.collapse(true);
      const selection = w.document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  }
  w.document.addEventListener('selectionchange', () => {
    const selection = w.document.getSelection(); if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0); const editor = textbox(range.startContainer);
    if (!editor || !editor.contains(range.endContainer)) return;
    const model = {text: editor.textContent, start: offsetWithin(editor, range.startContainer, range.startOffset), end: offsetWithin(editor, range.endContainer, range.endOffset), startNode: range.startContainer, endNode: range.endContainer, startOffset: range.startOffset, endOffset: range.endOffset, collapsed: range.collapsed};
    w.setTimeout(() => { if (editor.isConnected) models.set(editor, model); }, 0);
  });
  w.document.addEventListener('paste', event => {
    const editor = event.target.closest?.('[contenteditable=true][role=textbox]'); if (!editor) return;
    const model = models.get(editor); const text = event.clipboardData?.getData('text/plain') || '';
    pastes.push({target: editor, text, previous: model?.text, start: model?.start, end: model?.end, leafRange: Boolean(model && model.startNode !== editor && model.endNode !== editor), startNode: model?.startNode, startOffset: model?.startOffset, endOffset: model?.endOffset, collapsed: model?.collapsed});
    const behavior = typeof pasteMode === 'function' ? pasteMode() : pasteMode;
    if (behavior === 'unhandled') return;
    assert.ok(model, 'Draft must receive a selectionchange before paste');
    assert.notEqual(model.startNode, editor, 'paste selection starts inside an editable leaf');
    assert.notEqual(model.endNode, editor, 'paste selection ends inside an editable leaf');
    event.preventDefault();
    if (behavior === 'pending') return;
    const inserted = behavior === 'partial' ? text.slice(0, Math.ceil(text.length / 2)) : text;
    const next = `${model.text.slice(0, model.start)}${inserted}${model.text.slice(model.end)}`;
    const caret = model.start + inserted.length;
    models.set(editor, {text: next, start: caret, end: caret});
    w.setTimeout(() => {
      if (!editor.isConnected) return;
      renderDraft(editor, next, caret);
      editor.dispatchEvent(new w.InputEvent('input', {bubbles: true, inputType: 'insertFromPaste', data: inserted}));
    }, pasteDelay);
  });
  w.document.addEventListener('input', event => inputs.push({target: event.target, text: event.target.textContent}));
  w.document.querySelector('[data-testid=tweetButton]')?.addEventListener('click', () => { sendClicks++; });
  w.chrome = {runtime: {id: 'a'.repeat(32), async sendMessage(message) {
    calls.push(message);
    const custom = await intercept?.(message);
    if (custom !== undefined) return custom;
    if (message.type === 'inlineInit') return {ok: true, sessionId: `session-${message.context.id}`, paired};
    if (message.type === 'inlineHealth') return {ok: true, paired};
    if (message.type === 'inlineGenerate' || message.type === 'inlinePoll') return {ok: true, job: {id: `job-${message.sessionId}`, status: 'completed', candidates}};
    if (message.type === 'inlineCancel') return {ok: true, job: {id: message.id, status: 'cancelled'}};
    if (message.type === 'inlineClose') return {ok: true, closed: true};
    throw new Error(`Unexpected message ${message.type}`);
  }}};
  const editor = () => w.document.querySelector('[role=dialog] [contenteditable=true]');
  const host = () => w.document.querySelector('[data-jieyiju=reply-options]');
  const shadow = () => host()?.shadowRoot;
  const focusTargets = () => [...(editor()?.closest('[role=dialog]')?.querySelectorAll('textarea, input, button, a[href], [tabindex], [contenteditable=true]') || [])]
    .filter(node => !node.disabled && !node.closest('[hidden], [aria-hidden=true]'));
  if (modalFocusTrap) {
    // Models the observed X modal: its light DOM focus enumeration cannot see
    // a shadow textarea and sees that textarea's focusin target as the host.
    // A real light DOM textarea remains both discoverable and the event target.
    w.document.addEventListener('focusin', event => {
      if (!focusTargets().includes(event.target)) editor()?.focus();
    }, true);
  }
  function start() {
    for (const editable of w.document.querySelectorAll('[contenteditable=true][role=textbox]')) renderDraft(editable, editable.textContent);
    scripts.forEach((script, index) => {
      w.eval(script);
      if (index === 1) { // catalogue loads first; wrap source after its script initializes.
        const original = w.__JieYiJuSource;
        w.__JieYiJuSource = Object.freeze({...original, getReplyContext(...args) { contextReads++; const context = original.getReplyContext(...args); return context && decorateContext(context); }});
      }
    });
  }
  function dispose() { w.dispatchEvent(new w.Event('pagehide')); w.close(); }
  return {w, calls, inputs, copies, pastes, pollWaits, editor, host, shadow, focusTargets, start, dispose, sent: () => sendClicks, contextReads: () => contextReads};
}

test('candidate batch shows its captured tone without relabelling existing results or generating on focus', async () => {
  let tonePreset = 'professional';
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? {ok: true, job: {id: 'tone-snapshot', status: 'completed', candidates, tonePreset}} : undefined});
  try {
    h.start(); await until(() => h.shadow());
    assert.equal(h.shadow().querySelector('.batch-tone').hidden, true);
    await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('.batch-tone').textContent, '本组语气：理性专业 · 旧结果未记录实际风格');
    tonePreset = 'sharp'; h.w.dispatchEvent(new h.w.Event('focus')); await delay(100);
    assert.equal(h.shadow().querySelector('.batch-tone').textContent, '本组语气：理性专业 · 旧结果未记录实际风格');
    assert.equal(h.calls.filter(message => message.type === 'inlineGenerate').length, 1);
    await clickGenerate(h); await until(() => h.calls.filter(message => message.type === 'inlineGenerate').length === 2 && h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('.batch-tone').textContent, '本组语气：犀利克制 · 旧结果未记录实际风格');
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('legacy or unrecognized batch tone is explicitly unknown and never assumed from current settings', async () => {
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? {ok: true, job: {id: 'legacy-tone', status: 'completed', candidates, tonePreset: 'private-untrusted-tone'}} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('.batch-tone').textContent, '本组语气：未记录（旧结果） · 旧结果未记录实际风格');
    assert.equal(h.shadow().textContent.includes('private-untrusted-tone'), false);
  } finally { h.dispose(); }
});

test('automatic batch discloses existence of supplementary tone without exposing its content', async () => {
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? {ok: true, job: {id: 'automatic-tone', status: 'completed', candidates, tonePreset: 'auto', hasCustomTone: true}} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('.batch-tone').textContent, '本组语气：自动匹配·含补充偏好 · 旧结果未记录实际风格');
  } finally { h.dispose(); }
});

test('opening simplified four-type UI and returning focus never connect or generate', async () => {
  const h = harness();
  try {
    const ownDraft = '还没写完的个人回复，只留在输入框。'; h.editor().textContent = ownDraft;
    h.start(); await until(() => h.shadow()?.querySelector('.generate'));
    const shadow = h.shadow(), host = h.host();
    assert.equal(shadow.querySelector('.generate').textContent, '生成四条回复');
    assert.equal(shadow.querySelectorAll('.chip, textarea, details').length, 0);
    assert.equal(host.querySelector('textarea'), null);
    for (let i = 0; i < 3; i++) { h.w.dispatchEvent(new h.w.Event('focus')); h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); const span = h.w.document.createElement('span'); span.textContent = '更新'; h.w.document.body.append(span); await delay(150); }
    assert.equal(h.host(), host); assert.deepEqual(h.calls, []); assert.equal(h.editor().textContent, ownDraft);
    await clickGenerate(h); await until(() => shadow.querySelectorAll('.choice').length === 4);
    const generated = h.calls.find(call => call.type === 'inlineGenerate');
    assert.equal(generated.style, 'all'); assert.equal(Object.hasOwn(generated, 'preferences'), false);
    assert.equal(JSON.stringify(h.calls).includes(ownDraft), false);
    shadow.querySelector('.head .link').click(); shadow.querySelector('.head .link').click(); await delay(100);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('one explicit click returns all four labelled types and each fills once without sending', async () => {
  const h = harness();
  try {
    h.start(); await until(() => h.shadow()?.querySelector('.generate'));
    assert.equal(h.calls.length, 0); assert.equal(h.shadow().querySelectorAll('.choice').length, 0);
    await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.deepEqual([...h.shadow().querySelectorAll('.tag')].map(n => n.textContent), ['认可并展开', '幽默接梗', '补充观点', '换个角度']);
    for (let i = 0; i < 4; i++) { h.shadow().querySelectorAll('.choice')[i].click(); await until(() => h.editor().textContent === candidates[i].text && !h.shadow().querySelector('.choice').disabled); }
    assert.equal(h.pastes.length, 4); assert.equal(h.calls.filter(m => m.type === 'inlineGenerate').length, 1); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('legacy interpretation metadata never restores removed analysis and correction controls', async () => {
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? {ok: true, job: {id: 'metadata-job', status: 'completed', candidates, understanding: {...understanding, evidence: ['<img src=x onerror=alert(1)>']}}} : undefined});
  try {
    const draft = '保留我的回复。'; h.editor().textContent = draft;
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('.understanding, .meaning, .context, .correct-understanding, img'), null);
    assert.equal(h.host().querySelector('textarea'), null); assert.equal(h.editor().textContent, draft);
    assert.equal(h.calls.filter(m => m.type === 'inlineGenerate').length, 1); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('compact missing context shows the actual gap with no correction form or automatic regeneration', async () => {
  const gap = '缺少视频对白，无法可靠生成回复。';
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? {ok: true, job: {id: 'missing-job', status: 'completed', candidates: [], contextStatus: 'missing', missingContext: gap}} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelector('.status').textContent.includes(gap));
    assert.equal(h.shadow().querySelectorAll('.choice').length, 0); assert.equal(h.shadow().querySelector('details, textarea'), null); assert.equal(h.host().querySelector('textarea'), null);
    await delay(150); assert.equal(h.calls.filter(m => m.type === 'inlineGenerate').length, 1); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('inline selection and copy never create implicit feedback or extra form fields', async () => {
  const h = harness({modalFocusTrap: true});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('.feedback, .save-feedback, textarea'), null); assert.equal(h.host().querySelector('textarea'), null);
    h.shadow().querySelector('.copy').click(); await until(() => h.copies.length === 1);
    h.shadow().querySelector('.choice').click(); await until(() => h.editor().textContent === candidates[0].text);
    assert.equal(h.calls.some(m => m.type === 'inlineFeedback'), false); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('regenerating requests all four types again only on an explicit next click', async () => {
  const h = harness();
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('.generate').textContent, '换一组');
    h.w.dispatchEvent(new h.w.Event('focus')); await delay(150); assert.equal(h.calls.filter(m => m.type === 'inlineGenerate').length, 1);
    await clickGenerate(h); await until(() => h.calls.filter(m => m.type === 'inlineGenerate').length === 2);
    assert.ok(h.calls.filter(m => m.type === 'inlineGenerate').every(m => m.style === 'all' && !Object.hasOwn(m, 'preferences'))); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('simplified panel adds no focus-trapped inputs and native editor remains editable', async () => {
  const h = harness({modalFocusTrap: true});
  try {
    const draft = '原来的手动回复保留。'; h.editor().textContent = draft;
    h.start(); await until(() => h.host()); const host = h.host();
    assert.equal(host.querySelector('textarea, input'), null); assert.equal(h.shadow().querySelector('textarea, input'), null);
    h.editor().focus(); assert.equal(h.w.document.activeElement, h.editor());
    const key = new h.w.KeyboardEvent('keydown', {key: 'Backspace', bubbles: true, cancelable: true}); assert.equal(h.editor().dispatchEvent(key), true);
    await delay(150); assert.equal(h.host(), host); assert.equal(h.editor().textContent, draft); assert.equal(h.calls.length, 0); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('collapse and busy transitions never add native form inputs or start extra jobs', async () => {
  let finishInit; const h = harness({intercept: m => m.type === 'inlineInit' ? new Promise(resolve => {finishInit = resolve;}) : undefined});
  try {
    h.start(); await until(() => h.host()); const shadow = h.shadow();
    shadow.querySelector('.head .link').click(); assert.equal(shadow.querySelector('.body').hidden, true);
    shadow.querySelector('.head .link').click(); assert.equal(shadow.querySelector('.body').hidden, false); assert.equal(h.calls.length, 0);
    await clickGenerate(h); await until(() => finishInit); assert.equal(shadow.querySelector('.generate').disabled, true);
    assert.equal(h.host().querySelector('textarea, input'), null);
    finishInit({ok: true, sessionId: 'collapsed-session', paired: true}); await until(() => shadow.querySelectorAll('.choice').length === 4);
    assert.equal(shadow.querySelector('.generate').disabled, false); assert.equal(h.calls.filter(m => m.type === 'inlineGenerate').length, 1); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('duplicate generation clicks start one all-types request and never upload a native draft', async () => {
  let finishInit; const h = harness({intercept: m => m.type === 'inlineInit' ? new Promise(resolve => {finishInit = resolve;}) : undefined});
  try {
    h.editor().textContent = '绝不上传的手动草稿'; h.start(); await until(() => h.shadow()?.querySelector('.generate'));
    const generate = h.shadow().querySelector('.generate'); generate.click(); generate.dispatchEvent(new h.w.MouseEvent('click', {bubbles: true}));
    await until(() => finishInit); assert.equal(h.calls.filter(m => m.type === 'inlineInit').length, 1); assert.equal(generate.disabled, true);
    finishInit({ok: true, sessionId: 'duplicate-session', paired: true}); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.filter(m => m.type === 'inlineGenerate').length, 1); assert.equal(h.calls.find(m => m.type === 'inlineGenerate').style, 'all');
    assert.equal(JSON.stringify(h.calls).includes('绝不上传的手动草稿'), false); assert.equal(h.editor().textContent, '绝不上传的手动草稿');
  } finally { h.dispose(); }
});

test('retry uses the same original and all types only after an explicit retry click', async () => {
  let attempts = 0; const h = harness({intercept: m => m.type === 'inlineGenerate' && ++attempts === 1 ? {ok:false, code:'BRIDGE_TIMEOUT', error:'请求超时，请重试。'} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => !h.shadow().querySelector('.actions .primary').hidden);
    h.w.dispatchEvent(new h.w.Event('focus')); await delay(100); assert.equal(attempts, 1);
    h.shadow().querySelector('.actions .primary').click(); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.ok(h.calls.filter(m => m.type === 'inlineGenerate').every(m => m.style === 'all')); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('media source changes close old choices while image resolution changes retain the session', async () => {
  let url = 'https://pbs.twimg.com/media/original?format=jpg&name=small'; let capturedAt = 1;
  const h = harness({decorateContext: context => ({...context, hasMedia: true, media: [{kind: 'image', url, alt: '原图描述', capturedAt}]})});
  try {
    h.start(); await until(() => h.shadow()?.querySelector('.generate'));
    assert.ok(h.shadow().querySelector('.status').textContent.includes('点击后一次生成'));
    assert.deepEqual(h.calls, []);
    await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    const host = h.host(); capturedAt++;
    h.w.dispatchEvent(new h.w.Event('focus')); await delay(100);
    assert.equal(h.host(), host);
    url = 'https://pbs.twimg.com/media/original?name=large&format=jpg';
    h.w.dispatchEvent(new h.w.Event('focus')); await delay(100);
    assert.equal(h.host(), host);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    url = 'https://pbs.twimg.com/media/changed.jpg';
    h.shadow().querySelector('.choice').click();
    assert.equal(h.pastes.length, 0);
    h.w.dispatchEvent(new h.w.Event('focus')); await until(() => h.host() !== host);
    await delay(150);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.shadow().querySelectorAll('.choice').length, 0);
    assert.equal(h.editor().textContent, '');
    await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit')[1].context.media[0].url, url);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('media attribute changes rescan the source without focus while unrelated styles keep the mounted host', async () => {
  const h = harness({decorateContext: context => {
    const image = h.w.document.querySelector('[role=dialog] article img[data-fixture="changing-media"]');
    return image ? {...context, hasMedia: true, media: [{kind: 'image', url: image.src, alt: image.alt}]} : context;
  }});
  try {
    const image = h.w.document.createElement('img'); image.dataset.fixture = 'changing-media'; image.src = 'https://pbs.twimg.com/media/before.jpg'; image.alt = '画面一';
    h.editor().closest('[role=dialog]').querySelector('article').append(image);
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    const host = h.host(); const reads = h.contextReads();
    image.style.opacity = '.9'; await delay(160);
    assert.equal(h.host(), host); assert.equal(h.contextReads(), reads);
    image.src = 'https://pbs.twimg.com/media/after.jpg';
    await until(() => h.host() !== host); await delay(100);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.shadow().querySelectorAll('.choice').length, 0);
    const nextHost = h.host(); image.alt = '更新后的画面描述';
    await until(() => h.host() !== nextHost);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('completed choices keep the simple UI without claiming unseen video content', async () => {
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? {ok: true, job: {id: 'media-evidence-job', status: 'completed', candidates, mediaEvidence: {images: 2, videoPosters: 1, limitations: ['视频仅读取封面，未读取连续画面、台词或声音。']}}} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    const status = h.shadow().querySelector('.status').textContent;
    assert.ok(status.includes('四条候选已生成'));
    assert.equal(status.includes('已看完视频'), false);
    assert.equal(h.shadow().querySelector('.understanding, .context, textarea'), null);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

function addPictureURLSpans(w, article, count) {
  // Models X's public text/media markup, without loading or inspecting image pixels.
  const text = article.querySelector('[data-testid=tweetText]');
  if (!article.querySelector('[data-testid=tweetPhoto]')) {
    const photo = w.document.createElement('div'); photo.dataset.testid = 'tweetPhoto'; article.append(photo);
  }
  for (let i = 0; i < count; i++) {
    const prefix = w.document.createElement('span'); prefix.textContent = 'https://';
    const link = w.document.createElement('a'); link.href = 'https://pic.x.com/ob98q44ikg'; link.textContent = 'pic.x.com/ob98q44ikg';
    text.append(w.document.createTextNode('\n'), prefix, w.document.createTextNode('\n'), link);
  }
}

function installObservedDetailComposer(h, {avatarMarker = true} = {}) {
  const doc = h.w.document;
  const article = doc.querySelector('main article').cloneNode(true);
  const make = (tag, fixtureName, direction) => {
    const node = doc.createElement(tag); node.dataset.fixture = fixtureName;
    if (direction) node.style.cssText = `display:flex;flex-direction:${direction}`;
    return node;
  };
  const main = doc.createElement('main');
  const replyColumn = make('div', 'detail-reply-column', 'column');
  const avatarRow = make('div', 'detail-avatar-row', 'row');
  const avatar = make('span', 'detail-avatar', 'column'); avatar.textContent = '头像'; avatar.style.flex = '0 0 40px'; avatar.style.justifyContent = 'center';
  if (avatarMarker) avatar.dataset.testid = 'UserAvatar-Container-fixture';
  const completeColumn = make('div', 'detail-complete-column', 'column'); completeColumn.style.minWidth = '0'; completeColumn.style.flex = '1';
  completeColumn.style.justifyContent = 'center';
  const fullRow = make('div', 'detail-complete-action-row', 'row');
  const label = make('div', 'detail-label', 'row'); label.dataset.testid = 'tweetTextarea_0_label';
  const placeholder = doc.createElement('div'); placeholder.className = 'public-DraftEditorPlaceholder-inner'; placeholder.textContent = '发布你的回复';
  const editor = doc.createElement('div'); editor.dataset.testid = 'tweetTextarea_0'; editor.setAttribute('contenteditable', 'true'); editor.setAttribute('role', 'textbox');
  label.append(placeholder, editor);
  const inputRow = make('div', 'detail-inner-input-row', 'row'); inputRow.append(label);
  const narrowColumn = make('div', 'detail-narrow-input-column', 'column'); narrowColumn.append(inputRow);
  let wrapped = narrowColumn;
  for (let i = 0; i < 5; i++) {
    const wrapper = make('div', `detail-input-wrapper-${i}`, 'column'); wrapper.append(wrapped); wrapped = wrapper;
  }
  const actions = make('div', 'detail-send-actions', 'row');
  const foreignAI = doc.createElement('button'); foreignAI.setAttribute('role', 'button'); foreignAI.textContent = 'AI Generate';
  const send = doc.createElement('button'); send.dataset.testid = 'tweetButtonInline'; send.textContent = '回复';
  actions.append(foreignAI, send); fullRow.append(wrapped, actions); completeColumn.append(fullRow); avatarRow.append(avatar, completeColumn); replyColumn.append(avatarRow); main.append(article, replyColumn);
  doc.body.replaceChildren(main);
  h.w.history.replaceState({}, '', '/demo_writer/status/1234567890123456789');
  return {main, replyColumn, avatarRow, avatar, completeColumn, fullRow, narrowColumn, inputRow, label, editor, actions, foreignAI, send};
}

test('observed X modal without permalink resolves its exact original and shows four Chinese choices only after explicit generation', async () => {
  const h = harness();
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const init = h.calls.find(call => call.type === 'inlineInit');
    assert.equal(init.context.id, '1234567890123456789');
    assert.equal(init.context.author, '@demo_writer');
    assert.ok(init.context.text.includes('明确标题和来源'));
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.editor().textContent, '');
    assert.equal(h.sent(), 0);
    h.shadow().querySelector('.choice').click();
    await until(() => h.editor().textContent === candidates[0].text);
    assert.equal(h.pastes.length, 1);
    assert.equal(h.pastes[0].text, candidates[0].text);
    assert.equal(h.pastes[0].leafRange, true);
    assert.equal(h.pastes[0].collapsed, true);
    assert.equal(h.pastes[0].startNode.nodeName, 'SPAN');
    assert.equal(h.pastes[0].startOffset, 0);
    assert.equal(h.pastes[0].endOffset, 0);
    assert.equal(h.inputs.length, 1);
    assert.equal(h.inputs[0].target, h.editor());
    assert.equal(h.sent(), 0);
    assert.equal(h.shadow().querySelectorAll('input[type=password]').length, 0);
  } finally { h.dispose(); }
});

test('user-written draft survives selection until replace or append is chosen', async () => {
  const h = harness();
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    h.editor().textContent = '这是我自己写的回复';
    h.shadow().querySelector('.choice').click();
    assert.equal(h.editor().textContent, '这是我自己写的回复');
    assert.equal(h.shadow().querySelector('.replace').hidden, false);
    const append = [...h.shadow().querySelectorAll('.replace button')].find(button => button.textContent === '接在后面'); append.click();
    await until(() => h.editor().textContent === `这是我自己写的回复\n${candidates[0].text}`);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('one connection click generates inside the same composer without setup tabs or pairing inputs', async () => {
  let connected = false;
  const h = harness({paired: false, intercept: message => message.type === 'inlineHealth' ? {ok: true, paired: connected} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.actions .primary')?.hidden === false);
    assert.equal(h.calls.some(call => call.type === 'inlineGenerate'), false);
    assert.equal(h.w.document.querySelector('input[type=password]'), null);
    assert.equal(h.shadow().querySelector('input[type=password]'), null);
    assert.equal(h.shadow().querySelector('.actions .secondary').hidden, true);
    connected = true;
    h.shadow().querySelector('.actions .primary').click();
    await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.some(call => call.type === 'inlineOpenSetup'), false);
    assert.equal(h.calls.some(call => call.type === 'inlinePair'), false);
    assert.equal(h.calls.some(call => call.type === 'saveSettings'), false);
    assert.equal(h.calls.filter(call => call.type === 'inlineHealth').length, 1);
    assert.equal(h.shadow().querySelector('a[href*="/connect"]'), null);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('closing a composer while generation starts cancels its session and ignores late completion', async () => {
  let finish;
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? new Promise(resolve => { finish = resolve; }) : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => Boolean(finish));
    const oldEditor = h.editor(); oldEditor.closest('[role=dialog]').remove();
    await until(() => h.calls.some(call => call.type === 'inlineClose'));
    finish({ok: true, job: {id: 'late-job', status: 'completed', candidates}});
    await delay(80);
    assert.equal(h.host(), null); assert.equal(oldEditor.textContent, ''); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('same editor reused for a different original replaces the old candidate session', async () => {
  const h = harness();
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const oldHost = h.host();
    const modal = h.editor().closest('[role=dialog]');
    modal.querySelector('[data-testid=tweetText]').textContent = '另一条不同的正文，需要不同的回复。';
    const original = h.w.document.querySelector('main article');
    original.querySelector('[data-testid=tweetText]').textContent = '另一条不同的正文，需要不同的回复。';
    original.querySelector('a[href="/demo_writer/status/1234567890123456789"]').href = 'https://x.com/demo_writer/status/1234567890123456790';
    await until(() => h.host() !== oldHost);
    await delay(150);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.shadow().querySelectorAll('.choice').length, 0);
    await clickGenerate(h);
    await until(() => h.calls.filter(call => call.type === 'inlineInit').length === 2);
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(oldHost.isConnected, false);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit')[1].context.id, '1234567890123456790');
    assert.ok(h.calls.some(call => call.type === 'inlineClose' && call.sessionId.endsWith('6789')));
    assert.equal(h.editor().textContent, ''); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('a generic new-post editor does not generate or install reply options', async () => {
  const h = harness();
  try {
    const modal = h.editor().closest('[role=dialog]'); modal.querySelector('article').remove();
    [...modal.querySelectorAll('[role=button]')].filter(button => button.textContent.startsWith('回复 @')).forEach(button => button.remove());
    modal.querySelector('.public-DraftEditorPlaceholder-inner').textContent = '有什么新鲜事？';
    h.start(); await delay(180);
    assert.equal(h.host(), null); assert.equal(h.calls.length, 0);
  } finally { h.dispose(); }
});

test('late-hydrated original is recognized without choosing the first timeline tweet', async () => {
  const h = harness();
  try {
    const modal = h.editor().closest('[role=dialog]'); const article = modal.querySelector('article'); article.remove();
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.status.error'));
    assert.equal(h.calls.some(call => call.type === 'inlineInit'), false);
    const oldHost = h.host();
    modal.prepend(article);
    await until(() => h.host() !== oldHost);
    assert.equal(h.calls.some(call => call.type === 'inlineInit'), false);
    await clickGenerate(h);
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.find(call => call.type === 'inlineInit').context.id, '1234567890123456789');
  } finally { h.dispose(); }
});

test('candidate HTML remains literal text and copy does not change the reply draft', async () => {
  const unsafe = candidates.map(candidate => ({...candidate, text: '<img src=x onerror=alert(1)>中文候选'}));
  const h = harness({intercept: message => message.type === 'inlineGenerate' ? {ok: true, job: {id: 'safe-literal', status: 'completed', candidates: unsafe}} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.shadow().querySelector('img'), null);
    assert.ok(h.shadow().querySelector('.choice-text').textContent.includes('<img'));
    h.shadow().querySelector('.copy').click(); await until(() => h.copies.length === 1);
    assert.equal(h.copies[0], unsafe[0].text); assert.equal(h.editor().textContent, ''); assert.equal(h.pastes.length, 0); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('an unhandled editor paste preserves the draft and leaves copy as an explicit user action', async () => {
  const h = harness({pasteMode: 'unhandled'});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const ownDraft = '这段手写内容不能被删掉。'; h.editor().textContent = ownDraft;
    h.shadow().querySelector('.choice').click();
    [...h.shadow().querySelectorAll('.replace button')].find(button => button.textContent === '替换原文字').click();
    await until(() => h.shadow().querySelector('.status.error'), 3000);
    assert.equal(h.editor().textContent, ownDraft);
    assert.equal(h.pastes.length, 1);
    assert.equal(h.copies.length, 0);
    assert.ok(h.shadow().querySelector('.status').textContent.includes('复制'));
    assert.equal(h.shadow().querySelectorAll('.choice').length, 4);
    h.shadow().querySelector('.copy').click(); await until(() => h.copies.length === 1);
    assert.equal(h.copies[0], candidates[0].text);
    assert.equal(h.editor().textContent, ownDraft);
    assert.equal(h.pastes.length, 1);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('rapid repeated candidate clicks create one paste transaction and one complete draft', async () => {
  const h = harness({pasteDelay: 80});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const choice = h.shadow().querySelector('.choice');
    choice.click(); choice.click();
    assert.equal(choice.disabled, true);
    await until(() => h.pastes.length === 1);
    // A programmatic click still reaches the controller if a caller bypasses
    // disabled UI, so its insertion lock must protect the same transaction.
    choice.dispatchEvent(new h.w.MouseEvent('click', {bubbles: true}));
    await until(() => h.editor().textContent === candidates[0].text);
    await until(() => h.shadow().querySelector('.status').textContent.includes('已填入'), 3000);
    assert.equal(h.pastes.length, 1);
    assert.equal(h.inputs.length, 1);
    assert.equal(h.editor().textContent, candidates[0].text);
    assert.equal(h.shadow().querySelector('.choice').disabled, false);
    assert.equal(h.copies.length, 0);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('append pastes only the new candidate at the draft end and preserves user whitespace', async () => {
  const h = harness();
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const ownDraft = '  我写的开头\n还保留结尾空格  ';
    h.editor().textContent = ownDraft;
    h.shadow().querySelector('.choice').click();
    [...h.shadow().querySelectorAll('.replace button')].find(button => button.textContent === '接在后面').click();
    const expected = `${ownDraft}\n${candidates[0].text}`;
    await until(() => h.editor().textContent === expected);
    await until(() => h.shadow().querySelector('.status').textContent.includes('已填入'), 3000);
    assert.equal(h.pastes.length, 1);
    assert.equal(h.pastes[0].text, `\n${candidates[0].text}`);
    assert.equal(h.pastes[0].previous, ownDraft);
    assert.equal(h.pastes[0].start, ownDraft.length);
    assert.equal(h.pastes[0].end, ownDraft.length);
    assert.equal(h.pastes[0].leafRange, true);
    const selection = h.w.document.getSelection();
    assert.equal(selection.isCollapsed, true);
    assert.equal(selection.anchorNode.nodeType, h.w.Node.TEXT_NODE);
    assert.equal(selection.anchorNode.textContent, expected);
    assert.equal(selection.anchorOffset, expected.length);
    assert.equal(h.copies.length, 0);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('replacement replaces one Draft selection and later editing keeps the caret at the edited end', async () => {
  const h = harness();
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const ownDraft = '这是原来需要替换的草稿'; h.editor().textContent = ownDraft;
    h.shadow().querySelector('.choice').click();
    [...h.shadow().querySelectorAll('.replace button')].find(button => button.textContent === '替换原文字').click();
    await until(() => h.editor().textContent === candidates[0].text);
    await until(() => h.shadow().querySelector('.status').textContent.includes('已填入'), 3000);
    assert.equal(h.pastes[0].start, 0);
    assert.equal(h.pastes[0].end, ownDraft.length);
    assert.equal(h.pastes[0].text, candidates[0].text);
    const selection = h.w.document.getSelection();
    assert.equal(selection.anchorOffset, candidates[0].text.length);
    const leaf = selection.anchorNode; const edited = leaf.textContent.slice(0, -2);
    leaf.textContent = edited;
    const range = h.w.document.createRange(); range.setStart(leaf, edited.length); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    h.editor().dispatchEvent(new h.w.InputEvent('input', {bubbles: true, inputType: 'deleteContentBackward'}));
    h.w.document.dispatchEvent(new h.w.Event('selectionchange'));
    await delay(220);
    assert.equal(h.editor().textContent, edited);
    assert.equal(selection.anchorNode, leaf);
    assert.equal(selection.anchorOffset, edited.length);
    assert.equal(h.pastes.length, 1);
    assert.equal(h.copies.length, 0);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('a partially handled paste keeps candidates but never auto-copies or suggests another paste', async () => {
  const h = harness({pasteMode: 'partial'});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    h.shadow().querySelector('.choice').click();
    await until(() => h.shadow().querySelector('.status.error'), 3000);
    assert.equal(h.editor().textContent, candidates[0].text.slice(0, Math.ceil(candidates[0].text.length / 2)));
    assert.equal(h.pastes.length, 1);
    assert.equal(h.copies.length, 0);
    assert.equal(h.shadow().querySelectorAll('.choice').length, 4);
    assert.equal(h.shadow().querySelector('.status').textContent.includes('粘贴'), false);
    assert.equal(h.shadow().querySelector('.status').textContent.includes('复制'), false);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('a handled paste without a committed result reports uncertainty without proposing a duplicate paste', async () => {
  const h = harness({pasteMode: 'pending'});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    h.shadow().querySelector('.choice').click();
    await until(() => h.shadow().querySelector('.status.error'), 3000);
    const message = h.shadow().querySelector('.status').textContent;
    assert.equal(h.editor().textContent, '');
    assert.equal(h.pastes.length, 1);
    assert.equal(h.copies.length, 0);
    assert.equal(h.inputs.length, 0);
    assert.ok(message.includes('尚未确认'));
    assert.equal(message.includes('复制'), false);
    assert.equal(message.includes('粘贴'), false);
    assert.equal(h.shadow().querySelectorAll('.choice').length, 4);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('inserting from an existing error state locks retry and ignores bypassed recovery actions', async () => {
  let behavior = 'unhandled';
  const h = harness({pasteMode: () => behavior, pasteDelay: 80});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    h.shadow().querySelector('.choice').click();
    await until(() => h.shadow().querySelector('.status.error'), 3000);
    const retry = h.shadow().querySelector('.actions .secondary');
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, false);
    const callsBeforeInsert = h.calls.length;
    behavior = 'handled';
    h.shadow().querySelectorAll('.choice')[1].click();
    assert.equal(retry.disabled, true);
    // Dispatch bypasses a button's disabled native click suppression, allowing
    // us to check that controller guards independently protect the transaction.
    for (const button of [retry, h.shadow().querySelector('.copy'), h.shadow().querySelector('.generate')]) button.dispatchEvent(new h.w.MouseEvent('click', {bubbles: true}));
    await until(() => h.editor().textContent === candidates[1].text);
    await until(() => h.shadow().querySelector('.status').textContent.includes('已填入'), 3000);
    assert.equal(h.calls.length, callsBeforeInsert);
    assert.equal(h.pastes.length, 2);
    assert.equal(h.pastes[1].text, candidates[1].text);
    assert.equal(h.inputs.length, 1);
    assert.equal(h.copies.length, 0);
    assert.equal(h.shadow().querySelector('.choice').disabled, false);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('temporary result lookup failures recover the same task without generating or changing the draft', async () => {
  let polls = 0;
  const h = harness({fastPolling: true, intercept: message => {
    if (message.type === 'inlineGenerate') return {ok: true, job: {id: 'one-owned-task', status: 'running'}};
    if (message.type === 'inlinePoll') {
      polls++;
      return polls < 3 ? {ok: false, code: polls === 1 ? 'BRIDGE_UNAVAILABLE' : 'BRIDGE_TIMEOUT', error: '短暂连接中断。'}
        : {ok: true, job: {id: 'one-owned-task', status: 'completed', candidates: naturalCandidates}};
    }
  }});
  try {
    const ownDraft = '我自己的未发送草稿。'; h.editor().textContent = ownDraft;
    h.start(); await delay(120); assert.deepEqual(h.calls, []);
    await clickGenerate(h);
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 2);
    assert.deepEqual(h.pollWaits, [1200, 1000, 2000]);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    const lookups = h.calls.filter(call => call.type === 'inlinePoll');
    assert.equal(lookups.length, 3); assert.ok(lookups.every(call => call.id === 'one-owned-task' && call.sessionId === lookups[0].sessionId));
    assert.equal(h.editor().textContent, ownDraft); assert.equal(JSON.stringify(h.calls).includes(ownDraft), false);
    assert.equal(h.pastes.length, 0); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('exhausted lookup recovery stops after three waits and Continue only looks up the existing job', async () => {
  let online = false;
  const h = harness({fastPolling: true, intercept: message => {
    if (message.type === 'inlineGenerate') return {ok: true, job: {id: 'exhausted-owned-task', status: 'running'}};
    if (message.type === 'inlinePoll') return online ? {ok: true, job: {id: 'exhausted-owned-task', status: 'completed', candidates: naturalCandidates}}
      : {ok: false, code: 'BRIDGE_UNAVAILABLE', error: '暂时离线。'};
  }});
  try {
    const ownDraft = '保留这段未发送内容。'; h.editor().textContent = ownDraft;
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.status.error'));
    assert.deepEqual(h.pollWaits, [1200, 1000, 2000, 3000]);
    assert.equal(h.calls.filter(call => call.type === 'inlinePoll').length, 4);
    const retry = h.shadow().querySelector('.actions .secondary');
    assert.equal(retry.hidden, false); assert.equal(retry.textContent, '继续查看'); assert.equal(retry.disabled, false);
    await delay(200); assert.equal(h.calls.filter(call => call.type === 'inlinePoll').length, 4);
    h.shadow().querySelector('.head .link').click();
    h.shadow().querySelector('.head .link').click();
    online = true; retry.click(); await until(() => h.shadow()?.querySelectorAll('.choice').length === 2);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineHealth').length, 0);
    assert.ok(h.calls.filter(call => call.type === 'inlinePoll').every(call => call.id === 'exhausted-owned-task'));
    assert.equal(h.editor().textContent, ownDraft); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('a successful running lookup resets the recovery budget for later temporary failures', async () => {
  let polls = 0;
  const h = harness({fastPolling: true, intercept: message => {
    if (message.type === 'inlineGenerate') return {ok: true, job: {id: 'reset-owned-task', status: 'running'}};
    if (message.type === 'inlinePoll') {
      polls++;
      if (polls === 2) return {ok: true, job: {id: 'reset-owned-task', status: 'running'}};
      if (polls === 6) return {ok: true, job: {id: 'reset-owned-task', status: 'completed', candidates: naturalCandidates}};
      return {ok: false, code: 'BRIDGE_TIMEOUT', error: '短暂超时。'};
    }
  }});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 2);
    assert.deepEqual(h.pollWaits, [1200, 1000, 1200, 1000, 2000, 3000]);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1); assert.equal(polls, 6); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('closing or changing the source during recovery removes the lookup timer and never starts a new job', async t => {
  for (const action of ['close', 'change-source']) await t.test(action, async () => {
    let changedSource = false;
    const h = harness({fastPolling: true,
      decorateContext: context => changedSource ? {...context, text: '新的原帖，需要独立确认。'} : context,
      intercept: message => {
        if (message.type === 'inlineGenerate') return {ok: true, job: {id: 'closed-owned-task', status: 'running'}};
        if (message.type === 'inlinePoll') return {ok: false, code: 'BRIDGE_UNAVAILABLE', error: '短暂离线。'};
      }
    });
    try {
      const ownDraft = '不要修改这段草稿。'; h.editor().textContent = ownDraft;
      h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.status').textContent.includes('恢复查看'));
      const oldEditor = h.editor(), oldHost = h.host(), lookupsBefore = h.calls.filter(call => call.type === 'inlinePoll').length;
      if (action === 'close') oldEditor.closest('[role=dialog]').remove();
      else changedSource = true;
      // A focus scan observes closure/source change immediately, before backoff.
      h.w.dispatchEvent(new h.w.Event('focus'));
      await until(() => h.calls.some(call => call.type === 'inlineClose'));
      await delay(250);
      assert.equal(oldHost.isConnected, false);
      assert.equal(h.calls.filter(call => call.type === 'inlinePoll').length, lookupsBefore);
      assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
      assert.equal(oldEditor.textContent, ownDraft); assert.equal(h.sent(), 0);
      if (action === 'change-source') assert.equal(h.shadow().querySelectorAll('.choice').length, 0);
    } finally { h.dispose(); }
  });
});

test('cancel during recovery clears the timer and a late lookup cannot resume the cancelled task', async t => {
  for (const pendingLookup of [false, true]) await t.test(pendingLookup ? 'pending-lookup' : 'backoff', async () => {
    let finishLookup;
    const h = harness({fastPolling: true, intercept: message => {
      if (message.type === 'inlineGenerate') return {ok: true, job: {id: 'cancel-owned-task', status: 'running'}};
      if (message.type === 'inlinePoll') {
        if (pendingLookup) return new Promise(resolve => { finishLookup = resolve; });
        return {ok: false, code: 'BRIDGE_TIMEOUT', error: '短暂超时。'};
      }
    }});
    try {
      const ownDraft = '停止后也保留我的文字。'; h.editor().textContent = ownDraft;
      h.start(); await clickGenerate(h);
      await until(() => pendingLookup ? Boolean(finishLookup) : h.shadow()?.querySelector('.status').textContent.includes('恢复查看'));
      const lookupsBefore = h.calls.filter(call => call.type === 'inlinePoll').length;
      h.shadow().querySelector('.actions .link').click();
      await until(() => h.shadow()?.querySelector('.status').textContent.includes('已停止'));
      if (finishLookup) finishLookup({ok: true, job: {id: 'cancel-owned-task', status: 'running'}});
      await delay(250);
      assert.equal(h.calls.filter(call => call.type === 'inlineCancel').length, 1);
      assert.equal(h.calls.find(call => call.type === 'inlineCancel').id, 'cancel-owned-task');
      assert.equal(h.calls.filter(call => call.type === 'inlinePoll').length, lookupsBefore);
      assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
      assert.ok(h.shadow().querySelector('.status').textContent.includes('已停止'));
      assert.equal(h.editor().textContent, ownDraft); assert.equal(h.sent(), 0);
    } finally { h.dispose(); }
  });
});

test('authentication, missing tasks, extension reload and source errors never receive network lookup retries', async t => {
  for (const code of ['PAIRING_EXPIRED', 'JOB_NOT_FOUND', 'JOB_EXPIRED', 'EXTENSION_RELOADED', 'SOURCE_CHANGED']) await t.test(code, async () => {
    const h = harness({fastPolling: true, intercept: message => {
      if (message.type === 'inlineGenerate') return {ok: true, job: {id: 'terminal-owned-task', status: 'running'}};
      if (message.type === 'inlinePoll') return {ok: false, code, error: '需要用户处理。'};
    }});
    try {
      h.start(); await clickGenerate(h); await until(() => h.calls.some(call => call.type === 'inlinePoll'));
      await delay(300);
      assert.equal(h.calls.filter(call => call.type === 'inlinePoll').length, 1);
      assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
      assert.deepEqual(h.pollWaits, [1200]); assert.equal(h.sent(), 0);
    } finally { h.dispose(); }
  });
});

test('a protocol update requires reload without lookup retries, repeat generation or losing the draft', async t => {
  for (const failureAt of ['generate', 'poll', 'failed-job']) await t.test(failureAt, async () => {
    const error = {ok: false, code: 'EXTENSION_UPDATE_REQUIRED', error: '请重新加载接一句，再刷新 X。'};
    const h = harness({fastPolling: true, intercept: message => {
      if (message.type === 'inlineGenerate') {
        if (failureAt === 'generate') return error;
        if (failureAt === 'failed-job') return {ok: true, job: {id: 'update-owned-job', status: 'failed', code: error.code, error: error.error}};
        return {ok: true, job: {id: 'update-owned-job', status: 'running'}};
      }
      if (message.type === 'inlinePoll') return error;
    }});
    try {
      const ownDraft = '先保留我写好的内容。'; h.editor().textContent = ownDraft;
      h.start(); await clickGenerate(h);
      await until(() => h.shadow()?.querySelector('.status').textContent.includes('重新加载'));
      const requests = h.calls.filter(call => ['inlineGenerate', 'inlinePoll'].includes(call.type)).length;
      assert.equal(h.shadow().querySelector('.actions .primary').hidden, true);
      h.shadow().querySelector('.generate').click();
      h.shadow().querySelector('.actions .primary').click();
      await delay(250);
      assert.equal(h.calls.filter(call => ['inlineGenerate', 'inlinePoll'].includes(call.type)).length, requests);
      assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
      if (failureAt === 'poll') {
        h.shadow().querySelector('.actions .link').click();
        await until(() => h.shadow()?.querySelector('.status').textContent.includes('已停止'));
        assert.equal(h.calls.filter(call => call.type === 'inlineCancel').length, 1);
        assert.ok(h.shadow().querySelector('.status').textContent.includes('重新加载'));
      }
      assert.equal(h.editor().textContent, ownDraft); assert.equal(h.sent(), 0);
    } finally { h.dispose(); }
  });
});

test('an expired local connection resumes only on an explicit retry after focus remains idle', async () => {
  let generations = 0;
  const h = harness({intercept: message => {
    if (message.type === 'inlineGenerate') {
      generations++;
      return {ok: true, job: {id: `generation-${generations}`, status: generations === 1 ? 'running' : 'completed', candidates}};
    }
    if (message.type === 'inlinePoll') return {ok: false, code: 'PAIRING_EXPIRED', error: '配对已失效，请重新连接。'};
    if (message.type === 'inlineHealth') return {ok: true, paired: true};
  }});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.actions .primary')?.hidden === false, 3000);
    h.w.dispatchEvent(new h.w.Event('focus'));
    await delay(150);
    assert.equal(generations, 1);
    h.shadow().querySelector('.actions .primary').click();
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(generations, 2); assert.equal(h.calls.filter(call => call.type === 'inlinePoll').length, 1);
    assert.equal(h.calls.some(call => ['inlineOpenSetup', 'inlinePair', 'saveSettings'].includes(call.type)), false);
  } finally { h.dispose(); }
});

test('expired document session is initialized again on the first retry', async () => {
  let generations = 0;
  const h = harness({intercept: message => {
    if (message.type === 'inlineGenerate') { generations++; return {ok: true, job: {id: `job-${generations}`, status: generations === 1 ? 'running' : 'completed', candidates}}; }
    if (message.type === 'inlinePoll') return {ok: false, code: 'INLINE_SESSION_EXPIRED', error: '回复窗口已变更。'};
  }});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.status.error'), 3000);
    h.shadow().querySelector('.actions .secondary').click();
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 2); assert.equal(generations, 2);
  } finally { h.dispose(); }
});

test('BFCache return restores observation and inline options without reexecuting scripts', async () => {
  const h = harness();
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide', {persisted: true}));
    assert.equal(h.host(), null);
    h.w.dispatchEvent(new h.w.PageTransitionEvent('pageshow', {persisted: true}));
    await until(() => h.host()); await delay(150);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.shadow().querySelectorAll('.choice').length, 0);
    await clickGenerate(h);
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 2);
    h.editor().closest('[role=dialog]').remove(); await until(() => h.host() === null);
  } finally { h.dispose(); }
});

test('detail-page comment editors never inherit the original post reply context', async () => {
  const h = harness();
  try {
    const article = h.w.document.querySelector('main article').outerHTML;
    h.w.document.body.innerHTML = `<main>${article}<div data-testid="tweetTextarea_0_label"><div class="public-DraftEditorPlaceholder-inner">发布你的回复</div><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div></div><section><button role="button">回复 @commenter</button><div data-testid="tweetTextarea_1_label"><div class="public-DraftEditorPlaceholder-inner">发布你的回复</div><div data-testid="tweetTextarea_1" contenteditable="true" role="textbox"></div></div></section></main>`;
    h.w.history.replaceState({}, '', '/demo_writer/status/1234567890123456789');
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.w.document.querySelectorAll('[data-jieyiju=reply-options]').length, 1);
    assert.equal(h.w.document.querySelector('section [data-jieyiju=reply-options]'), null);
    assert.equal(h.calls.find(call => call.type === 'inlineInit').context.id, '1234567890123456789');
  } finally { h.dispose(); }
});

test('nested horizontal reply rows keep the AI host below the complete input row', async () => {
  const h = harness({nestedFlex: true});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const column = h.w.document.querySelector('[data-fixture=composer-column]');
    const row = column.querySelector('[data-fixture=avatar-input-row]');
    const toolbar = column.querySelector('[data-fixture=composer-toolbar]');
    assert.equal(h.host().parentElement, column);
    assert.equal(row.nextElementSibling, h.host());
    assert.equal(h.host().nextElementSibling, toolbar);
    assert.equal(row.contains(h.host()), false);
    assert.equal(h.editor().closest('[data-fixture=avatar-input-row]'), row);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('a transient zero-width editor retains its host and session through unrelated DOM updates', async () => {
  let width = 600;
  const h = harness({nestedFlex: true, simulatedWidth: node => node.matches('[contenteditable=true]') ? width : 600});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const originalHost = h.host();
    width = 0;
    for (let i = 0; i < 3; i++) {
      const unrelated = h.w.document.createElement('span'); unrelated.textContent = `时间线更新${i}`; h.w.document.body.append(unrelated);
      await delay(150);
      assert.equal(h.host(), originalHost);
      assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
      assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 0);
    }
    width = 600;
    const modal = h.editor().closest('[role=dialog]');
    modal.querySelector('[data-testid=tweetText]').textContent = '恢复宽度后切换到另一条原帖。';
    const original = h.w.document.querySelector('main article');
    original.querySelector('[data-testid=tweetText]').textContent = '恢复宽度后切换到另一条原帖。';
    original.querySelector('a[href="/demo_writer/status/1234567890123456789"]').href = 'https://x.com/demo_writer/status/1234567890123456790';
    await until(() => h.host() !== originalHost);
    await delay(150);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    await clickGenerate(h);
    await until(() => h.calls.filter(call => call.type === 'inlineInit').length === 2);
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(originalHost.isConnected, false);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit')[1].context.id, '1234567890123456790');
    assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 1);
    modal.remove();
    await until(() => h.host() === null && h.calls.filter(call => call.type === 'inlineClose').length === 2);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('the AI host insertion and its own updates do not schedule another source scan', async () => {
  const h = harness({nestedFlex: true});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const originalHost = h.host(); const readsAfterMount = h.contextReads();
    const ownedChild = h.w.document.createElement('span'); ownedChild.textContent = '插件自己的轻量状态'; originalHost.append(ownedChild);
    h.shadow().querySelector('.status span:last-child').textContent = '候选仍已就绪';
    await delay(350);
    assert.equal(h.host(), originalHost);
    assert.equal(h.contextReads(), readsAfterMount);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 0);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('explicitly hidden composers still close their session after zero-width retention', async () => {
  let width = 600;
  const h = harness({nestedFlex: true, simulatedWidth: node => node.matches('[contenteditable=true]') ? width : 600});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    width = 0;
    const update = h.w.document.createElement('span'); h.w.document.body.append(update); await delay(150);
    assert.ok(h.host());
    h.editor().closest('[role=dialog]').hidden = true;
    await until(() => h.host() === null && h.calls.some(call => call.type === 'inlineClose'));
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('photo reply modal with duplicate picture URLs resolves its uniquely matching timeline source and generates', async () => {
  for (const count of [1, 2]) {
    const h = harness({nestedFlex: true});
    try {
      const original = h.w.document.querySelector('main article'); const body = original.querySelector('[data-testid=tweetText]').textContent;
      const modalArticle = h.editor().closest('[role=dialog]').querySelector('article');
      addPictureURLSpans(h.w, original, 0); addPictureURLSpans(h.w, modalArticle, count);
      h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
      const init = h.calls.find(call => call.type === 'inlineInit');
      assert.equal(init.context.id, '1234567890123456789');
      assert.equal(init.context.text, body);
      assert.equal(init.context.hasMedia, true);
      assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
      assert.equal(h.sent(), 0);
    } finally { h.dispose(); }
  }
});

test('a clicked photo original still resolves after the reply modal adds two picture URL spans', async () => {
  const h = harness({nestedFlex: true});
  try {
    const original = h.w.document.querySelector('main article'); const modal = h.editor().closest('[role=dialog]');
    const body = original.querySelector('[data-testid=tweetText]').textContent;
    addPictureURLSpans(h.w, original, 0); addPictureURLSpans(h.w, modal.querySelector('article'), 2);
    modal.remove(); h.start();
    original.querySelector('[data-testid=reply]').dispatchEvent(new h.w.Event('pointerdown', {bubbles: true}));
    // Remove the visible timeline source after the click: only the captured source
    // can identify this modal, so this is distinct from the timeline fallback test.
    original.remove(); h.w.document.body.append(modal);
    await clickGenerate(h);
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const init = h.calls.find(call => call.type === 'inlineInit');
    assert.equal(init.context.id, '1234567890123456789');
    assert.equal(init.context.text, body);
    assert.equal(init.context.hasMedia, true);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('late picture URL hydration preserves the same session and draft without a false source-change guard', async () => {
  const h = harness({nestedFlex: true});
  try {
    addPictureURLSpans(h.w, h.w.document.querySelector('main article'), 0);
    const modalArticle = h.editor().closest('[role=dialog]').querySelector('article');
    addPictureURLSpans(h.w, modalArticle, 0);
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const originalHost = h.host(); h.editor().textContent = '这是我先写下的回复';
    addPictureURLSpans(h.w, modalArticle, 2);
    await delay(180);
    assert.equal(h.host(), originalHost);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 0);
    assert.equal(h.editor().textContent, '这是我先写下的回复');
    h.shadow().querySelector('.choice').click();
    assert.equal(h.shadow().querySelector('.replace').hidden, false);
    assert.equal(h.shadow().querySelector('.status').classList.contains('error'), false);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('photo normalization never chooses one of two ambiguous same-author source IDs', async () => {
  const h = harness({nestedFlex: true});
  try {
    const original = h.w.document.querySelector('main article'); const second = original.cloneNode(true);
    second.querySelector('a[href="/demo_writer/status/1234567890123456789"]').href = 'https://x.com/demo_writer/status/1234567890123456790';
    original.after(second); addPictureURLSpans(h.w, original, 0); addPictureURLSpans(h.w, second, 1);
    addPictureURLSpans(h.w, h.editor().closest('[role=dialog]').querySelector('article'), 2);
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.status.error'));
    assert.equal(h.calls.some(call => call.type === 'inlineInit'), false);
    assert.equal(h.calls.some(call => call.type === 'inlineGenerate'), false);
    assert.equal(h.editor().textContent, '');
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('an externally removed panel is restored without restarting its live session', async () => {
  const h = harness({nestedFlex: true});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const originalHost = h.host();
    originalHost.remove();
    await until(() => h.host() === originalHost);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 0);
    assert.equal(h.shadow().querySelectorAll('.choice').length, 4);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('a refreshed reply modal generates from its own visible original when the timeline source disappeared', async () => {
  const h = harness({nestedFlex: true});
  try {
    const body = h.editor().closest('[role=dialog]').querySelector('[data-testid=tweetText]').textContent;
    h.w.document.querySelector('main article').remove();
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const init = h.calls.find(call => call.type === 'inlineInit');
    assert.equal(init.context.contextKind, 'composer-visible');
    assert.equal(init.context.id, null);
    assert.equal(init.context.url, null);
    assert.equal(init.context.author, '@demo_writer');
    assert.equal(init.context.text, body);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.shadow().querySelector('.status').classList.contains('error'), false);
    assert.equal(h.editor().textContent, '');
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('visible-original fallback never uploads an existing user-written reply draft', async () => {
  const h = harness({nestedFlex: true});
  try {
    h.w.document.querySelector('main article').remove();
    const ownDraft = '我手写的私密草稿，只应留在回复输入框里。';
    h.editor().textContent = ownDraft;
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.editor().textContent, ownDraft);
    assert.equal(JSON.stringify(h.calls).includes(ownDraft), false);
    assert.equal(h.calls.find(call => call.type === 'inlineInit').context.contextKind, 'composer-visible');
    h.shadow().querySelector('.choice').click();
    assert.equal(h.editor().textContent, ownDraft);
    assert.equal(h.shadow().querySelector('.replace').hidden, false);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('restored photo modal stays on one visible-original session as picture spans and unrelated DOM update', async () => {
  const h = harness({nestedFlex: true});
  try {
    h.w.document.querySelector('main article').remove();
    const article = h.editor().closest('[role=dialog]').querySelector('article');
    const body = article.querySelector('[data-testid=tweetText]').textContent;
    addPictureURLSpans(h.w, article, 1);
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const host = h.host();
    h.editor().textContent = '我已经写好开头了';
    addPictureURLSpans(h.w, article, 1);
    for (let i = 0; i < 3; i++) {
      const unrelated = h.w.document.createElement('span'); unrelated.textContent = `无关时间线变化${i}`; h.w.document.body.append(unrelated);
      await delay(150);
      assert.equal(h.host(), host);
    }
    assert.equal(h.calls.find(call => call.type === 'inlineInit').context.text, body);
    assert.equal(h.calls.find(call => call.type === 'inlineInit').context.contextKind, 'composer-visible');
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 0);
    assert.equal(h.editor().textContent, '我已经写好开头了');
    h.shadow().querySelector('.choice').click();
    assert.equal(h.shadow().querySelector('.replace').hidden, false);
    assert.equal(h.shadow().querySelector('.status').classList.contains('error'), false);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('same-text visible originals with null IDs still switch sessions when the reply author changes', async () => {
  let initializations = 0;
  const h = harness({nestedFlex: true, intercept: message => {
    if (message.type === 'inlineInit') return {ok: true, sessionId: `visible-${++initializations}`, paired: true};
  }});
  try {
    h.w.document.querySelector('main article').remove();
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const oldHost = h.host();
    const modal = h.editor().closest('[role=dialog]');
    const originalBody = modal.querySelector('[data-testid=tweetText]').textContent;
    modal.querySelector('[data-testid=User-Name]').textContent = '另一位作者\n@another_author\n·\n刚刚';
    [...modal.querySelectorAll('button,[role=button]')].find(button => button.textContent.startsWith('回复 @')).textContent = '回复 @another_author';
    await until(() => h.host() !== oldHost);
    await delay(150);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    await clickGenerate(h);
    await until(() => h.calls.filter(call => call.type === 'inlineInit').length === 2);
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const contexts = h.calls.filter(call => call.type === 'inlineInit').map(call => call.context);
    assert.equal(contexts[0].id, null);
    assert.equal(contexts[1].id, null);
    assert.equal(contexts[1].url, null);
    assert.equal(contexts[0].text, originalBody);
    assert.equal(contexts[1].text, originalBody);
    assert.equal(contexts[0].author, '@demo_writer');
    assert.equal(contexts[1].author, '@another_author');
    assert.equal(contexts[1].contextKind, 'composer-visible');
    assert.equal(oldHost.isConnected, false);
    assert.ok(h.calls.some(call => call.type === 'inlineClose' && call.sessionId === 'visible-1'));
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 2);
    assert.equal(h.editor().textContent, '');
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('a new explicit generation always requests four types and locks controls only while generating', async () => {
  let connected = false, finish; const h = harness({paired:false, intercept:m => m.type === 'inlineHealth' ? {ok:true,paired:connected} : m.type === 'inlineGenerate' ? new Promise(resolve => {finish=resolve;}) : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => !h.shadow().querySelector('.actions .primary').hidden);
    assert.equal(h.shadow().querySelector('.generate').disabled, false); assert.equal(h.calls.some(m => m.type === 'inlineGenerate'), false);
    connected = true; await clickGenerate(h); await until(() => finish); assert.equal(h.shadow().querySelector('.generate').disabled, true);
    h.w.dispatchEvent(new h.w.Event('focus')); await delay(40); assert.equal(h.calls.filter(m => m.type === 'inlineGenerate').length, 1);
    finish({ok:true,job:{id:'all-job',status:'completed',candidates}}); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.find(m => m.type === 'inlineGenerate').style, 'all'); assert.equal(h.shadow().querySelector('.generate').disabled, false); assert.equal(h.sent(),0);
  } finally {h.dispose();}
});

test('connection expiry retains one recovery action and all types resume after explicit recovery', async () => {
  let attempts=0; const h=harness({intercept:m=>m.type==='inlineGenerate'&&++attempts===1?{ok:false,code:'PAIRING_EXPIRED',error:'本机连接已过期'}:undefined});
  try {
    h.start();await clickGenerate(h);await until(()=>!h.shadow().querySelector('.actions .primary').hidden);
    h.w.dispatchEvent(new h.w.Event('focus'));await delay(100);assert.equal(attempts,1);
    await clickGenerate(h);await until(()=>h.shadow().querySelectorAll('.choice').length===4);
    assert.equal(attempts,2);assert.equal(h.calls.filter(m=>m.type==='inlineGenerate')[1].style,'all');assert.equal(h.sent(),0);
  } finally {h.dispose();}
});

test('repeated inline connection attempts release the controller and recover on the next click', async () => {
  let connected = false;
  const h = harness({paired: false, intercept: message => message.type === 'inlineHealth' ? {ok: true, paired: connected} : undefined});
  try {
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.actions .primary')?.hidden === false);
    for (let i = 1; i <= 2; i++) {
      h.shadow().querySelector('.actions .primary').click();
      await until(() => h.calls.filter(call => call.type === 'inlineHealth').length === i);
      await delay(40);
      assert.equal(h.shadow().querySelector('.actions .primary').hidden, false);
      assert.equal(h.shadow().querySelector('.actions .primary').disabled, false);
      assert.equal(h.shadow().querySelector('.actions .secondary').hidden, true);
      assert.equal(h.shadow().querySelector('.status').classList.contains('busy'), false);
      assert.equal(h.calls.some(call => call.type === 'inlineGenerate'), false);
    }
    connected = true;
    h.shadow().querySelector('.actions .primary').click();
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.filter(call => call.type === 'inlineHealth').length, 3);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.calls.some(call => ['inlineOpenSetup', 'inlinePair', 'saveSettings'].includes(call.type)), false);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('an offline local service can recover in the same composer without exposing credentials or uploading the draft', async () => {
  let online = false;
  const fixtureCredential = 'fixture-private-local-auto-credential';
  const h = harness({intercept: message => {
    if (message.type === 'inlineInit') return online
      ? {ok: true, sessionId: 'auto-recovered-session', paired: true, token: fixtureCredential}
      : {ok: false, code: 'BRIDGE_UNAVAILABLE', error: '本机 Codex 服务未启动，请启动本机服务后重试。'};
  }});
  try {
    const ownDraft = '这段手写草稿请保留在我自己的回复框里。';
    h.editor().textContent = ownDraft;
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelector('.status')?.textContent.includes('本机 Codex 服务未启动'));
    const originalHost = h.host();
    assert.ok(h.shadow().querySelector('.status').textContent.includes('本机 Codex 服务未启动'));
    assert.equal(h.editor().textContent, ownDraft);
    assert.equal(h.calls.some(call => call.type === 'inlineGenerate'), false);
    const retry = h.shadow().querySelector('.actions .primary:not([hidden]), .actions .secondary:not([hidden])');
    assert.ok(retry); assert.equal(retry.disabled, false);
    online = true;
    retry.click();
    await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.host(), originalHost);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 2);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.calls.some(call => ['inlineOpenSetup', 'inlinePair', 'saveSettings'].includes(call.type)), false);
    assert.equal(h.w.document.querySelector('input[type=password]'), null);
    assert.equal(h.shadow().querySelector('input[type=password]'), null);
    assert.equal(h.w.document.body.textContent.includes(fixtureCredential), false);
    assert.equal(h.shadow().textContent.includes(fixtureCredential), false);
    assert.equal(JSON.stringify(h.calls).includes(fixtureCredential), false);
    assert.equal(JSON.stringify(h.calls).includes(ownDraft), false);
    assert.equal(h.editor().textContent, ownDraft);
    h.shadow().querySelector('.choice').click();
    assert.equal(h.shadow().querySelector('.replace').hidden, false);
    assert.equal(h.editor().textContent, ownDraft);
    assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('the detail panel sits below the complete avatar-and-composer row without growing its centered children', async () => {
  const h = harness();
  try {
    const detail = installObservedDetailComposer(h); let sent = 0; let foreignClicks = 0;
    detail.send.addEventListener('click', () => sent++); detail.foreignAI.addEventListener('click', () => foreignClicks++);
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.host().parentElement, detail.replyColumn);
    assert.equal(detail.avatarRow.nextElementSibling, h.host());
    assert.equal(detail.replyColumn.children.length, 2);
    assert.equal(detail.completeColumn.children.length, 1);
    assert.equal(detail.narrowColumn.contains(h.host()), false);
    assert.equal(detail.fullRow.contains(h.host()), false);
    assert.equal(detail.actions.contains(h.host()), false);
    assert.equal(detail.avatarRow.contains(h.host()), false);
    assert.equal(detail.editor.closest('[data-fixture=detail-inner-input-row]'), detail.inputRow);
    assert.equal(detail.fullRow.children.length, 2);
    assert.equal(detail.actions.children.length, 2);
    assert.equal(detail.foreignAI.parentElement, detail.actions);
    assert.equal(detail.send.parentElement, detail.actions);
    assert.equal(detail.avatarRow.children.length, 2);
    assert.equal(detail.avatar.style.justifyContent, 'center');
    assert.equal(detail.completeColumn.style.justifyContent, 'center');
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.find(call => call.type === 'inlineInit').context.id, '1234567890123456789');
    h.shadow().querySelector('.choice').click();
    await until(() => detail.editor.textContent === candidates[0].text);
    assert.equal(sent, 0); assert.equal(foreignClicks, 0);
  } finally { h.dispose(); }
});

test('detail avatar-row placement remains stable during zero-width updates and preserves the manual draft', async () => {
  let width = 600;
  const h = harness({simulatedWidth: node => node.matches('[contenteditable=true]') ? width : 600});
  try {
    const detail = installObservedDetailComposer(h);
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    const originalHost = h.host(); detail.editor.textContent = '这是我在详情页手写的草稿。'; width = 0;
    for (let i = 0; i < 3; i++) {
      const unrelated = h.w.document.createElement('span'); unrelated.textContent = `详情评论更新${i}`; detail.main.append(unrelated);
      await delay(150);
      assert.equal(h.host(), originalHost);
      assert.equal(h.host().parentElement, detail.replyColumn);
      assert.equal(detail.avatarRow.nextElementSibling, originalHost);
    }
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 0);
    assert.equal(detail.editor.textContent, '这是我在详情页手写的草稿。');
    assert.equal(JSON.stringify(h.calls).includes('这是我在详情页手写的草稿。'), false);
    width = 600;
    h.shadow().querySelector('.choice').click();
    assert.equal(h.shadow().querySelector('.replace').hidden, false);
    assert.equal(detail.editor.textContent, '这是我在详情页手写的草稿。');
    detail.avatarRow.hidden = true;
    await until(() => h.host() === null && h.calls.some(call => call.type === 'inlineClose'));
    assert.equal(h.calls.filter(call => call.type === 'inlineClose').length, 1);
  } finally { h.dispose(); }
});

test('a detail composer without an avatar marker still mounts after the complete input-and-actions row', async () => {
  const h = harness();
  try {
    const detail = installObservedDetailComposer(h, {avatarMarker: false});
    h.start(); await clickGenerate(h); await until(() => h.shadow()?.querySelectorAll('.choice').length === 4);
    assert.equal(h.host().parentElement, detail.completeColumn);
    assert.equal(detail.fullRow.nextElementSibling, h.host());
    assert.equal(detail.completeColumn.children.length, 2);
    assert.equal(detail.narrowColumn.contains(h.host()), false);
    assert.equal(detail.fullRow.children.length, 2);
    assert.equal(detail.actions.children.length, 2);
    assert.equal(detail.foreignAI.parentElement, detail.actions);
    assert.equal(detail.send.parentElement, detail.actions);
    assert.equal(h.calls.filter(call => call.type === 'inlineInit').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'inlineGenerate').length, 1);
  } finally { h.dispose(); }
});


test('paused assistant preserves native draft and generates only after an explicit click following resume', async () => {
  let paused = true;
  const h = harness({intercept: message => {
    if (message.type === 'inlineInit') return {ok: true, sessionId: 'paused-session', paired: true, enabled: !paused};
    if (message.type === 'inlineHealth') return {ok: true, paired: true, enabled: !paused};
  }});
  try {
    const draft = '这条我自己还没写完。'; h.editor().textContent = draft;
    h.start(); await until(() => h.shadow()?.querySelector('.generate'));
    assert.equal(h.calls.length, 0);
    await clickGenerate(h); await until(() => h.shadow().querySelector('.status').textContent.includes('已暂停'));
    assert.equal(h.calls.filter(message => message.type === 'inlineGenerate').length, 0);
    assert.equal(h.editor().textContent, draft); assert.equal(h.sent(), 0);
    paused = false; h.w.dispatchEvent(new h.w.Event('focus')); await delay(150);
    assert.equal(h.calls.filter(message => message.type === 'inlineGenerate').length, 0);
    await clickGenerate(h); await until(() => h.shadow().querySelectorAll('.choice').length === 4);
    assert.equal(h.calls.filter(message => message.type === 'inlineGenerate').length, 1);
    assert.equal(h.editor().textContent, draft); assert.equal(h.sent(), 0);
  } finally { h.dispose(); }
});

test('unified automatic replies show model-chosen style labels rather than the legacy four slot names',async()=>{
 const chosen=['empathetic','chat','practical','perspective'];
 const unified=candidates.map((candidate,index)=>({...candidate,replyStyle:chosen[index],label:'不可信服务端标签'}));
 const h=harness({intercept:message=>message.type==='inlineGenerate'?{ok:true,job:{id:'unified-auto',status:'completed',candidates:unified,tonePreset:'auto'}}:undefined});
 try{
  h.start();await clickGenerate(h);await until(()=>h.shadow().querySelectorAll('.choice').length===4);
  assert.deepEqual([...h.shadow().querySelectorAll('.tag')].map(n=>n.textContent),['温和共情','日常聊天','实用建议','换个角度']);
  assert.equal(h.shadow().querySelector('.batch-tone').textContent,'自动匹配：温和共情 · 日常聊天 · 实用建议 · 换个角度');
  assert.equal(h.shadow().textContent.includes('不可信服务端标签'),false);assert.equal(h.sent(),0);
 }finally{h.dispose();}
});

test('manual unified style remains one style across four distinct candidates without auto-regeneration',async()=>{
 const unified=candidates.map(candidate=>({...candidate,replyStyle:'agree'}));
 const h=harness({intercept:message=>message.type==='inlineGenerate'?{ok:true,job:{id:'unified-agree',status:'completed',candidates:unified,tonePreset:'agree'}}:undefined});
 try{
  h.start();await clickGenerate(h);await until(()=>h.shadow().querySelectorAll('.choice').length===4);
  assert.deepEqual([...h.shadow().querySelectorAll('.tag')].map(n=>n.textContent),Array(4).fill('认可共鸣'));
  assert.equal(h.shadow().querySelector('.batch-tone').textContent,'本组风格：认可共鸣');
  h.w.dispatchEvent(new h.w.Event('focus'));await delay(100);
  assert.equal(h.calls.filter(m=>m.type==='inlineGenerate').length,1);assert.equal(h.sent(),0);
 }finally{h.dispose();}
});
