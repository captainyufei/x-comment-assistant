import { constants } from 'node:fs';
import { open, rename, rm, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_REVIEW_FEEDBACK_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 500;
const RATINGS = new Set(['', 'usable', 'okay', 'misunderstood', 'unlike-me']);
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const writes = new Map();

export class ReviewStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

function fail(message, code = 'REVIEW_INVALID', status = 400) {
  throw new ReviewStoreError(code, message, status);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function checkedPath(path, expectedName) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || basename(path) !== expectedName) {
    fail('试评文件路径配置无效。', 'REVIEW_PATH', 500);
  }
  return path;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !RESERVED_IDS.has(value);
}

function string(value, max, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`${label}格式或长度不正确。`);
  return value;
}

function strings(value, maxCount, maxLength, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxCount) fail(`${label}格式或数量不正确。`);
  return value.map(entry => string(entry, maxLength, label));
}

function sourceUrl(value) {
  const text = string(value, 800, '原帖链接');
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { fail('原帖链接格式不正确。'); }
  if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port) {
    fail('原帖链接必须为 X 的 HTTPS 链接。');
  }
  return url.href;
}

function normalizeItem(input) {
  if (!record(input) || !validId(input.id)) fail('试评样例编号无效。');
  const source = input.source;
  const generation = input.generation;
  if (!record(source) || !record(generation)) fail('试评样例缺少来源或生成状态。');
  const types = ['timeline', 'historical-screenshot', 'unknown'];
  const statuses = ['pending', 'succeeded', 'failed'];
  if (!types.includes(source.type)) fail('样例来源类型无效。');
  if (!statuses.includes(generation.status)) fail('生成状态无效。');
  const candidates = generation.candidates ?? [];
  if (!Array.isArray(candidates) || candidates.length > 2) fail('每条样例最多保存两条回复候选。');
  if (generation.status !== 'succeeded' && candidates.length) fail('未成功生成的样例不能带回复候选。');
  const result = {
    id: input.id,
    source: {
      type: source.type,
      url: sourceUrl(source.url),
      author: string(source.author, 160, '作者'),
      capturedAt: string(source.capturedAt, 100, '采集时间'),
      text: string(source.text, 12_000, '原帖正文'),
    },
    generation: {
      status: generation.status,
      summary: string(generation.summary, 1_200, '原帖解读'),
      tags: strings(generation.tags, 10, 100, '解读标签'),
      gaps: strings(generation.gaps, 8, 500, '上下文缺口'),
      candidates: candidates.map(candidate => {
        if (!record(candidate)) fail('回复候选格式无效。');
        const text = string(candidate.text, 2_000, '回复候选');
        if (!text.trim()) fail('回复候选不能为空。');
        return {text};
      }),
      error: string(generation.error, 1_000, '生成错误'),
    },
  };
  if (generation.durationMs !== undefined) {
    if (!Number.isFinite(generation.durationMs) || generation.durationMs < 0 || generation.durationMs > 3_600_000) fail('生成耗时无效。');
    result.generation.durationMs = generation.durationMs;
  }
  if (input.comparison !== undefined) {
    const comparison = input.comparison;
    if (!record(comparison) || Object.keys(comparison).some(key => !['labels', 'sourceItemId'].includes(key))) fail('对比样例格式无效。');
    if (!validId(comparison.sourceItemId) || comparison.sourceItemId === input.id) fail('对比样例的原编号无效。');
    const labels = strings(comparison.labels, 2, 20, '对比标签');
    if (labels.length !== 2 || labels.some(label => !label.trim()) || labels[0] === labels[1]) fail('对比样例需要两个不同的标签。');
    if (generation.status !== 'succeeded' || candidates.length !== 2) fail('对比样例需要两条真实回复候选。');
    result.comparison = {labels, sourceItemId: comparison.sourceItemId};
  }
  return result;
}

async function readJson(path, empty) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('试评文件格式或大小无效。', 'REVIEW_FILE', 500);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) fail('试评文件过大。', 'REVIEW_FILE', 500);
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('试评文件无法读取，请检查 JSON 格式。', 'REVIEW_FILE', 500); }
    if (!record(data)) fail('试评文件格式无效。', 'REVIEW_FILE', 500);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT' && empty) return empty;
    if (error instanceof ReviewStoreError) throw error;
    fail('无法读取本机试评文件。', 'REVIEW_FILE', 500);
  } finally {
    await handle?.close();
  }
}

function feedbackFile(dataPath, options) {
  return checkedPath(options.feedbackPath ?? join(dirname(dataPath), 'review-feedback.json'), 'review-feedback.json');
}

