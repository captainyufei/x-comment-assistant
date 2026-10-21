import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html = await readFile(new URL('./extension/panel.html', import.meta.url), 'utf8');
const source = await readFile(new URL('./extension/panel.js', import.meta.url), 'utf8');
const bootstrap = source.indexOf('\nif (globalThis.chrome?.runtime?.sendMessage)');
assert.ok(bootstrap > 0);
const styleCatalogue=await readFile(new URL('./extension/reply-style-catalog.js',import.meta.url),'utf8');
const mountSource = styleCatalogue+'\n'+source.slice(0, bootstrap).replace(/^import .*?;\n/gm,'').replace('export function mountPanel', 'function mountPanel') + '\nglobalThis.fixtureMountPanel = mountPanel;';
const SOURCE = {id: '1234567890123456789', author: '@example', authorName: '测试作者', url: 'https://x.com/example/status/1234567890123456789', text: '这是原帖的中文内容。', quote: '这是单独保存的引用内容。', hasMedia: false};
const SECOND = {...SOURCE, id: '1234567890123456790', author: '@another', url: 'https://x.com/another/status/1234567890123456790', text: '另一条原帖。'};
const CANDIDATE = {style: 'humor', label: '轻松接话', text: '工具已经足够快了，先想想自己想去哪儿。'};
const NATURAL_CANDIDATES = [
  {style: 'witty', label: '接一句', text: '活还是两小时，只是改成教它干了。'},
  {style: 'humor', label: '另一句', text: '活没交，需求文档倒是写完了。'}
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, timeout = 1200) { const started = Date.now(); while (!condition()) { if (Date.now() - started > timeout) throw new Error('Panel condition timed out'); await delay(10); } }

function fixtureState(extra = {}) {
  return {contexts: [SOURCE], selectedContext: SOURCE, results: [], resultsContext: null, preferences: {style: 'mix', personalExperience: '', tone: ''}, settings: {paired: false}, job: null, ...extra};
}

