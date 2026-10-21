// Only public media belonging to the explicitly selected original post.
export function validateMedia(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 4) throw new Error('每条原帖最多读取四张图片或视频封面。');
  const seen = new Set();
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !['image', 'video-poster'].includes(item.kind)) throw new Error('原帖媒体类型无效。');
    if (typeof item.url !== 'string' || item.url.length > 2048) throw new Error('原帖媒体地址无效。');
    let url; try { url = new URL(item.url); } catch { throw new Error('原帖媒体地址无效。'); }
    const imagePath = /^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp|gif))?$/i;
    const posterPath = /^\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/[A-Za-z0-9_./-]+$/;
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.username || url.password || url.port || url.hash ||
        !(item.kind === 'image' ? imagePath.test(url.pathname) : posterPath.test(url.pathname) || imagePath.test(url.pathname))) throw new Error('只读取原帖的公开图片和视频封面。');
    for (const [key, value] of url.searchParams) {
      if (key === 'format' ? !/^(?:jpg|jpeg|png|webp|gif)$/.test(value) : key === 'name' ? !/^[A-Za-z0-9_-]{1,32}$/.test(value) : true) throw new Error('原帖媒体地址参数无效。');
    }
    if (typeof item.alt !== 'undefined' && (typeof item.alt !== 'string' || [...item.alt].length > 1000)) throw new Error('图片说明过长或无效。');
    const value = {kind: item.kind, url: url.href, alt: (item.alt || '').trim()};
    if (seen.has(value.url)) throw new Error('原帖媒体重复，请重新打开回复。');
    seen.add(value.url); return value;
  });
}

export function publicMediaEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const count = key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 4 ? value[key] : 0;
  const strings = (items, max) => Array.isArray(items) ? items.filter(x => typeof x === 'string').slice(0, 4).map(x => [...x].slice(0, max).join('')) : [];
  return {images: count('images'), videoFrames: count('videoFrames'), videoPosters: count('videoPosters'), altTexts: strings(value.altTexts, 1000), limitations: strings(value.limitations, 200), ...(Array.isArray(value.attachments) ? {attachments: value.attachments.slice(0, 4).filter(item => Number.isInteger(item?.index) && item.index >= 1 && item.index <= 4 && ['image','video-poster'].includes(item.kind)).map(item => ({index: item.index,kind: item.kind}))} : {})};
}
