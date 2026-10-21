import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadReviewData, saveReviewFeedback, MAX_REVIEW_FEEDBACK_BYTES } from './review-store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const item = (id = 'post_123') => ({
  id,
  source: {type: 'historical-screenshot', url: 'https://x.com/example/status/123', author: '截图作者', text: '太好了，又加班到凌晨两点。'},
  generation: {status: 'succeeded', summary: '这是在反讽和吐槽加班。', tags: ['吐槽', '反讽'], gaps: ['未重新核验原帖'], candidates: [{text: '闹钟刚下班，人还没下班。'}, {text: '这班上得，都快和早班无缝衔接了。'}], durationMs: 1320},
});
const feedback = (itemId = 'post_123', fields = {}) => ({itemId, rating: 'unlike-me', opinion: '结尾太像鸡汤。', ownReply: '我会短一点。', selectedCandidate: 0, ...fields});

async function fixture(t, items = [item()]) {
  const dir = await mkdtemp(join(tmpdir(), 'jieyiju-review-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const dataPath = join(dir, 'review-data.json');
  const feedbackPath = join(dir, 'persistent', 'review-feedback.json');
  await writeFile(dataPath, JSON.stringify({version: 1, items}));
  return {dir, dataPath, feedbackPath, options: {feedbackPath}};
}

test('review feedback saves separately, reloads exactly, and never mutates source samples', async t => {
  const f = await fixture(t);
  const before = await readFile(f.dataPath, 'utf8');
  assert.deepEqual(Object.keys((await loadReviewData(f.dataPath, f.options)).feedback), []);
  const result = await saveReviewFeedback(f.dataPath, feedback(), f.options);
  assert.match(result.feedback.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const loaded = await loadReviewData(f.dataPath, f.options);
  assert.deepEqual(loaded.feedback.post_123, result.feedback);
  assert.equal(await readFile(f.dataPath, 'utf8'), before);
  assert.deepEqual((await readdir(dirname(f.feedbackPath))).sort(), ['review-feedback.json']);
});

test('concurrent opinions on different items cannot overwrite one another', async t => {
  const f = await fixture(t, [item('one'), item('two')]);
  await Promise.all([
    saveReviewFeedback(f.dataPath, feedback('one', {opinion: '第一条'}), f.options),
    saveReviewFeedback(f.dataPath, feedback('two', {opinion: '第二条'}), f.options),
    saveReviewFeedback(f.dataPath, feedback('one', {opinion: '第一条的新意见'}), f.options),
  ]);
  const saved = await loadReviewData(f.dataPath, f.options);
  assert.equal(saved.feedback.one.opinion, '第一条的新意见');
  assert.equal(saved.feedback.two.opinion, '第二条');
});

test('only existing sample IDs and the four review fields can be changed', async t => {
  const f = await fixture(t);
  for (const input of [feedback('missing'), feedback('../escape'), feedback('__proto__'), feedback('constructor')]) {
    await assert.rejects(saveReviewFeedback(f.dataPath, input, f.options), error => ['REVIEW_ITEM', 'REVIEW_INVALID'].includes(error.code));
  }
  for (const fields of [{path: '/tmp/x'}, {candidates: ['replacement']}, {updatedAt: 'fake'}, {rating: 'perfect'}, {selectedCandidate: 2}, {opinion: 'a'.repeat(4001)}, {ownReply: 'a'.repeat(2001)}]) {
    await assert.rejects(saveReviewFeedback(f.dataPath, feedback('post_123', fields), f.options));
  }
  const pollution = JSON.parse('{"itemId":"post_123","__proto__":{"polluted":true}}');
  await assert.rejects(saveReviewFeedback(f.dataPath, pollution, f.options));
  assert.equal({}.polluted, undefined);
});

test('feedback body and both fixed filenames are bounded', async t => {
  const f = await fixture(t);
  await assert.rejects(saveReviewFeedback(f.dataPath, feedback('post_123', {opinion: 'a'.repeat(MAX_REVIEW_FEEDBACK_BYTES + 1)}), f.options), error => error.status === 413);
  await assert.rejects(loadReviewData('review-data.json'), error => error.code === 'REVIEW_PATH');
  await assert.rejects(loadReviewData(join(f.dir, 'secret.json'), f.options), error => error.code === 'REVIEW_PATH');
  await assert.rejects(saveReviewFeedback(f.dataPath, feedback(), {feedbackPath: join(f.dir, 'other.json')}), error => error.code === 'REVIEW_PATH');
});

test('feedback containing HTML is stored as inert text without changing source content', async t => {
  const f = await fixture(t);
  const opinion = '<img src=x onerror="window.pwned=true"><script>alert(1)</script>';
  await saveReviewFeedback(f.dataPath, feedback('post_123', {opinion}), f.options);
  const stored = await loadReviewData(f.dataPath, f.options);
  assert.equal(stored.feedback.post_123.opinion, opinion);
  assert.equal(stored.items[0].source.text, item().source.text);
});

test('sample validation rejects executable source URLs, duplicate IDs, fake pending candidates and excess candidates', async t => {
  for (const mutation of [
    sample => { sample.source.url = 'javascript:alert(1)'; },
    sample => { sample.source.url = 'https://x.com.attacker.test/post'; },
    sample => { sample.generation.candidates.push({text: 'third'}); },
    sample => { sample.generation.status = 'pending'; },
  ]) {
    const sample = item(); mutation(sample);
    const f = await fixture(t, [sample]);
    await assert.rejects(loadReviewData(f.dataPath, f.options));
  }
  const duplicates = await fixture(t, [item(), item()]);
  await assert.rejects(loadReviewData(duplicates.dataPath, duplicates.options));
});

test('comparison metadata is optional, strictly bounded, and retained without changing original feedback', async t => {
  const original = item('original');
  const compared = {...item('comparison_1'), comparison: {labels: ['旧版', '新版'], sourceItemId: 'original'}};
  const f = await fixture(t, [original, compared]);
  const savedOriginal = (await saveReviewFeedback(f.dataPath, feedback('original', {opinion: '顺着原作者的兴奋接话。'}), f.options)).feedback;
  const current = await loadReviewData(f.dataPath, f.options);
  assert.equal(current.items[0].comparison, undefined);
  assert.deepEqual(current.items[1].comparison, compared.comparison);
  await saveReviewFeedback(f.dataPath, feedback('comparison_1', {selectedCandidate: 1, opinion: '新版更自然。'}), f.options);
  const loaded = await loadReviewData(f.dataPath, f.options);
  assert.deepEqual(loaded.feedback.original, savedOriginal);
  assert.equal(loaded.feedback.comparison_1.selectedCandidate, 1);
});

test('comparison metadata rejects unknown fields, bad IDs, invalid labels and incomplete pairs', async t => {
  for (const comparison of [
    null, [], {},
    {labels: ['旧版', '新版'], sourceItemId: 'original', html: '<img src=x>'},
    {labels: ['旧版', '新版'], sourceItemId: '../original'},
    {labels: ['旧版', '新版'], sourceItemId: '__proto__'},
    {labels: ['旧版', '新版'], sourceItemId: 'post_123'},
    {labels: ['旧版'], sourceItemId: 'original'},
    {labels: ['旧版', '新版', '第三版'], sourceItemId: 'original'},
    {labels: ['旧版', ' '.repeat(5)], sourceItemId: 'original'},
    {labels: ['旧版', '旧版'], sourceItemId: 'original'},
    {labels: ['旧版', '新'.repeat(21)], sourceItemId: 'original'},
    {labels: ['旧版', {text: '新版'}], sourceItemId: 'original'},
  ]) {
    const f = await fixture(t, [{...item(), comparison}]);
    await assert.rejects(loadReviewData(f.dataPath, f.options));
  }
  for (const generation of [
    {...item().generation, candidates: [item().generation.candidates[0]]},
    {status: 'pending', candidates: []},
    {status: 'failed', candidates: [], error: '真实失败'},
  ]) {
    const f = await fixture(t, [{...item(), generation, comparison: {labels: ['旧版', '新版'], sourceItemId: 'original'}}]);
    await assert.rejects(loadReviewData(f.dataPath, f.options));
  }
});

test('feedback file symlinks are not followed', async t => {
  const f = await fixture(t);
  const target = join(f.dir, 'target.json');
  const link = join(f.dir, 'review-feedback.json');
  const original = '{"version":1,"feedback":{}}';
  await writeFile(target, original);
  await symlink(target, link);
  await assert.rejects(saveReviewFeedback(f.dataPath, feedback(), {feedbackPath: link}), error => error.code === 'REVIEW_FILE');
  assert.equal(await readFile(target, 'utf8'), original);
});

test('retired sample feedback survives a refreshed sample file without becoming current feedback', async t => {
  const f = await fixture(t, [item('old')]);
  await saveReviewFeedback(f.dataPath, feedback('old'), f.options);
  await writeFile(f.dataPath, JSON.stringify({version: 1, items: [item('new')]}));
  assert.deepEqual(Object.keys((await loadReviewData(f.dataPath, f.options)).feedback), []);
  await saveReviewFeedback(f.dataPath, feedback('new'), f.options);
  const raw = JSON.parse(await readFile(f.feedbackPath, 'utf8'));
  assert.equal(raw.feedback.old.opinion, '结尾太像鸡汤。');
  assert.equal(raw.feedback.new.opinion, '结尾太像鸡汤。');
});

const html = await readFile(join(root, 'review.html'), 'utf8');
const script = await readFile(join(root, 'review.js'), 'utf8');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 2500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) assert.fail('condition timed out');
    await tick(10);
  }
}