function harness(t, {initialState = fixtureState(), initiallyOnline = true, intercept} = {}) {
  // Only our HTML and module body execute; this fixture never opens another page.
  const dom = new JSDOM(html, {url: 'https://extension-fixture.test/panel.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window; const calls = []; let online = initiallyOnline; let active = 0; let maxActive = 0;
  const state = structuredClone(initialState);
  async function send(message) {
    calls.push(structuredClone(message)); active++; maxActive = Math.max(maxActive, active);
    try {
      const custom = await intercept?.(message);
      if (custom !== undefined) return custom;
      if (message.type === 'getState') return {ok: true, state: structuredClone(state)};
      if (message.type === 'checkBridge') {
        if (!online) return {ok: false, code: 'BRIDGE_UNAVAILABLE', error: '本机 Codex 服务未启动，请启动服务后重试。'};
        state.settings.paired = true;
        return {ok: true, paired: true, health: {authenticated: true, authentication: 'ChatGPT', codexVersion: 'fixture'}};
      }
      if (message.type === 'saveSettings') {
        state.preferences = {...state.preferences, ...message.preferences};
        return {ok: true, state: structuredClone(state)};
      }
      if (message.type === 'generate') return {ok: true, job: {id: 'fixture-job', status: 'running', context: message.context, candidates: []}};
      if (message.type === 'openReply') return {ok: true, opened: true};
      throw new Error(`Unexpected panel message ${message.type}`);
    } finally { active--; }
  }
  w.eval(mountSource);
  const panel = w.fixtureMountPanel(send);
  t.after(() => { panel.destroy(); w.close(); });
  return {w, doc: w.document, panel, calls, state, setOnline(value) { online = value; }, maxActive: () => maxActive};
}

function assertNoManualPairing(h) {
  assert.equal(h.doc.getElementById('pairing-code'), null);
  assert.equal(h.doc.getElementById('pair-bridge'), null);
  assert.equal(h.doc.querySelector('input[type=password]'), null);
  assert.equal(h.doc.querySelector('a[href*="/connect"]'), null);
  assert.equal(h.doc.querySelectorAll('#connection-settings button').length, 1);
  assert.equal(h.doc.body.textContent.includes('配对'), false);
  assert.equal(h.calls.some(call => Object.hasOwn(call, 'pairingCode')), false);
}

test('sidebar first load automatically connects and refreshes the source state without manual credentials', async t => {
  const fixtureCredential = 'fixture-private-auto-connection-credential';
  const h = harness(t, {initialState: fixtureState({settings: {paired: false, token: fixtureCredential}}), intercept: message => message.type === 'checkBridge' ? {ok: true, paired: true, health: {authenticated: true, authentication: 'ChatGPT', token: fixtureCredential}} : undefined});
  await h.panel.ready;
  assert.deepEqual(h.calls.map(call => call.type), ['getState', 'checkBridge', 'getState']);
  assert.match(h.doc.getElementById('connection-text').textContent, /已连接/);
  assert.equal(h.doc.getElementById('generate').disabled, false);
  assert.equal(h.doc.getElementById('source-text').value, SOURCE.text);
  assert.equal(h.doc.getElementById('quoted-text').textContent, SOURCE.quote);
  assert.equal(h.doc.getElementById('check-bridge').disabled, false);
  assert.equal(h.doc.body.textContent.includes(fixtureCredential), false);
  assert.equal(JSON.stringify(h.calls).includes(fixtureCredential), false);
  assertNoManualPairing(h);
});

test('sidebar displays four returned types without style controls and keeps each reply owner', async t => {
  const values = ['witty','humor','insight','story'].map((style,index)=>({...CANDIDATE,style,text:`候选${index+1}。`}));
  const h = harness(t, {initialState: fixtureState({results: values, resultsContext: SOURCE})}); await h.panel.ready;
  assert.equal(h.doc.querySelector('[data-style]'), null); assert.equal(h.doc.getElementById('style-summary').textContent,'四类回复');
  assert.equal(h.doc.getElementById('result-count').textContent,'4 条草稿');
  assert.deepEqual([...h.doc.querySelectorAll('.reply-style')].map(n=>n.textContent),['01认可并展开','02幽默接梗','03补充观点','04换个角度']);
  for (const [index,editor] of [...h.doc.querySelectorAll('.reply-text')].entries()) { editor.value += ' 我自己的补充。'; editor.dispatchEvent(new h.w.Event('input')); h.doc.querySelectorAll('.reply-actions .button-primary')[index].click(); await until(()=>h.calls.filter(c=>c.type==='openReply').length===index+1); const opened=h.calls.filter(c=>c.type==='openReply')[index]; assert.equal(opened.context.id,SOURCE.id); assert.equal(opened.draftText,editor.value); }
  assert.equal(h.calls.some(c=>c.type==='generate'),false);
});

test('sidebar source edits wait for an explicit click and every new request uses all types', async t => {
  const values=['witty','humor','insight','story'].map((style,index)=>({...CANDIDATE,style,text:`候选${index+1}。`}));
  const h=harness(t,{intercept:m=>m.type==='pollJob'?{ok:true,job:{id:m.id,status:'completed',context:SOURCE,contextStatus:'sufficient',missingContext:'',candidates:values}}:undefined});
  await h.panel.ready;const editor=h.doc.getElementById('source-text');editor.value='这是我核对后的原帖。';editor.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.calls.some(c=>c.type==='generate'),false);h.doc.getElementById('generate').click();await until(()=>h.doc.querySelectorAll('.reply-card').length===4,3000);
  const generated=h.calls.find(c=>c.type==='generate');assert.equal(generated.preferences.style,'all');assert.equal(Object.hasOwn(generated.preferences,'contextNote'),false);assert.equal(generated.context.text,editor.value);
  editor.value='核对后的第二版原帖。';editor.dispatchEvent(new h.w.Event('input'));await delay(50);assert.equal(h.calls.filter(c=>c.type==='generate').length,1);
  h.doc.getElementById('generate').click();await until(()=>h.calls.filter(c=>c.type==='generate').length===2);assert.equal(h.calls.filter(c=>c.type==='generate')[1].preferences.style,'all');
});

test('sidebar offline recovery preserves source edits and cannot restore removed context controls', async t => {
  const h=harness(t,{initiallyOnline:false,initialState:fixtureState({settings:{paired:true},preferences:{style:'mix',contextNote:'不应传给模型的旧上下文',personalExperience:'',tone:''}})});await h.panel.ready;
  assert.equal(h.doc.getElementById('generate').disabled,true);assert.equal(h.doc.getElementById('error-notice').hidden,false);assert.match(h.doc.getElementById('bridge-detail').textContent,/服务未启动/);
  const editor=h.doc.getElementById('source-text');editor.value='核对后的原帖';editor.dispatchEvent(new h.w.Event('input'));h.setOnline(true);h.doc.getElementById('check-bridge').click();await until(()=>!h.doc.getElementById('generate').disabled);
  assert.equal(editor.value,'核对后的原帖');assert.equal(h.doc.querySelector('[data-style],#personal-experience,#tone,#save-preferences'),null);
  h.doc.getElementById('generate').click();await until(()=>h.calls.some(c=>c.type==='generate'));const generated=h.calls.find(c=>c.type==='generate');assert.equal(generated.preferences.style,'all');assert.equal(Object.hasOwn(generated.preferences,'contextNote'),false);assert.equal(generated.context.text,editor.value);assertNoManualPairing(h);
});

test('sidebar pending connection serializes duplicate checks and merges deferred state refreshes', async t => {
  let complete;
  const h = harness(t, {intercept: message => message.type === 'checkBridge' ? new Promise(resolve => { complete = resolve; }) : undefined});
  await until(() => Boolean(complete));
  assert.equal(h.doc.getElementById('check-bridge').disabled, true);
  h.doc.getElementById('check-bridge').dispatchEvent(new h.w.Event('click'));
  h.doc.getElementById('check-bridge').dispatchEvent(new h.w.Event('click'));
  await h.panel.refresh(); await h.panel.refresh();
  assert.deepEqual(h.calls.map(call => call.type), ['getState', 'checkBridge']);
  h.state.settings.paired = true;
  complete({ok: true, paired: true, health: {authenticated: true}});
  await h.panel.ready;
  await until(() => h.calls.filter(call => call.type === 'getState').length === 3 && !h.doc.getElementById('check-bridge').disabled);
  assert.equal(h.calls.filter(call => call.type === 'checkBridge').length, 1);
  assert.equal(h.maxActive(), 1);
  assert.equal(h.doc.getElementById('generate').disabled, false);
});

test('sidebar removed preferences never send save messages or restore context input', async t => {
  const h=harness(t);await h.panel.ready;h.doc.getElementById('source-text').value='核对后的原文。';
  assert.equal(h.doc.querySelector('#preference-details,#save-preferences,#personal-experience,#tone,[data-style]'),null);
  h.doc.getElementById('settings-toggle').click();h.doc.getElementById('settings-toggle').click();await delay(50);
  assert.equal(h.calls.some(c=>c.type==='saveSettings'||c.type==='generate'),false);assert.equal(h.doc.getElementById('source-text').value,'核对后的原文。');assertNoManualPairing(h);
});

test('sidebar reconnection preserves candidate edits and the original reply owner', async t => {
  const h = harness(t, {initialState: fixtureState({contexts: [SOURCE, SECOND], selectedContext: SECOND, results: [CANDIDATE], resultsContext: SOURCE})});
  await h.panel.ready;
  const reply = h.doc.querySelector('.reply-text'); reply.value = '这是我改过的回复草稿。'; reply.dispatchEvent(new h.w.Event('input'));
  h.doc.getElementById('check-bridge').click();
  await until(() => h.calls.filter(call => call.type === 'checkBridge').length === 2 && !h.doc.getElementById('check-bridge').disabled);
  assert.equal(h.doc.querySelector('.reply-text').value, '这是我改过的回复草稿。');
  assert.equal(h.doc.getElementById('source-author').textContent.includes('@another'), true);
  assert.equal(h.doc.querySelector('.reply-author').textContent.includes('@example'), true);
  h.doc.querySelector('.reply-actions .button-primary').click();
  await until(() => h.calls.some(call => call.type === 'openReply'));
  const opened = h.calls.find(call => call.type === 'openReply');
  assert.equal(opened.context.id, SOURCE.id);
  assert.equal(opened.draftText, '这是我改过的回复草稿。');
  assert.equal(h.calls.some(call => call.type === 'generate'), false);
});

test('destroying a sidebar during its connection check ignores the late response', async t => {
  let complete;
  const h = harness(t, {intercept: message => message.type === 'checkBridge' ? new Promise(resolve => { complete = resolve; }) : undefined});
  await until(() => Boolean(complete));
  const priorStatus = h.doc.getElementById('connection-text').textContent;
  h.panel.destroy(); complete({ok: true, paired: true, health: {authenticated: true}});
  await h.panel.ready;
  assert.deepEqual(h.calls.map(call => call.type), ['getState', 'checkBridge']);
  assert.equal(h.doc.getElementById('connection-text').textContent, priorStatus);
});

test('panel labels use actual unified style instead of compatibility slot names',async t=>{
 const styles=['empathetic','practical','chat','perspective'];
 const results=['witty','humor','insight','story'].map((style,index)=>({style,replyStyle:styles[index],label:'不应显示的上游标签',text:`中文候选${index+1}，回应原帖。`,context:SOURCE}));
 const h=harness(t,{initialState:fixtureState({results,resultsContext:SOURCE})});await h.panel.ready;
 assert.deepEqual([...h.doc.querySelectorAll('.reply-style')].map(n=>n.textContent),['01温和共情','02实用建议','03日常聊天','04换个角度']);
 assert.equal(h.doc.body.textContent.includes('不应显示的上游标签'),false);
});
