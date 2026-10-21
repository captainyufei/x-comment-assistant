import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const script = await readFile(new URL('./extension/composer-ui.js', import.meta.url), 'utf8');
const reply = 'AI 像一间工具齐全的厨房。\n先找愿意来吃饭的人，再找提示词。';

// Draft.js keeps content and selection in EditorState. Its paste handler replaces
// that state selection; changing contenteditable DOM alone cannot update it.
// Primary sources:
// https://github.com/facebookarchive/draft-js/blob/main/src/component/handlers/edit/editOnPaste.js
// https://github.com/facebookarchive/draft-js/blob/main/src/component/handlers/edit/editOnSelect.js
function editorHarness({initial = '', nativeSelection = 'start', supportsPaste = true, blocksPaste = false, normalizeEmptySelection = false, renderCaretAtStart = false, renderDelay = 0, pasteTransform = value => value} = {}) {
  const dom = new JSDOM('<main><div contenteditable="true" role="textbox" data-testid="tweetTextarea_0"></div><button data-testid="tweetButton">回复</button></main>', {
    url: 'https://x.com/compose/post', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const doc = w.document;
  const editor = doc.querySelector('[contenteditable]');
  const model = {text: initial, start: nativeSelection === 'end' ? initial.length : 0, end: nativeSelection === 'end' ? initial.length : 0};
  const stats = {execCommands: 0, pastes: 0, syncs: 0, sends: 0, clipboardWrites: 0, pasteValues: [], pasteSelections: [], nativeInputs: 0};
  const renders = new Set();
  const blocks = () => [...editor.querySelectorAll('[data-block=true]')];
  const visibleText = () => blocks().map(block => block.textContent).join('\n');
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this === editor && blocks().length ? visibleText() : this.textContent; }, set(value) { this.textContent = value; }, configurable: true
  });
  class DataTransfer {
    constructor() { this.data = new Map(); this.files = []; this.items = []; }
    get types() { return [...this.data.keys()]; }
    setData(type, text) { this.data.set(type, String(text)); }
    getData(type) { return this.data.get(type) || ''; }
  }
  class ClipboardEvent extends w.Event {
    constructor(type, options = {}) { super(type, options); this.clipboardData = options.clipboardData || null; }
  }
  w.DataTransfer = DataTransfer;
  w.ClipboardEvent = ClipboardEvent;
  Object.defineProperty(w.navigator, 'clipboard', {value: {async writeText() { stats.clipboardWrites++; }}});
  function nativePoint(offset) {
    const list = blocks();
    let remaining = offset;
    for (let i = 0; i < list.length; i++) {
      const block = list[i]; const length = block.textContent.length;
      if (remaining <= length || i === list.length - 1) {
        const walker = doc.createTreeWalker(block, w.NodeFilter.SHOW_TEXT);
        let leaf = walker.nextNode(); let last;
        while (leaf) {
          if (remaining <= leaf.textContent.length) return [leaf, remaining];
          remaining -= leaf.textContent.length; last = leaf; leaf = walker.nextNode();
        }
        if (last) return [last, last.textContent.length];
        const keyedLeaves = [...block.querySelectorAll('[data-offset-key]')].filter(leaf => !leaf.querySelector('[data-offset-key]'));
        return [keyedLeaves.at(-1) || block, 0];
      }
      remaining -= length + 1;
    }
    return [editor, 0];
  }
  function nativeOffset(container, offset) {
    const list = blocks();
    const block = (container.nodeType === w.Node.ELEMENT_NODE ? container : container.parentElement).closest('[data-block=true]');
    if (block) {
      const index = list.indexOf(block);
      const before = doc.createRange(); before.selectNodeContents(block); before.setEnd(container, offset);
      return list.slice(0, index).reduce((length, item) => length + item.textContent.length + 1, 0) + before.toString().length;
    }
    if (container === editor) return offset ? visibleText().length : 0;
    if (container.nodeType === w.Node.ELEMENT_NODE && container.hasAttribute('data-contents')) {
      return list.slice(0, offset).reduce((length, item, index) => length + item.textContent.length + (index < list.length - 1 ? 1 : 0), 0);
    }
    throw new Error('Selection point lies outside Draft blocks');
  }
  function putNativeSelection(start, end) {
    const [startLeaf, startOffset] = nativePoint(start);
    const [endLeaf, endOffset] = nativePoint(end);
    const range = doc.createRange(); range.setStart(startLeaf, startOffset); range.setEnd(endLeaf, endOffset);
    const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  function render() {
    const contents = doc.createElement('div'); contents.dataset.contents = 'true';
    for (const [index, text] of model.text.split('\n').entries()) {
      const block = doc.createElement('div'); block.dataset.block = 'true'; block.dataset.offsetKey = `block-${index}-0-0`;
      const wrapper = doc.createElement('div'); wrapper.dataset.offsetKey = `block-${index}-0-0`; block.append(wrapper);
      const pieces = text ? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))].filter(Boolean) : [''];
      for (const [part, piece] of pieces.entries()) {
        const leaf = doc.createElement('span'); leaf.dataset.offsetKey = `block-${index}-0-${part}`;
        if (piece) { const textSpan = doc.createElement('span'); textSpan.dataset.text = 'true'; textSpan.textContent = piece; leaf.append(textSpan); }
        else leaf.append(doc.createElement('br'));
        wrapper.append(leaf);
      }
      contents.append(block);
    }
    editor.replaceChildren(contents);
    if (doc.activeElement === editor) putNativeSelection(renderCaretAtStart && model.text !== initial ? 0 : model.start, renderCaretAtStart && model.text !== initial ? 0 : model.end);
  }
  function syncSelection() {
    if (doc.activeElement !== editor) return;
    // Draft blocks onSelect while latest EditorState has not reached props/render.
    // A queued native selectionchange must not accept stale pre-paste DOM points.
    if (visibleText() !== model.text) return;
    const selection = doc.getSelection();
    if (!selection?.rangeCount) return;
    const selected = selection.getRangeAt(0);
    if (!editor.contains(selected.startContainer) || !editor.contains(selected.endContainer)) return;
    model.start = nativeOffset(selected.startContainer, selected.startOffset);
    model.end = nativeOffset(selected.endContainer, selected.endOffset);
    if (normalizeEmptySelection && blocks().length === 1 && visibleText() === '') putNativeSelection(0, 0);
    stats.syncs++;
  }
  // Models a delivered React selection event, not React's native-event plugin
  // flags or timing. Actual X focus/selection behavior still needs browser acceptance.
  doc.addEventListener('selectionchange', syncSelection);
  for (const event of ['select', 'keyup', 'mouseup']) editor.addEventListener(event, syncSelection);
  if (blocksPaste) editor.addEventListener('paste', event => { stats.pastes++; event.preventDefault(); event.stopImmediatePropagation(); }, {capture: true});
  if (supportsPaste) editor.addEventListener('paste', event => {
    stats.pastes++;
    const pasted = event.clipboardData?.getData('text/plain');
    assert.equal(typeof pasted, 'string', 'paste must expose plain text to the editor handler');
    assert.equal(event.clipboardData?.getData('text/html'), '', 'candidate markup must remain literal plain text');
    assert.equal(event.bubbles, true);
    assert.equal(event.cancelable, true);
    event.preventDefault();
    stats.pasteValues.push(pasted);
    const selection = doc.getSelection();
    const selected = selection?.rangeCount && selection.getRangeAt(0);
    if (selected) stats.pasteSelections.push({collapsed: selected.collapsed, startContainer: selected.startContainer, startOffset: selected.startOffset});
    model.text = model.text.slice(0, model.start) + pasteTransform(pasted) + model.text.slice(model.end);
    model.start += pasteTransform(pasted).length; model.end = model.start;
    const timer = setTimeout(() => { renders.delete(timer); render(); }, renderDelay);
    renders.add(timer);
  });
  // This accurately reproduces the original risk: native DOM insertion can look
  // successful while a controlled editor still owns the old text and caret.
  doc.execCommand = (command, ignored, text) => {
    stats.execCommands++;
    assert.equal(command, 'insertText');
    const range = doc.getSelection().getRangeAt(0);
    range.deleteContents(); range.insertNode(doc.createTextNode(text));
    editor.dispatchEvent(new w.InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
    return true;
  };
  editor.addEventListener('input', () => { stats.nativeInputs++; });
  doc.querySelector('[data-testid=tweetButton]').addEventListener('click', () => { stats.sends++; });
  render(); editor.focus(); putNativeSelection(model.start, model.end);
  w.eval(script);
  function caret() {
    const selection = doc.getSelection();
    assert.ok(selection?.rangeCount);
    const range = selection.getRangeAt(0);
    return {collapsed: range.collapsed, offset: nativeOffset(range.startContainer, range.startOffset), inside: editor.contains(range.startContainer)};
  }
  function backspace() {
    // The editor's keyboard handler edits EditorState, then React renders it.
    const from = model.start === model.end ? Math.max(0, model.start - 1) : model.start;
    model.text = model.text.slice(0, from) + model.text.slice(model.end);
    model.start = from; model.end = from; render();
  }
  function userType(text) {
    editor.dispatchEvent(new w.InputEvent('beforeinput', {bubbles: true, cancelable: true, inputType: 'insertText', data: text}));
    model.text = model.text.slice(0, model.start) + text + model.text.slice(model.end);
    model.start += text.length; model.end = model.start;
    render();
    editor.dispatchEvent(new w.InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
  }
  function dispose() { for (const timer of renders) clearTimeout(timer); w.close(); }
  return {w, doc, editor, model, stats, caret, backspace, userType, render, dispose, insert: (...args) => w.__JieYiJuUI.insertDraft(editor, ...args)};
}

test('filling uses the editor paste transaction so text and caret survive its next controlled render', async () => {
  const h = editorHarness();
  try {
    assert.equal(await h.insert(reply), reply);
    assert.equal(h.model.text, reply, 'DOM-only success must not be reported as a completed fill');
    assert.equal(h.editor.innerText, reply);
    h.render();
    assert.equal(h.editor.innerText, reply, 'next React render must not restore stale text');
    assert.deepEqual(h.caret(), {collapsed: true, offset: reply.length, inside: true});
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.clipboardWrites, 0);
    assert.equal(h.stats.sends, 0);
  } finally { h.dispose(); }
});

