(() => {
  'use strict';
  const token = typeof window.REVIEW_TOKEN === 'string' ? window.REVIEW_TOKEN : '';
  delete window.REVIEW_TOKEN;
  const backupKey = 'jieyiju-review-feedback-backup-v1';
  const state = {items: [], feedback: Object.create(null), filter: 'all', loaded: false};
  const drafts = new Map();
  const revisions = new Map();
  const timers = new Map();
  const inFlight = new Map();
  const saveLabels = new Map();
  const dirty = new Set();
  const ratings = [['usable', '能用'], ['okay', '一般'], ['misunderstood', '理解错了'], ['unlike-me', '不自然']];
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
  const $ = id => document.getElementById(id);
  const text = value => typeof value === 'string' ? value : '';
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const button = (label, className, action) => {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };

  function feedbackInput(item, value = {}) {
    return {
      itemId: item.id,
      rating: ratings.some(([id]) => id === value.rating) ? value.rating : '',
      opinion: text(value.opinion).slice(0, 4000),
      ownReply: text(value.ownReply).slice(0, 2000),
      selectedCandidate: Number.isInteger(value.selectedCandidate) && value.selectedCandidate >= 0 && value.selectedCandidate < (item.generation?.candidates?.length ?? 0) ? value.selectedCandidate : null,
    };
  }

  function hasFeedback(value) {
    return Boolean(value && (value.rating || value.opinion?.trim() || value.ownReply?.trim() || value.selectedCandidate !== null && value.selectedCandidate !== undefined));
  }

  function backups() {
    try {
      const raw = localStorage.getItem(backupKey);
      if (!raw || raw.length > 2_000_000) return Object.create(null);
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : Object.create(null);
    } catch { return Object.create(null); }
  }

  function backup(itemId, value) {
    try {
      const values = backups();
      if (value === null) delete values[itemId];
      else values[itemId] = {input: value, savedAt: new Date().toISOString()};
      localStorage.setItem(backupKey, JSON.stringify(values));
      return true;
    } catch { return false; }
  }

  function saveState(itemId, content, mode = '') {
    const label = saveLabels.get(itemId);
    if (label) { label.textContent = content; label.className = `save-status ${mode}`; }
    $('retry-save').hidden = dirty.size === 0;
    $('global-status').textContent = dirty.size ? `${dirty.size} 条意见尚未写入文件` : state.loaded ? '意见保存到本机文件' : '正在读取样例…';
  }

  async function request(path, options = {}) {
    if (!token) throw new Error('试评会话没有建立，请重新打开本机试评页面。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: {'X-Review-Token': token, ...(options.headers ?? {})},
      });
      const result = await response.json();
      if (!response.ok) throw new Error(text(result.error) || '本机服务没有完成保存。');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('本机服务没有及时响应。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function queueSave(itemId) {
    revisions.set(itemId, (revisions.get(itemId) ?? 0) + 1);
    dirty.add(itemId);
    const backedUp = backup(itemId, drafts.get(itemId));
    saveState(itemId, backedUp ? '正在保存…' : '正在保存；浏览器备用暂存不可用。');
    clearTimeout(timers.get(itemId));
    timers.set(itemId, setTimeout(() => { timers.delete(itemId); void commit(itemId); }, 450));
    updateCounts();
  }

  function commit(itemId) {
    clearTimeout(timers.get(itemId));
    timers.delete(itemId);
    if (!dirty.has(itemId)) return inFlight.get(itemId) ?? Promise.resolve();
    const revision = revisions.get(itemId);
    const input = {...drafts.get(itemId)};
    const previous = inFlight.get(itemId) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(async () => {
      try {
        const result = await request('/review-feedback', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
        });
        if (result.feedback?.itemId !== itemId) throw new Error('本机服务返回了不同的样例编号。');
        state.feedback[itemId] = {...input, updatedAt: text(result.feedback.updatedAt)};
        if (revisions.get(itemId) === revision) {
          dirty.delete(itemId);
          backup(itemId, null);
          saveState(itemId, '已保存到本机文件', 'saved');
        }
      } catch (error) {
        if (revisions.get(itemId) === revision) {
          const backedUp = backup(itemId, input);
          saveState(itemId, backedUp ? '尚未写入文件，已暂存在浏览器。请点击“重新保存意见”。' : '保存失败，浏览器备用暂存也不可用。请保持页面打开并重试。', 'failed');
          $('page-error').textContent = text(error.message) || '意见保存失败。';
          $('page-error').hidden = false;
        }
      } finally {
        updateCounts();
      }
    });
    inFlight.set(itemId, promise);
    promise.finally(() => { if (inFlight.get(itemId) === promise) inFlight.delete(itemId); });
    return promise;
  }

  async function flush() {
    await Promise.all([...dirty].map(commit));
  }

  function safeSourceUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : '';
    } catch { return ''; }
  }

  function makeField(item, label, name, placeholder, limit) {
    const fragment = document.createDocumentFragment();
    const id = `${name}-${item.id}`;
    const labelNode = el('label', 'field-label', label);
    labelNode.htmlFor = id;
    const input = el('textarea');
    input.id = id;
    input.name = name;
    input.rows = name === 'opinion' ? 4 : 3;
    input.maxLength = limit;
    input.placeholder = placeholder;
    input.value = drafts.get(item.id)[name];
    input.addEventListener('input', () => { drafts.get(item.id)[name] = input.value; queueSave(item.id); });
    input.addEventListener('blur', () => { if (dirty.has(item.id)) void commit(item.id); });
    fragment.append(labelNode, input, el('p', 'field-note', name === 'opinion' ? '写哪里没读懂、哪句话别扭，越具体越好。' : '可以直接改成你愿意发的版本。可以留空，不会发送。'));
    return fragment;
  }

  function renderCard(item, index) {
    const source = item.source ?? {};
    const generation = item.generation ?? {status: 'pending'};
    const comparison = item.comparison;
    const comparing = comparison && validId(comparison.sourceItemId) && comparison.sourceItemId !== item.id && Array.isArray(comparison.labels) && comparison.labels.length === 2 && comparison.labels.every(label => typeof label === 'string' && label.trim() && label.length <= 20) && comparison.labels[0] !== comparison.labels[1] && generation.status === 'succeeded' && generation.candidates?.length === 2;
    const card = el('article', `review-card${comparing ? ' comparison-card' : ''}`);
    card.dataset.itemId = item.id;
    const header = el('header', 'card-header');
    header.append(el('span', 'card-number', String(index + 1).padStart(2, '0')));
    const historical = source.type === 'historical-screenshot';
    const type = source.type === 'timeline' ? '新时间线' : historical ? '用户截图 · 历史样例' : '来源未注明';
    header.append(el('span', `source-badge ${historical ? 'history' : source.type === 'timeline' ? '' : 'unknown'}`, type));
    if (comparing) header.append(el('span', 'comparison-badge', '同题对比'));
    const url = safeSourceUrl(source.url);
    if (url) {
      const anchor = el('a', 'source-link', '打开原帖 ↗');
      anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      header.append(anchor);
    } else header.append(el('span', 'source-link', '原帖链接未提供'));
    const body = el('div', 'card-body');
    const reading = el('section', 'reading');
    reading.setAttribute('aria-label', `样例 ${index + 1} 的原帖与候选`);
    reading.append(el('p', 'section-label', '原帖'));
    if (source.author) reading.append(el('p', 'author', text(source.author)));
    reading.append(el('p', 'post-text', text(source.text) || '未保存原帖正文。'));
    const sourceNote = historical ? '来自你此前提供的截图，未重新核验当前帖子。' : source.type === 'timeline' ? '来自本次时间线采集。' : '没有记录来源类型。';
    reading.append(el('p', 'source-meta', `${sourceNote}${source.capturedAt ? ` 采集记录：${text(source.capturedAt)}` : ''}`));
    if (comparing) {
      const previous = state.feedback[comparison.sourceItemId];
      if (hasFeedback(previous)) {
        const history = el('details', 'previous-feedback');
        history.append(el('summary', '', '你上次的意见（原记录保留）'));
        const rating = ratings.find(([id]) => id === previous.rating);
        if (rating) history.append(el('p', '', `上次评价：${rating[1]}`));
        const original = state.items.find(entry => entry.id === comparison.sourceItemId);
        const originalCandidates = original?.generation?.candidates;
        const selected = previous.selectedCandidate;
        if (Array.isArray(originalCandidates) && Number.isInteger(selected) && selected >= 0 && selected < originalCandidates.length) {
          history.append(el('p', 'previous-selection', `上次点选：候选 ${selected + 1}（点选不等于认可）`));
          history.append(el('p', 'previous-selected-text', text(originalCandidates[selected]?.text)));
        }
        if (previous.opinion) history.append(el('p', '', `意见：${text(previous.opinion)}`));
        if (previous.ownReply) history.append(el('p', '', `你的改写：${text(previous.ownReply)}`));
        reading.append(history);
      }
    }
    if (generation.status === 'succeeded') {
      reading.append(el('p', 'section-label', 'AI 对原帖的理解'));
      const tags = el('div', 'tags');
      for (const tag of (Array.isArray(generation.tags) ? generation.tags : []).slice(0, 10)) tags.append(el('span', 'tag', text(tag)));
      if (tags.childNodes.length) reading.append(tags);
      const interpretation = el('div', 'interpretation');
      interpretation.append(el('p', '', text(generation.summary) || '这次生成没有返回原帖解读。'));
      reading.append(interpretation);
      const gaps = Array.isArray(generation.gaps) ? generation.gaps : [];
      if (gaps.length) {
        const block = el('div', 'gaps');
        block.append(el('strong', '', '仍有这些信息缺口'));
        for (const gap of gaps.slice(0, 8)) block.append(el('p', '', text(gap)));
        reading.append(block);
      }
      reading.append(el('p', 'section-label', comparing ? '同一原帖，哪一版更愿意发？' : '回复候选'));
      const candidates = Array.isArray(generation.candidates) ? generation.candidates.slice(0, 2) : [];
      const candidateList = el('div', comparing ? 'comparison-candidates' : 'candidates');
      candidates.forEach((candidate, candidateIndex) => {
        const block = el('div', 'candidate');
        if (comparing) block.dataset.comparisonIndex = String(candidateIndex);
        const top = el('div', 'candidate-top');
        top.append(el('span', 'candidate-label', comparing ? comparison.labels[candidateIndex] : `候选 ${candidateIndex + 1}`));
        const choice = el('label', 'candidate-choice');
        const check = el('input');
        check.type = 'checkbox';
        check.checked = drafts.get(item.id).selectedCandidate === candidateIndex;
        check.dataset.candidate = String(candidateIndex);
        check.addEventListener('change', () => {
          drafts.get(item.id).selectedCandidate = check.checked ? candidateIndex : null;
          for (const other of reading.querySelectorAll('[data-candidate]')) other.checked = Number(other.dataset.candidate) === drafts.get(item.id).selectedCandidate;
          queueSave(item.id);
        });
        choice.append(check, document.createTextNode('我更倾向这句'));
        top.append(choice);
        block.append(top, el('p', '', text(candidate.text)));
        const actions = el('div', 'candidate-actions');
        actions.append(button('以这句为基础修改', 'text-button', () => {
          const input = $(`ownReply-${item.id}`);
          input.value = text(candidate.text).slice(0, 2000);
          drafts.get(item.id).ownReply = input.value;
          drafts.get(item.id).selectedCandidate = candidateIndex;
          for (const other of reading.querySelectorAll('[data-candidate]')) other.checked = Number(other.dataset.candidate) === candidateIndex;
          queueSave(item.id);
          input.focus();
        }));
        block.append(actions); candidateList.append(block);
      });
      if (candidates.length) reading.append(candidateList);
      if (!candidates.length) reading.append(el('p', 'generation-state', '没有回复候选。这条原帖可能需要先补充语境。'));
    } else if (generation.status === 'failed') {
      reading.append(el('p', 'generation-state failed', `真实生成失败：${text(generation.error) || '未记录具体原因。'} 没有使用占位回复。`));
    } else {
      reading.append(el('p', 'generation-state', '尚未生成。这里暂时没有 AI 解读和回复候选。'));
    }
    if (Number.isFinite(generation.durationMs)) reading.append(el('p', 'generation-time', `${comparing ? `${comparison.labels[1]}生成耗时` : '本次生成耗时'} ${(generation.durationMs / 1000).toFixed(1)} 秒`));
    const feedback = el('section', 'feedback-panel');
    feedback.append(el('h2', 'feedback-heading', '你的看法'), el('p', 'feedback-hint', comparing ? '先选更愿意发的一句，再评价这次新版；也可以说明两句都不满意。新意见单独保存。' : '选一个最主要的问题，再写具体意见。'));
    const fieldset = el('fieldset', 'rating');
    fieldset.append(el('legend', '', comparing ? '这次新版怎么样？' : '这一条怎么样？'));
    const options = el('div', 'rating-options');
    for (const [rating, label] of ratings) {
      const option = el('label', 'rating-option');
      const radio = el('input');
      radio.type = 'radio'; radio.name = `rating-${item.id}`; radio.value = rating;
      radio.checked = drafts.get(item.id).rating === rating;
      radio.addEventListener('change', () => { drafts.get(item.id).rating = rating; queueSave(item.id); });
      option.append(radio, el('span', '', label)); options.append(option);
    }
    fieldset.append(options); feedback.append(fieldset);
    feedback.append(makeField(item, '我的意见', 'opinion', '例如：作者是在自嘲，你把它当成了求建议；这句结尾像鸡汤。', 4000));
    feedback.append(makeField(item, '我会这样回复', 'ownReply', '写一句你自己愿意发的回复，或修改左边的候选。', 2000));
    const status = el('p', 'save-status', dirty.has(item.id) ? '这条意见尚未写入文件。' : hasFeedback(drafts.get(item.id)) ? '已保存到本机文件' : '填写后会自动保存。');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    saveLabels.set(item.id, status); feedback.append(status);
    body.append(reading, feedback); card.append(header, body); return card;
  }

  function updateCounts() {
    $('total-count').textContent = String(state.items.length);
    $('generated-count').textContent = String(state.items.filter(item => item.generation?.status === 'succeeded').length);
    $('reviewed-count').textContent = String(state.items.filter(item => hasFeedback(drafts.get(item.id))).length);
    $('export').disabled = !state.loaded || !state.items.length;
    $('retry-save').hidden = dirty.size === 0;
  }

  function render() {
    saveLabels.clear();
    const fragment = document.createDocumentFragment();
    let visible = 0;
    state.items.forEach((item, index) => {
      const reviewed = hasFeedback(drafts.get(item.id));
      if (state.filter === 'reviewed' && !reviewed || state.filter === 'unreviewed' && reviewed) return;
      fragment.append(renderCard(item, index)); visible++;
    });
    $('items').replaceChildren(fragment);
    $('empty').hidden = visible !== 0;
    $('empty-title').textContent = state.items.length ? '这个筛选下没有样例' : '还没有可试评的原帖';
    $('empty-description').textContent = state.items.length ? '切换到“全部”，或继续评价其他样例。' : '真实样例录入后会出现在这里。没有生成成功的内容会明确显示状态。';
    updateCounts();
  }

  async function load() {
    $('reload').disabled = true;
    $('page-error').hidden = true;
    $('global-status').textContent = '正在读取样例…';
    try {
      await flush();
      const result = await request('/review-data');
      if (!Array.isArray(result.items) || result.items.length > 500 || result.items.some(item => !validId(item?.id)) || new Set(result.items.map(item => item.id)).size !== result.items.length) throw new Error('本机样例格式不正确。');
      state.items = result.items;
      state.feedback = result.feedback && typeof result.feedback === 'object' && !Array.isArray(result.feedback) ? result.feedback : Object.create(null);
      const savedBackups = backups();
      for (const item of state.items) {
        if (!dirty.has(item.id)) drafts.set(item.id, feedbackInput(item, state.feedback[item.id]));
        const saved = savedBackups[item.id];
        if (saved?.input?.itemId === item.id && !dirty.has(item.id)) {
          drafts.set(item.id, feedbackInput(item, saved.input));
          revisions.set(item.id, (revisions.get(item.id) ?? 0) + 1);
          dirty.add(item.id);
        }
      }
      state.loaded = true;
      render();
      $('global-status').textContent = dirty.size ? `${dirty.size} 条意见恢复自浏览器，正在写入文件…` : '意见保存到本机文件';
      await flush();
    } catch (error) {
      $('page-error').textContent = text(error.message) || '无法读取本机试评样例。请确认后台服务正在运行，再刷新。';
      $('page-error').hidden = false;
      $('global-status').textContent = '读取失败';
      if (!state.loaded) { $('items').replaceChildren(); $('empty').hidden = true; }
    } finally { $('reload').disabled = false; }
  }

  function exportFeedback() {
    const output = {
      version: 1, exportedAt: new Date().toISOString(),
      items: state.items.map(item => ({...item, feedback: {...feedbackInput(item, drafts.get(item.id)), savedToDisk: Boolean(state.feedback[item.id]) && !dirty.has(item.id), updatedAt: text(state.feedback[item.id]?.updatedAt)}})),
    };
    const blob = new Blob([`${JSON.stringify(output, null, 2)}\n`], {type: 'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = el('a'); anchor.href = url; anchor.download = `X Comment Assistant-回复试评-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('global-status').textContent = dirty.size ? '已导出；其中包含尚未写入文件的意见。' : '已导出原帖、候选和你的反馈。';
  }

  $('reload').addEventListener('click', () => void load());
  $('export').addEventListener('click', exportFeedback);
  $('retry-save').addEventListener('click', async () => {
    $('page-error').hidden = true;
    await flush();
  });
  for (const filter of document.querySelectorAll('[data-filter]')) filter.addEventListener('click', () => {
    state.filter = filter.dataset.filter;
    for (const node of document.querySelectorAll('[data-filter]')) node.setAttribute('aria-pressed', String(node === filter));
    render();
  });
  window.addEventListener('online', () => { if (dirty.size) void flush(); });
  window.addEventListener('beforeunload', event => {
    if (dirty.size) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty.size) void flush(); });
  void load();
})();
