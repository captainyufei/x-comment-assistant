import {open, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {validateMedia} from './extension/media-core.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MEDIA_CONCURRENCY = 2;
const IMAGE_TIMEOUT_MS = 10_000;
const BATCH_TIMEOUT_MS = 12_000;
function imageExtension(bytes, contentType) {
  if (contentType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (contentType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (contentType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // Animated media cannot be silently described as fully watched. Static image
  // formats only; video posters are JPEG/PNG/WebP and explicitly labelled.
  throw new Error('unsupported media bytes');
}

function timeoutOption(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new Error('媒体超时预算无效。');
  return value;
}

function cancelQuietly(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Already closed/locked. */ }
}

/** A bounded wait even if a custom fetch/reader does not implement AbortSignal. */
function abortable(promise, signal, onAbort) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      onAbort?.();
      reject(signal.reason);
    };
    if (signal.aborted) { abort(); Promise.resolve(promise).catch(() => {}); return; }
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export async function prepareMedia(context, dir, {fetchImpl = fetch, signal, imageTimeoutMs, batchTimeoutMs} = {}) {
  const media = validateMedia(context.media);
  const perImageMs = timeoutOption(imageTimeoutMs, IMAGE_TIMEOUT_MS);
  const batchMs = timeoutOption(batchTimeoutMs, BATCH_TIMEOUT_MS);
  const evidence = {images: 0, videoFrames: 0, videoPosters: 0, altTexts: media.map(item => item.alt).filter(Boolean), limitations: [], attachments: []};
  signal?.throwIfAborted();
  const batchController = new AbortController();
  const batchTimer = setTimeout(() => batchController.abort(new DOMException('Media batch deadline exceeded', 'TimeoutError')), batchMs);
  const batchSignal = signal ? AbortSignal.any([signal, batchController.signal]) : batchController.signal;
  const results = Array(media.length);
  const failures = Array(media.length);
  // Includes successful attachments AND bytes buffered by both active workers.
  // A failed item releases only its own reservation before more work can start.
  let reservedBytes = 0;
  let nextIndex = 0;

  const readItem = async (item, index) => {
    signal?.throwIfAborted();
    if (batchSignal.aborted) { failures[index] = true; return; }
    const imageController = new AbortController();
    const imageTimer = setTimeout(() => imageController.abort(new DOMException('Media image deadline exceeded', 'TimeoutError')), perImageMs);
    const requestSignal = AbortSignal.any([batchSignal, imageController.signal]);
    let size = 0;
    let responseBody;
    let savedPath;
    let handle;
    let committed = false;
    try {
      requestSignal.throwIfAborted();
      const fetchPromise = Promise.resolve(fetchImpl(item.url, {redirect: 'error', credentials: 'omit', signal: requestSignal, headers: {accept: 'image/jpeg,image/png,image/webp'}}));
      // A response arriving after the deadline must not leave an unread body open.
      fetchPromise.then(response => { if (requestSignal.aborted) cancelQuietly(response?.body); }, () => {});
      const response = await abortable(fetchPromise, requestSignal);
      responseBody = response.body;
      requestSignal.throwIfAborted();
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !['image/jpeg','image/png','image/webp'].includes(type) || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        cancelQuietly(response.body); throw new Error('unsupported media response');
      }
      const chunks = [];
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty media response');
      try {
        while (true) {
          const part = await abortable(reader.read(), requestSignal, () => cancelQuietly(reader));
          requestSignal.throwIfAborted();
          if (part.done) break;
          const bytes = part.value.byteLength;
          if (size + bytes > MAX_IMAGE_BYTES || reservedBytes + bytes > MAX_TOTAL_BYTES) {
            cancelQuietly(reader); throw new Error('media size limit');
          }
          size += bytes;
          reservedBytes += bytes;
          chunks.push(Buffer.from(part.value));
        }
      } finally { try { reader.releaseLock(); } catch { /* A canceled read may still be settling. */ } }
      const bytes = Buffer.concat(chunks);
      const extension = imageExtension(bytes, type);
      const path = join(dir, `original-${index + 1}.${extension}`);
      requestSignal.throwIfAborted();
      handle = await open(path, 'wx', 0o600);
      savedPath = path;
      await handle.writeFile(bytes, {signal: requestSignal});
      requestSignal.throwIfAborted();
      await handle.close(); handle = null;
      requestSignal.throwIfAborted();
      results[index] = {path, kind: item.kind};
      committed = true;
    } catch (error) {
      signal?.throwIfAborted();
      failures[index] = true;
    } finally {
      clearTimeout(imageTimer);
      if (handle) await handle.close().catch(() => {});
      if (!committed) {
        reservedBytes -= size;
        cancelQuietly(responseBody);
        if (savedPath) await unlink(savedPath).catch(() => {});
      }
    }
  };

  const worker = async () => {
    while (nextIndex < media.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      await readItem(media[index], index);
    }
  };
  try {
    // All workers settle before returning or rejecting; no background worker can
    // keep writing after the caller has been told preparation is canceled.
    const outcomes = await Promise.allSettled(Array.from({length: Math.min(MEDIA_CONCURRENCY, media.length)}, () => worker()));
    signal?.throwIfAborted();
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
  } finally {
    clearTimeout(batchTimer);
  }
  const paths = [];
  for (const [index, item] of media.entries()) {
    const result = results[index];
    if (result) {
      paths.push(result.path);
      evidence.attachments.push({index: paths.length, kind: result.kind});
      evidence[result.kind === 'image' ? 'images' : 'videoPosters']++;
    } else if (failures[index]) {
      evidence.limitations.push(item.kind === 'image' ? `第 ${index + 1} 张图片未能读取；不能推断画面。` : `第 ${index + 1} 个视频封面未能读取；不知道视频内容。`);
    }
  }
  if (media.some(item => item.kind === 'video-poster')) evidence.limitations.push('视频仅读取封面，未读取连续画面、台词或声音。');
  if (context.hasMedia && !media.length) evidence.limitations.push('原帖含媒体，但页面未提供可读取的图片或视频封面。');
  return {paths, evidence};
}