test('replacement synchronizes a stale model caret before paste and removes the old draft once', async () => {
  const original = '我原来写的回复';
  const h = editorHarness({initial: original, nativeSelection: 'end'});
  try {
    assert.equal(await h.insert(reply, 'replace'), reply);
    assert.equal(h.model.text, reply);
    assert.equal(h.editor.innerText, reply);
    assert.ok(h.stats.syncs > 0, 'the app must receive a selection update before the paste handler runs');
    assert.deepEqual(h.stats.pasteValues, [reply]);
    assert.equal(h.stats.execCommands, 0);
    assert.deepEqual(h.caret(), {collapsed: true, offset: reply.length, inside: true});
  } finally { h.dispose(); }
});

test('append preserves user whitespace and multiline candidate text without a second insertion', async () => {
  const original = '  我自己的开头\n末尾也保留  ';
  const expected = `${original}\n${reply}`;
  const h = editorHarness({initial: original});
  try {
    assert.equal(await h.insert(reply, 'append'), expected);
    assert.equal(h.model.text, expected);
    assert.equal(h.editor.innerText, expected);
    assert.equal(h.stats.pastes, 1);
    assert.deepEqual(h.stats.pasteValues, [`\n${reply}`], 'append must paste only the suffix, preserving the original editor content and entities');
    assert.equal(h.stats.execCommands, 0);
    assert.deepEqual(h.caret(), {collapsed: true, offset: expected.length, inside: true});
  } finally { h.dispose(); }
});

