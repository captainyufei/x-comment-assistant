// Serialized by chrome.scripting.executeScript: keep every helper inside this function.
export function captureVisibleTweets(selectionOnly = false, selectedText = "") {
  if (!["x.com", "twitter.com"].includes(location.hostname)) {
    return {contexts: [], error: "请在 X 的时间线或推文页面使用插件。"};
  }
  const isVisible = element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth && style.display !== "none" && style.visibility !== "hidden";
  };
  const readText = element => element?.innerText?.trim() ?? "";
  const cleanTweetText = value => String(value ?? "").replace(/(?:https?:\/\/\s*)?pic\.(?:x|twitter)\.com\/[A-Za-z0-9_-]+?(?=https?:\/\/|[^A-Za-z0-9_-]|$)/gi, "").trim();
  const isQuoteDescendant = (element, article) => {
    for (let ancestor = element; ancestor && ancestor !== article; ancestor = ancestor.parentElement) {
      if (String(ancestor.tagName).toLowerCase() === "a" && /\/status\/\d+\/(?:photo|video)\/\d+(?:[?#]|$)/.test(ancestor.href || ancestor.getAttribute?.("href") || "")) continue;
      if (ancestor.matches('[role="link"], [data-testid="quoteTweet"], [data-testid="card.wrapper"], a[href*="/status/"]')) return true;
    }
    return false;
  };
  const readMedia = article => {
    const media = [], seen = new Set();
    for (const node of article.querySelectorAll("img, video")) {
      if (isQuoteDescendant(node, article)) continue;
      const video = String(node.tagName).toLowerCase() === "video";
      const source = video ? node.poster || node.getAttribute?.("poster") : node.currentSrc || node.src || node.getAttribute?.("src");
      let url;
      try { url = new URL(source); } catch { continue; }
      if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || url.username || url.password || url.port || !/^\/(?:media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/[A-Za-z0-9_./-]+$/.test(url.pathname) || url.pathname.includes("..") || seen.has(url.pathname)) continue;
      url.hash = "";
      seen.add(url.pathname);
      const kind = video || /\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url.pathname) ? "video-poster" : "image";
      const alt = Array.from(String(video ? "" : node.alt || node.getAttribute?.("alt") || "").replace(/\s+/g, " ").trim()).slice(0, 500).join("");
      media.push({kind, url: url.href, ...(alt && !/^(?:图像|图片|Image|Photo)$/i.test(alt) ? {alt} : {})});
      if (media.length === 4) break;
    }
    return media;
  };
  const sourcePattern = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/;
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(isVisible);
  let selectedArticle = null;
  if (selectionOnly) {
    const selection = getSelection();
    const node = selection?.anchorNode;
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    selectedArticle = element?.closest('article[data-testid="tweet"]');
    if (!selectedArticle || !isVisible(selectedArticle)) {
      selectedArticle = articles.find(article => selectedText.trim() && readText(article).includes(selectedText.trim()));
    }
    if (!selectedArticle) return {contexts: [], error: "没有找到选中文字所属的可见推文，请重新选择正文。"};
  }
  const contexts = [];
  const ids = new Set();
  for (const article of (selectionOnly ? [selectedArticle] : articles)) {
    const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const mainTextNodes = textNodes.filter(node => !isQuoteDescendant(node, article));
    if (mainTextNodes.length > 1) continue;
    const mainTextNode = mainTextNodes[0];
    const rawText = readText(mainTextNode);
    const text = cleanTweetText(rawText);
    const media = readMedia(article);
    if (!text && !media.length) continue;
    const anchors = [...article.querySelectorAll('a[href*="/status/"]')];
    // A permalink is itself an anchor, so inspect its ancestors for a quoted card.
    const permalink = anchors.find(anchor => !isQuoteDescendant(anchor.parentElement, article) && anchor.querySelector("time") && sourcePattern.test(new URL(anchor.href, location.href).pathname));
    if (!permalink) continue;
    const url = new URL(permalink.href, location.href);
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname) || url.username || url.password || url.port) continue;
    const match = url.pathname.match(sourcePattern);
    if (!match || ids.has(match[2])) continue;
    const mainAuthor = [...article.querySelectorAll('[data-testid="User-Name"]')].find(node => !isQuoteDescendant(node, article));
    const authorHandles = [...new Set(Array.from(readText(mainAuthor).matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g), value => value[1].toLowerCase()))];
    if (authorHandles.length !== 1 || authorHandles[0] !== match[1].toLowerCase()) continue;
    ids.add(match[2]);
    const authorLines = readText(mainAuthor).split("\n").map(line => line.trim()).filter(Boolean);
    const authorName = authorLines.find(line => !line.startsWith("@") && line !== "·") ?? "";
    contexts.push({
      id: match[2],
      text: Array.from(text).slice(0, 12000).join(""),
      url: `https://x.com/${match[1]}/status/${match[2]}`,
      author: `@${match[1]}`,
      authorName: Array.from(authorName).slice(0, 200).join(""),
      quote: Array.from(textNodes.filter(node => isQuoteDescendant(node, article)).map(readText).map(cleanTweetText).filter(Boolean).join("\n")).slice(0, 5000).join(""),
      media,
      hasMedia: media.length > 0 || rawText !== text || Boolean(article.querySelector('[data-testid="tweetPhoto"], video, [data-testid="videoPlayer"]')),
      capturedAt: new Date().toISOString()
    });
    if (contexts.length >= 8) break;
  }
  return {contexts, error: contexts.length ? "" : "当前屏幕没有找到可读取的推文正文或图片，请滚动到完整原帖后再读取。"};
}