async function ui(t, {items = [item()], initialFeedback = {}, failSave = false, initialBackup = null, token = 'review-session-for-test'} = {}) {
  const dom = new JSDOM(html, {url: 'http://127.0.0.1:8769/review', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const calls = [];
  const saved = {...initialFeedback};
  let rejecting = failSave;
  dom.window.REVIEW_TOKEN = token;
  if (initialBackup) dom.window.localStorage.setItem('jieyiju-review-feedback-backup-v1', JSON.stringify(initialBackup));
  dom.window.fetch = async (url, options) => {
    calls.push({url, options});
    assert.equal(options.headers['X-Review-Token'], token);
    if (url === '/review-data') return {ok: true, json: async () => ({items, feedback: saved})};
    assert.equal(url, '/review-feedback');
    assert.equal(options.method, 'POST');
    if (rejecting) throw new Error('test offline');
    const input = JSON.parse(options.body);
    saved[input.itemId] = {...input, updatedAt: '2026-10-12T12:00:00Z'};
    return {ok: true, json: async () => ({feedback: saved[input.itemId]})};
  };
  dom.window.eval(script);
  await until(() => dom.window.document.querySelector('.review-card') || !dom.window.document.getElementById('page-error').hidden || !dom.window.document.getElementById('empty').hidden);
  return {dom, window: dom.window, document: dom.window.document, calls, saved, allowSave: () => { rejecting = false; }};
}

test('workbench renders explicit historical source, understanding and gaps, with no automatic generation', async t => {
  const u = await ui(t);
  assert.match(u.document.body.textContent, /用户截图 · 历史样例/);
  assert.match(u.document.body.textContent, /这是在反讽和吐槽加班/);
  assert.match(u.document.body.textContent, /未重新核验原帖/);
  assert.equal(u.document.querySelectorAll('.candidate').length, 2);
  assert.equal(u.document.querySelector('.source-link').href, 'https://x.com/example/status/123');
  assert.equal(u.calls.length, 1);
  assert.equal(u.calls[0].url, '/review-data');
  assert.equal(u.window.REVIEW_TOKEN, undefined);
});

test('opinion textareas stay editable and retain focus and cursor when automatic saving completes', async t => {
  const u = await ui(t);
  const input = u.document.getElementById('opinion-post_123');
  input.focus(); input.value = '这不是求建议，是在吐槽。'; input.setSelectionRange(4, 4);
  input.dispatchEvent(new u.window.Event('input', {bubbles: true}));
  await until(() => u.saved.post_123?.opinion === input.value);
  assert.equal(u.document.getElementById('opinion-post_123'), input);
  assert.equal(u.document.activeElement, input);
  assert.equal(input.selectionStart, 4);
  assert.equal(input.selectionEnd, 4);
  assert.match(u.document.querySelector('.save-status').textContent, /已保存到本机文件/);
  assert.equal(u.document.getElementById('reviewed-count').textContent, '1');
});

test('candidate reuse replaces own reply once and keeps exactly one preference', async t => {
  const u = await ui(t);
  const buttons = u.document.querySelectorAll('.candidate-actions button');
  buttons[0].click(); buttons[0].click();
  assert.equal(u.document.getElementById('ownReply-post_123').value, item().generation.candidates[0].text);
  buttons[1].click();
  assert.equal(u.document.getElementById('ownReply-post_123').value, item().generation.candidates[1].text);
  assert.equal(u.document.querySelectorAll('[data-candidate]:checked').length, 1);
  u.document.getElementById('ownReply-post_123').dispatchEvent(new u.window.Event('blur'));
  await until(() => u.saved.post_123?.selectedCandidate === 1);
});

test('comparison renders both labeled replies, keeps original opinion separate, and exports the pairing', async t => {
  const original = item('original');
  const compared = {...item('comparison_1'), comparison: {labels: ['旧版', '新版'], sourceItemId: 'original'}};
  compared.generation.candidates[1].text = '这班上得，夜宵摊都该问你收摊了没😂';
  const oldFeedback = feedback('original', {opinion: '回复别太工整。', ownReply: '这才几点，再加会儿😂'});
  const u = await ui(t, {items: [original, compared], initialFeedback: {original: oldFeedback}});
  const card = u.document.querySelector('[data-item-id="comparison_1"]');
  assert.equal(card.classList.contains('comparison-card'), true);
  assert.deepEqual([...card.querySelectorAll('.candidate-label')].map(node => node.textContent), ['旧版', '新版']);
  assert.equal(card.querySelector('.comparison-candidates').children.length, 2);
  assert.match(card.querySelector('.previous-feedback').textContent, /回复别太工整/);
  assert.equal(u.document.getElementById('opinion-comparison_1').value, '');
  const choices = card.querySelectorAll('[data-candidate]');
  choices[0].checked = true;
  choices[0].dispatchEvent(new u.window.Event('change', {bubbles: true}));
  choices[1].checked = true;
  choices[1].dispatchEvent(new u.window.Event('change', {bubbles: true}));
  assert.equal(choices[0].checked, false);
  assert.equal(choices[1].checked, true);
  await until(() => u.saved.comparison_1?.selectedCandidate === 1);
  assert.deepEqual(u.saved.original, oldFeedback);
  let exported;
  u.window.Blob = class { constructor(parts) { exported = JSON.parse(parts.join('')); } };
  u.window.URL.createObjectURL = () => 'blob:review-test';
  u.window.URL.revokeObjectURL = () => {};
  u.document.addEventListener('click', event => { if (event.target.tagName === 'A') event.preventDefault(); });
  u.document.getElementById('export').click();
  assert.deepEqual(exported.items[1].comparison, compared.comparison);
  assert.equal(exported.items[1].feedback.selectedCandidate, 1);
  assert.equal(exported.items[0].feedback.opinion, oldFeedback.opinion);
});

test('comparison labels and previous feedback remain inert text', async t => {
  const compared = {...item('comparison_1'), comparison: {labels: ['<img src=x>', '<svg onload=x>'], sourceItemId: 'original'}};
  const u = await ui(t, {items: [item('original'), compared], initialFeedback: {original: feedback('original', {opinion: '<iframe src="evil">'})}});
  const card = u.document.querySelector('[data-item-id="comparison_1"]');
  assert.equal(card.querySelectorAll('img,svg,iframe').length, 0);
  assert.equal(card.querySelector('.candidate-label').textContent, '<img src=x>');
  assert.match(card.querySelector('.previous-feedback').textContent, /<iframe/);
});

test('selection-only original feedback shows the original candidate without claiming approval or copying the preference', async t => {
  const original = item('original');
  original.generation.candidates[1].text = '<img src=x> 上次点选的原句';
  const compared = {...item('comparison_1'), comparison: {labels: ['旧版', '新版'], sourceItemId: 'original'}};
  const oldFeedback = feedback('original', {rating: '', opinion: '', ownReply: '', selectedCandidate: 1});
  const u = await ui(t, {items: [original, compared], initialFeedback: {original: oldFeedback}});
  const card = u.document.querySelector('[data-item-id="comparison_1"]');
  assert.equal(card.querySelector('.previous-selection').textContent, '上次点选：候选 2（点选不等于认可）');
  assert.equal(card.querySelector('.previous-selected-text').textContent, original.generation.candidates[1].text);
  assert.equal(card.querySelectorAll('img').length, 0);
  assert.equal(card.querySelectorAll('[data-candidate]:checked').length, 0);
  assert.equal(u.document.getElementById('ownReply-comparison_1').value, '');
  assert.deepEqual(u.saved.original, oldFeedback);
  assert.equal(u.calls.filter(call => call.url === '/review-feedback').length, 0);
});

test('original comparison selection is displayed only for an integer within the original candidate range', async t => {
  for (const selectedCandidate of [-1, 2, '1', null]) {
    const compared = {...item('comparison_1'), comparison: {labels: ['旧版', '新版'], sourceItemId: 'original'}};
    const u = await ui(t, {items: [item('original'), compared], initialFeedback: {original: feedback('original', {selectedCandidate})}});
    const card = u.document.querySelector('[data-item-id="comparison_1"]');
    assert.equal(card.querySelector('.previous-selection'), null);
    assert.equal(card.querySelector('.previous-selected-text'), null);
  }
});

test('save failure explicitly distinguishes browser backup from disk and can recover by retry', async t => {
  const u = await ui(t, {failSave: true});
  const input = u.document.getElementById('opinion-post_123');
  input.value = '先看图，不要凭正文猜。';
  input.dispatchEvent(new u.window.Event('input', {bubbles: true}));
  input.dispatchEvent(new u.window.Event('blur'));
  await until(() => u.document.querySelector('.save-status').classList.contains('failed'));
  assert.match(u.document.querySelector('.save-status').textContent, /尚未写入文件，已暂存在浏览器/);
  assert.equal(u.document.getElementById('retry-save').hidden, false);
  assert.equal(JSON.parse(u.window.localStorage.getItem('jieyiju-review-feedback-backup-v1')).post_123.input.opinion, input.value);
  u.allowSave(); u.document.getElementById('retry-save').click();
  await until(() => u.document.querySelector('.save-status').classList.contains('saved'));
  assert.equal(u.saved.post_123.opinion, input.value);
  assert.deepEqual(Object.keys(JSON.parse(u.window.localStorage.getItem('jieyiju-review-feedback-backup-v1'))), []);
});

test('browser backup is restored into the right existing item and synchronized to disk', async t => {
  const u = await ui(t, {initialBackup: {post_123: {input: feedback('post_123', {opinion: '恢复的意见'}), savedAt: '2026-10-12T00:00:00Z'}, missing: {input: feedback('missing')}}});
  await until(() => u.saved.post_123?.opinion === '恢复的意见');
  assert.equal(u.document.getElementById('opinion-post_123').value, '恢复的意见');
  assert.equal(u.saved.missing, undefined);
});

test('source, candidate, understanding and feedback HTML is rendered as text without execution', async t => {
  const sample = item();
  sample.source.text = '<img src=x onerror="window.pwned=true">';
  sample.generation.summary = '<script>window.pwned=true</script>';
  sample.generation.candidates[0].text = '<iframe src="https://evil.test"></iframe>';
  sample.source.url = 'javascript:window.pwned=true';
  const u = await ui(t, {items: [sample], initialFeedback: {post_123: feedback('post_123', {opinion: '<svg onload="window.pwned=true">'})}});
  assert.equal(u.document.querySelectorAll('img,iframe,svg').length, 0);
  assert.equal(u.document.querySelectorAll('script').length, 2);
  assert.equal(u.document.querySelector('.source-link').tagName, 'SPAN');
  assert.match(u.document.querySelector('.post-text').textContent, /<img/);
  assert.equal(u.window.pwned, undefined);
});

test('pending and real failed generations show truthful status without placeholder replies', async t => {
  const pending = item('pending'); pending.generation = {status: 'pending'};
  const failed = item('failed'); failed.generation = {status: 'failed', error: 'Codex 请求未完成'};
  const u = await ui(t, {items: [pending, failed]});
  assert.equal(u.document.querySelectorAll('.candidate').length, 0);
  assert.match(u.document.body.textContent, /尚未生成/);
  assert.match(u.document.body.textContent, /真实生成失败：Codex 请求未完成/);
  assert.equal(u.document.getElementById('generated-count').textContent, '0');
});

test('missing session token fails locally without calling API', async t => {
  const u = await ui(t, {token: ''});
  assert.equal(u.calls.length, 0);
  assert.match(u.document.getElementById('page-error').textContent, /会话没有建立/);
});