test('deleting after fill edits the actual end and does not jump to stale model selection', async () => {
  const h = editorHarness({initial: '旧草稿', nativeSelection: 'start'});
  try {
    await h.insert(reply);
    h.backspace();
    assert.equal(h.model.text, reply.slice(0, -1));
    assert.equal(h.editor.innerText, reply.slice(0, -1));
    assert.deepEqual(h.caret(), {collapsed: true, offset: reply.length - 1, inside: true});
  } finally { h.dispose(); }
});

test('rapid repeated fills share one pending editor transaction', async () => {
  const h = editorHarness({renderDelay: 8});
  try {
    const first = h.insert(reply); const second = h.insert(reply); const third = h.insert(reply);
    assert.equal(first, second, 'identical pending fill must reuse its exact operation promise');
    assert.equal(first, third);
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(results, [reply, reply, reply]);
    assert.equal(h.stats.pastes, 1, 'double click must not dispatch a second paste before controlled rendering finishes');
    assert.equal(h.model.text, reply);
    assert.equal(h.editor.innerText, reply);
    assert.equal(h.stats.execCommands, 0);
  } finally { h.dispose(); }
});

test('an editor without a paste handler leaves an existing handwritten draft intact', async () => {
  const original = '这是我写好的内容，不要改动';
  const h = editorHarness({initial: original, supportsPaste: false});
  try {
    await assert.rejects(h.insert(reply), /复制|粘贴|填入/);
    assert.equal(h.model.text, original);
    assert.equal(h.editor.innerText, original);
    assert.equal(h.stats.execCommands, 0, 'unsupported paste must not fall through to a second DOM write');
    assert.equal(h.stats.clipboardWrites, 0);
    assert.equal(h.stats.sends, 0);
  } finally { h.dispose(); }
});