function normalizeFeedback(input, items, {fromFile = false, allowArchived = false} = {}) {
  if (!record(input)) fail('意见格式无效。');
  const allowed = new Set(['itemId', 'rating', 'opinion', 'ownReply', 'selectedCandidate', ...(fromFile ? ['updatedAt'] : [])]);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('意见只能包含评级、看法和你的回复。');
  if (!validId(input.itemId)) fail('样例编号无效。', 'REVIEW_ITEM');
  const item = items.find(entry => entry.id === input.itemId);
  if (!item && !allowArchived) fail('该样例不存在，请刷新试评页。', 'REVIEW_ITEM', 404);
  const rating = input.rating ?? '';
  if (!RATINGS.has(rating)) fail('请选择有效评级。');
  const selected = input.selectedCandidate ?? null;
  if (selected !== null && (!Number.isInteger(selected) || selected < 0 || selected >= (item ? item.generation.candidates.length : 2))) {
    fail('选择的回复候选不存在。');
  }
  const result = {
    itemId: input.itemId,
    rating,
    opinion: string(input.opinion, 4_000, '你的意见'),
    ownReply: string(input.ownReply, 2_000, '你的回复'),
    selectedCandidate: selected,
  };
  if (fromFile) result.updatedAt = string(input.updatedAt, 100, '保存时间');
  return result;
}

export async function loadReviewData(dataPath, options = {}) {
  checkedPath(dataPath, 'review-data.json');
  const rawData = await readJson(dataPath);
  if (rawData.version !== 1 || !Array.isArray(rawData.items) || rawData.items.length > MAX_ITEMS) fail('试评样例文件格式无效。', 'REVIEW_FILE', 500);
  const items = rawData.items.map(normalizeItem);
  if (new Set(items.map(item => item.id)).size !== items.length) fail('试评样例编号重复。', 'REVIEW_FILE', 500);
  const rawFeedback = await readJson(feedbackFile(dataPath, options), {version: 1, feedback: {}});
  if (rawFeedback.version !== 1 || !record(rawFeedback.feedback) || Object.keys(rawFeedback.feedback).length > MAX_ITEMS) fail('试评意见文件格式无效。', 'REVIEW_FILE', 500);
  const feedback = Object.create(null);
  for (const [id, value] of Object.entries(rawFeedback.feedback)) {
    if (!validId(id) || !record(value) || value.itemId !== id) fail('试评意见编号无效。', 'REVIEW_FILE', 500);
    // A refreshed sample set can omit earlier samples. Keep their saved feedback on
    // disk, but do not expose it as if it belonged to a current visible sample.
    const normalized = normalizeFeedback(value, items, {fromFile: true, allowArchived: true});
    if (items.some(item => item.id === id)) feedback[id] = normalized;
  }
  return {version: 1, items, feedback};
}

async function atomicJson(path, input) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const bytes = Buffer.from(`${JSON.stringify(input, null, 2)}\n`);
  if (bytes.length > MAX_FILE_BYTES) fail('试评意见文件已满。', 'REVIEW_FILE', 500);
  const temporary = join(dirname(path), `.review-feedback-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    if (error instanceof ReviewStoreError) throw error;
    fail('意见尚未写入文件，请重试保存。', 'REVIEW_SAVE', 500);
  } finally {
    await handle?.close();
    await rm(temporary, {force: true}).catch(() => {});
  }
}

export async function saveReviewFeedback(dataPath, input, options = {}) {
  checkedPath(dataPath, 'review-data.json');
  const target = feedbackFile(dataPath, options);
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8'); } catch { fail('意见格式无效。'); }
  if (bytes > MAX_REVIEW_FEEDBACK_BYTES) fail('意见内容过长。', 'REVIEW_TOO_LARGE', 413);
  const preceding = writes.get(target) ?? Promise.resolve();
  const operation = preceding.catch(() => {}).then(async () => {
    const current = await loadReviewData(dataPath, options);
    const entry = normalizeFeedback(input, current.items);
    entry.updatedAt = new Date().toISOString();
    const stored = await readJson(target, {version: 1, feedback: {}});
    const feedback = Object.assign(Object.create(null), stored.feedback);
    feedback[entry.itemId] = entry;
    if (Object.keys(feedback).length > MAX_ITEMS) fail('意见文件中的样例数量已满。', 'REVIEW_FILE', 500);
    await atomicJson(target, {version: 1, feedback, updatedAt: entry.updatedAt});
    return {feedback: entry};
  });
  writes.set(target, operation);
  try { return await operation; } finally { if (writes.get(target) === operation) writes.delete(target); }
}