test('literal markup is delivered only as plain text through the same editor transaction', async () => {
  const value = '<img src=x onerror=alert(1)> 只是候选文字';
  const h = editorHarness();
  try {
    await h.insert(value);
    assert.equal(h.model.text, value);
    assert.equal(h.editor.innerText, value);
    assert.equal(h.editor.querySelector('img'), null);
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.execCommands, 0);
  } finally { h.dispose(); }
});

test('an editor-transformed or partial result never triggers a blind second native write', async () => {
  const h = editorHarness({initial: '原稿', pasteTransform: value => value.slice(0, 6)});
  try {
    await assert.rejects(h.insert(reply), /填入|检查|变化|修改/);
    assert.equal(h.model.text, reply.slice(0, 6));
    assert.equal(h.editor.innerText, reply.slice(0, 6));
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.clipboardWrites, 0);
  } finally { h.dispose(); }
});

test('a disconnected editor is rejected before selection or insertion', async () => {
  const h = editorHarness({initial: '现有回复'});
  try {
    h.editor.remove();
    await assert.rejects(h.insert(reply), /关闭|重新/);
    assert.equal(h.model.text, '现有回复');
    assert.equal(h.stats.pastes, 0);
    assert.equal(h.stats.execCommands, 0);
  } finally { h.dispose(); }
});

test('user input during selection synchronization cancels filling before paste', async () => {
  const h = editorHarness({initial: '原来的草稿'});
  try {
    const pending = h.insert(reply);
    h.userType('用户接着输入的内容');
    const userText = h.model.text;
    await assert.rejects(pending, /回复框|草稿|输入|变化|改动|修改/);
    assert.equal(h.model.text, userText);
    assert.equal(h.editor.innerText, userText);
    assert.equal(h.stats.pastes, 0);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.clipboardWrites, 0);
  } finally { h.dispose(); }
});

test('focus loss during selection synchronization cancels filling before paste', async () => {
  const original = '正在编辑的回复';
  const h = editorHarness({initial: original});
  try {
    const pending = h.insert(reply);
    h.doc.querySelector('button').focus();
    await assert.rejects(pending, /回复框|焦点|变化|填入|关闭/);
    assert.equal(h.model.text, original);
    assert.equal(h.editor.innerText, original);
    assert.equal(h.stats.pastes, 0);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.sends, 0);
  } finally { h.dispose(); }
});

test('closing during selection synchronization cancels filling before paste', async () => {
  const h = editorHarness({initial: '暂存的回复'});
  try {
    const pending = h.insert(reply);
    h.editor.remove();
    await assert.rejects(pending, /回复框|焦点|变化|填入|关闭/);
    assert.equal(h.model.text, '暂存的回复');
    assert.equal(h.stats.pastes, 0);
    assert.equal(h.stats.execCommands, 0);
  } finally { h.dispose(); }
});

test('canceling a paste event without committing text is never reported as successful', async () => {
  const h = editorHarness({pasteTransform: () => ''});
  try {
    await assert.rejects(h.insert(reply), error => error.code === 'DRAFT_INSERT_UNCERTAIN' && !/复制|粘贴/.test(error.message));
    assert.equal(h.model.text, '');
    assert.equal(h.editor.innerText, '');
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.clipboardWrites, 0);
  } finally { h.dispose(); }
});

test('a captured and canceled paste with no editor update preserves the draft and cannot claim success', async () => {
  const original = '这是一份尚未发送的手写草稿';
  const h = editorHarness({initial: original, blocksPaste: true});
  try {
    await assert.rejects(h.insert(reply), error => error.code === 'DRAFT_INSERT_UNCERTAIN' && !/复制|粘贴/.test(error.message));
    assert.equal(h.model.text, original);
    assert.equal(h.editor.innerText, original);
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.clipboardWrites, 0);
  } finally { h.dispose(); }
});

test('Draft block text reading retains empty paragraphs and multi-leaf plain text', () => {
  const value = '第一段有多个文字叶节点\n\n最后一段';
  const h = editorHarness({initial: value});
  try {
    assert.equal(h.editor.querySelectorAll('[data-block=true]').length, 3);
    assert.ok(h.editor.querySelector('[data-block=true] br'));
    assert.equal(h.w.__JieYiJuUI.readDraftText(h.editor), value);
  } finally { h.dispose(); }
});

test('a different simultaneous fill is rejected while the first transaction completes once', async () => {
  const h = editorHarness({renderDelay: 8});
  try {
    const first = h.insert(reply);
    const next = h.insert('另一条候选');
    await assert.rejects(next, error => error.code === 'DRAFT_INSERT_BUSY');
    assert.equal(await first, reply);
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.model.text, reply);
    assert.equal(h.editor.innerText, reply);
  } finally { h.dispose(); }
});

test('a delayed controlled render settles before success and does not cause another paste', async () => {
  const h = editorHarness({initial: '原稿', renderDelay: 120});
  try {
    assert.equal(await h.insert(reply), reply);
    assert.equal(h.model.text, reply);
    assert.equal(h.editor.innerText, reply);
    assert.deepEqual(h.caret(), {collapsed: true, offset: reply.length, inside: true});
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.execCommands, 0);
  } finally { h.dispose(); }
});

test('a changed reply target during selection synchronization cancels filling before paste', async () => {
  const h = editorHarness({initial: '我自己的草稿'});
  try {
    let current = true;
    const pending = h.insert(reply, 'replace', {isCurrent: () => current});
    current = false;
    await assert.rejects(pending, /对象|变化|草稿|回复框|原帖/);
    assert.equal(h.model.text, '我自己的草稿');
    assert.equal(h.editor.innerText, '我自己的草稿');
    assert.equal(h.stats.pastes, 0);
    assert.equal(h.stats.execCommands, 0);
  } finally { h.dispose(); }
});

test('an empty BR selection normalized by the editor remains collapsed at its deepest keyed leaf', async () => {
  const h = editorHarness({normalizeEmptySelection: true});
  try {
    const leaf = [...h.editor.querySelectorAll('[data-offset-key]')].find(node => !node.querySelector('[data-offset-key]'));
    assert.ok(leaf?.querySelector('br'));
    assert.equal(await h.insert(reply), reply);
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.pasteSelections[0].collapsed, true);
    assert.equal(h.stats.pasteSelections[0].startContainer, leaf);
    assert.equal(h.stats.pasteSelections[0].startOffset, 0);
    assert.equal(h.model.text, reply);
    assert.deepEqual(h.caret(), {collapsed: true, offset: reply.length, inside: true});
  } finally { h.dispose(); }
});

for (const original of ['\n已有文字\n', '\n']) {
  for (const mode of ['replace', 'append']) {
    test(`${mode} includes leading and trailing empty Draft paragraphs in ${JSON.stringify(original)}`, async () => {
      const h = editorHarness({initial: original});
      const expected = mode === 'append' ? `${original}\n${reply}` : reply;
      try {
        assert.equal(await h.insert(reply, mode), expected);
        assert.equal(h.model.text, expected);
        assert.equal(h.editor.innerText, expected);
        assert.deepEqual(h.stats.pasteValues, [mode === 'append' ? `\n${reply}` : reply]);
        assert.deepEqual(h.caret(), {collapsed: true, offset: expected.length, inside: true});
        assert.equal(h.stats.pastes, 1);
        assert.equal(h.stats.execCommands, 0);
      } finally { h.dispose(); }
    });
  }
}

test('Draft trailing soft-newline display normalization removes one LF and preserves empty paragraph separators', () => {
  const h = editorHarness();
  try {
    const contents = h.editor.querySelector('[data-contents=true]');
    const makeBlock = text => {
      const block = h.doc.createElement('div'); block.dataset.block = 'true'; block.dataset.offsetKey = 'soft-0-0';
      const wrapper = h.doc.createElement('div'); wrapper.dataset.offsetKey = 'soft-0-0';
      const leaf = h.doc.createElement('span'); leaf.dataset.offsetKey = 'soft-0-0';
      const textNode = h.doc.createElement('span'); textNode.dataset.text = 'true';
      if (text) textNode.textContent = text; else textNode.append(h.doc.createElement('br'));
      leaf.append(textNode); wrapper.append(leaf); block.append(wrapper); return block;
    };
    contents.replaceChildren(makeBlock('段内软换行\n\n'));
    assert.equal(h.w.__JieYiJuUI.readDraftText(h.editor), '段内软换行\n');
    contents.append(makeBlock(''));
    assert.equal(h.w.__JieYiJuUI.readDraftText(h.editor), '段内软换行\n\n', 'empty paragraph adds its own separator after canonical soft newline');
    contents.replaceChildren(makeBlock('保留两个软换行\n\n\n'));
    assert.equal(h.w.__JieYiJuUI.readDraftText(h.editor), '保留两个软换行\n\n', 'normalization must remove exactly one displayed LF, not trim all trailing newlines');
    contents.append(makeBlock(''));
    assert.equal(h.w.__JieYiJuUI.readDraftText(h.editor), '保留两个软换行\n\n\n');
  } finally { h.dispose(); }
});

test('matching text with an incorrect caret is uncertain and never forcibly repositioned', async () => {
  const h = editorHarness({renderCaretAtStart: true});
  try {
    await assert.rejects(h.insert(reply), error => error.code === 'DRAFT_INSERT_UNCERTAIN' && !/复制|粘贴/.test(error.message));
    assert.equal(h.model.text, reply);
    assert.equal(h.editor.innerText, reply);
    assert.deepEqual(h.caret(), {collapsed: true, offset: 0, inside: true});
    assert.equal(h.stats.pastes, 1);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.clipboardWrites, 0);
  } finally { h.dispose(); }
});

test('orphaned stale text outside Draft contents prevents any new editor write', async () => {
  const original = '已有编辑器内容';
  const orphan = '这是旧的孤立重复内容';
  const h = editorHarness({initial: original});
  try {
    h.editor.append(h.doc.createTextNode(orphan));
    const before = h.editor.textContent;
    await assert.rejects(h.insert(reply), error => /草稿|检查|编辑器|回复框|变化/.test(error.message) && !/复制|粘贴/.test(error.message));
    assert.equal(h.model.text, original);
    assert.equal(h.editor.textContent, before);
    assert.equal(h.editor.textContent.endsWith(orphan), true);
    assert.equal(h.stats.pastes, 0);
    assert.equal(h.stats.execCommands, 0);
    assert.equal(h.stats.clipboardWrites, 0);
  } finally { h.dispose(); }
});
