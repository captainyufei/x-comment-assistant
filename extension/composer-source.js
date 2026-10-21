// Classic content script shared with composer.js in the extension's isolated world.
// Prefer a permalink. A restored reply dialog can also supply its visible original
// directly, with an explicit composer-only context and no invented tweet identity.
(() => {
  const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/;
  const PROFILE_PATH = /^\/([A-Za-z0-9_]{1,15})\/?$/;
  const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
  const EDITOR_SELECTOR = '[data-testid^="tweetTextarea_"][contenteditable="true"], [role="textbox"][contenteditable="true"]';
  const readText = node => String(node?.innerText ?? node?.textContent ?? "").trim();
  const nodes = (scope, selector) => Array.from(scope?.querySelectorAll?.(selector) ?? []);
  const clip = (value, limit) => Array.from(String(value ?? "")).slice(0, limit).join("");
  const normalizedText = value => String(value ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  const normalizedHandle = value => String(value ?? "").match(HANDLE)?.[1]?.toLowerCase() ?? "";
  // X adds picture short-links to the reply modal that are absent from the same
  // timeline body's text. They identify media, not a different reply target.
  // The lookahead also handles adjacent spans whose textContent joins two URLs.
  const cleanTweetText = value => String(value ?? "").replace(/(?:https?:\/\/\s*)?pic\.(?:x|twitter)\.com\/[A-Za-z0-9_-]+?(?=https?:\/\/|[^A-Za-z0-9_-]|$)/gi, "").trim();
  const MEDIA_PATH = /^\/(?:media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/[A-Za-z0-9_./-]+$/;

  function mediaURL(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || url.username || url.password || url.port || !MEDIA_PATH.test(url.pathname) || url.pathname.includes("..")) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  }

  function validMedia(values) {
    const media = [], seen = new Set();
    for (const item of Array.isArray(values) ? values : []) {
      const url = mediaURL(item?.url);
      if (!url || !["image", "video-poster"].includes(item?.kind) || seen.has(new URL(url).pathname)) continue;
      seen.add(new URL(url).pathname);
      const alt = clip(String(item.alt ?? "").replace(/\s+/g, " ").trim(), 500);
      media.push({kind: item.kind, url, ...(alt && !/^(?:图像|图片|Image|Photo)$/i.test(alt) ? {alt} : {})});
      if (media.length === 4) break;
    }
    return media;
  }

  function parseURL(value, base) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
      return url;
    } catch { return null; }
  }

  function statusIdentity(value, locationHref) {
    const url = parseURL(value, locationHref);
    const match = url?.pathname.match(STATUS_PATH);
    return match ? {id: match[2], author: `@${match[1]}`, url: `https://x.com/${match[1]}/status/${match[2]}`} : null;
  }

  function isQuoted(node, scope) {
    for (let current = node; current && current !== scope; current = current.parentElement) {
      // The original's photo link wraps its own image; it is not a quoted tweet.
      if (String(current.tagName).toLowerCase() === "a" && /\/status\/\d+\/(?:photo|video)\/\d+(?:[?#]|$)/.test(current.href || current.getAttribute?.("href") || "")) continue;
      if (current.matches?.('[role="link"], [data-testid="quoteTweet"], [data-testid="card.wrapper"], a[href*="/status/"]')) return true;
    }
    return false;
  }

  function readMedia(scope) {
    const values = nodes(scope, "img, video").filter(node => !isQuoted(node, scope)).map(node => {
      const video = String(node.tagName).toLowerCase() === "video";
      const url = video ? node.poster || node.getAttribute?.("poster") : node.currentSrc || node.src || node.getAttribute?.("src");
      const kind = video || /\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url ?? "") ? "video-poster" : "image";
      return {kind, url, alt: video ? "" : node.alt || node.getAttribute?.("alt")};
    });
    return validMedia(values);
  }

  const mediaIdentities = media => media.map(item => {
    const url = new URL(item.url);
    return `${item.kind}:${url.pathname}?format=${(url.searchParams.get("format") ?? "").toLowerCase()}`;
  }).sort();
  const sameMedia = (first, second) => JSON.stringify(mediaIdentities(first)) === JSON.stringify(mediaIdentities(second));
  const hasMatchingMedia = (first, second) => {
    const available = new Set(mediaIdentities(first));
    return mediaIdentities(second).some(identity => available.has(identity));
  };

  function readAuthor(scope, locationHref) {
    const header = nodes(scope, '[data-testid="User-Name"]').find(node => !isQuoted(node, scope));
    if (!header) return null;
    const profileHandles = nodes(header, 'a[href]').map(anchor => {
      const url = parseURL(anchor.href || anchor.getAttribute?.("href"), locationHref);
      return url?.pathname.match(PROFILE_PATH)?.[1] ?? "";
    }).filter(Boolean);
    const textHandles = Array.from(readText(header).matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g), match => match[1]);
    const handles = profileHandles.length ? profileHandles : textHandles;
    const distinct = new Set(handles.map(handle => handle.toLowerCase()));
    if (distinct.size !== 1) return null;
    const handle = handles[0];
    // A conflicting explicit @handle means the header is not a safe author source.
    if (textHandles.some(candidate => candidate.toLowerCase() !== handle.toLowerCase())) return null;
    const name = readText(header).split(/\n|@/).map(line => line.trim()).find(line => line && !line.startsWith("·") && !/^\d/.test(line)) ?? "";
    return {author: `@${handle}`, authorName: clip(name === handle ? "" : name, 200)};
  }

  function description(scope, locationHref) {
    const textNodes = nodes(scope, '[data-testid="tweetText"]');
    const mainNodes = textNodes.filter(node => !isQuoted(node, scope));
    if (mainNodes.length > 1) return null;
    const rawText = readText(mainNodes[0]);
    const text = cleanTweetText(rawText);
    const media = readMedia(scope);
    if (!text && !media.length) return null;
    const author = readAuthor(scope, locationHref);
    if (!author) return null;
    const quotedTexts = textNodes.filter(node => isQuoted(node, scope)).map(readText).filter(Boolean);
    return {
      ...author,
      text: clip(text, 12000),
      quote: clip(quotedTexts.map(cleanTweetText).filter(Boolean).join("\n"), 5000),
      media,
      hasMedia: media.length > 0 || rawText !== text || quotedTexts.some(value => cleanTweetText(value) !== value) || Boolean(scope.querySelector?.('[data-testid="tweetPhoto"], video, [data-testid="videoPlayer"]'))
    };
  }

  function sourceLinks(scope, locationHref, author) {
    const mainLinks = nodes(scope, 'a[href*="/status/"]').filter(anchor => !isQuoted(anchor.parentElement, scope) && anchor.querySelector?.("time"));
    const parsed = mainLinks.map(anchor => statusIdentity(anchor.href || anchor.getAttribute?.("href"), locationHref));
    if (parsed.some(identity => !identity)) return {conflict: true, identities: []};
    const identities = parsed.filter(Boolean);
    // An original time link with a different author cannot be replaced by a guessed link.
    if (identities.some(identity => normalizedHandle(identity.author) !== normalizedHandle(author))) return {conflict: true, identities: []};
    const byId = new Map(identities.map(identity => [identity.id, identity]));
    return {conflict: byId.size > 1, identities: [...byId.values()]};
  }

  function validContext(context, locationHref) {
    if (!context || typeof context.text !== "string") return null;
    const text = cleanTweetText(context.text);
    const media = validMedia(context.media);
    if (!text && !media.length) return null;
    const identity = statusIdentity(context.url, locationHref);
    if (!identity || String(context.id) !== identity.id || normalizedHandle(context.author) !== normalizedHandle(identity.author)) return null;
    return {
      ...identity,
      text: clip(text, 12000),
      authorName: clip(context.authorName, 200),
      quote: clip(cleanTweetText(context.quote), 5000),
      media,
      hasMedia: media.length > 0 || Boolean(context.hasMedia) || text !== context.text.trim(),
      capturedAt: typeof context.capturedAt === "string" ? context.capturedAt : new Date().toISOString()
    };
  }

  function contextWithIdentity(source, identity, matchedContext = null) {
    return {...identity, text: source.text, authorName: source.authorName, quote: source.quote, media: source.media.length ? source.media : validMedia(matchedContext?.media), hasMedia: Boolean(source.hasMedia || matchedContext?.hasMedia), capturedAt: new Date().toISOString()};
  }

  function visibleComposerContext(source) {
    return {contextKind: "composer-visible", id: null, url: null, text: source.text, author: source.author, authorName: source.authorName, quote: source.quote, media: source.media, hasMedia: source.hasMedia, capturedAt: new Date().toISOString()};
  }

  function extractArticle(article, locationHref) {
    const source = description(article, locationHref);
    if (!source) return null;
    const links = sourceLinks(article, locationHref, source.author);
    return !links.conflict && links.identities.length === 1 ? contextWithIdentity(source, links.identities[0]) : null;
  }

  function replyEvidence(dialog) {
    const editor = dialog?.querySelector?.(EDITOR_SELECTOR);
    if (!editor) return {reply: false, recipients: []};
    const markers = nodes(dialog, 'button, [role="button"], [data-testid="inlineReplyingTo"], [data-testid="replyingTo"]');
    const recipients = new Set();
    for (const marker of markers) {
      const text = normalizedText(readText(marker));
      if (!/^(?:回复(?:给)?|Replying to)\s*@/i.test(text)) continue;
      for (const match of text.matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)) recipients.add(match[1].toLowerCase());
    }
    const placeholders = nodes(dialog, '[data-testid$="_placeholder"], .public-DraftEditorPlaceholder-inner');
    const labels = [editor.getAttribute?.("aria-label"), editor.getAttribute?.("data-placeholder"), ...placeholders.map(readText)].filter(Boolean);
    const replyPlaceholder = labels.some(label => /^(?:发布你的回复|发送你的回复|写下你的回复|Post your reply|Write your reply|Reply to this post)$/i.test(normalizedText(label)));
    return {reply: recipients.size > 0 || replyPlaceholder, replyPlaceholder, recipients: [...recipients]};
  }

  function isReplyComposer(dialog) { return replyEvidence(dialog).reply; }

  function getReplyContext(dialog, {clickedContext = null, locationHref = globalThis.location?.href, timelineContexts = [], replyScope = null, allowComposerVisible = false} = {}) {
    const mainScope = String(dialog?.tagName ?? "").toLowerCase() === "main";
    let evidenceScope = dialog;
    if (mainScope && replyScope) {
      const mainEditor = dialog.querySelector?.(EDITOR_SELECTOR);
      const scopedEditor = replyScope.querySelector?.(EDITOR_SELECTOR);
      // Bind the reply proof to the same first editor used by the controller. Another
      // comment editor or a node outside this main area cannot supply a recipient.
      if (replyScope === dialog || !dialog.contains?.(replyScope) || !mainEditor || scopedEditor !== mainEditor) return null;
      evidenceScope = replyScope;
    }
    const evidence = replyEvidence(evidenceScope);
    if (!evidence.reply) return null;
    const acceptAuthor = author => !evidence.recipients.length || evidence.recipients.includes(normalizedHandle(author));
    const articles = nodes(dialog, 'article[data-testid="tweet"]').filter(article => !isQuoted(article, dialog));
    const timeline = timelineContexts.map(context => validContext(context, locationHref)).filter(Boolean);
    const exactPage = statusIdentity(locationHref, locationHref);
    // The detail page's main area also contains other people's replies. Its URL identifies
    // the original only when this is explicitly a reply field, never a generic post editor.
    if (mainScope) {
      if (!evidence.replyPlaceholder || !exactPage || !acceptAuthor(exactPage.author)) return null;
      // Prefer the visible original, but reject conflicting snapshots of the same ID.
      const available = [...articles.map(article => extractArticle(article, locationHref)).filter(Boolean), ...timeline];
      const matching = available.filter(candidate => candidate.id === exactPage.id && normalizedHandle(candidate.author) === normalizedHandle(exactPage.author));
      const fingerprints = new Set(matching.map(candidate => JSON.stringify([normalizedText(candidate.text), mediaIdentities(candidate.media)])));
      return fingerprints.size === 1 ? contextWithIdentity(matching[0], exactPage, matching.find(candidate => candidate.media.length)) : null;
    }
    const scopes = articles.length ? articles : [dialog];
    const descriptions = scopes.map(scope => ({scope, source: description(scope, locationHref)})).filter(({source}) => source);
    const sources = descriptions.filter(({source}) => acceptAuthor(source.author));
    if (descriptions.length && !sources.length) return null;
    // More than one possible original in a composer is not enough evidence to choose one.
    if (sources.length > 1) return null;
    const clicked = validContext(clickedContext, locationHref);

    if (sources.length === 1) {
      const {scope, source} = sources[0];
      const links = sourceLinks(scope, locationHref, source.author);
      if (links.conflict) return null;
      const matches = candidate => candidate && normalizedHandle(candidate.author) === normalizedHandle(source.author) && normalizedText(candidate.text) === normalizedText(source.text) && (!source.text ? source.media.length > 0 && sameMedia(source.media, candidate.media) : !source.media.length || !candidate.media.length || hasMatchingMedia(source.media, candidate.media));
      if (links.identities.length === 1) {
        const identity = links.identities[0];
        const matched = [clicked, ...timeline].find(candidate => candidate?.id === identity.id && matches(candidate));
        return contextWithIdentity(source, identity, matched);
      }
      if (matches(clicked)) return contextWithIdentity(source, statusIdentity(clicked.url, locationHref), clicked);
      // Only a source-less modal matching one distinct timeline ID may recover its link.
      const matching = timeline.filter(matches);
      const byId = new Map(matching.map(candidate => [candidate.id, candidate]));
      if (byId.size > 1) return null;
      if (byId.size === 1) { const matched = [...byId.values()][0]; return contextWithIdentity(source, statusIdentity(matched.url, locationHref), matched); }
      // After a refresh the timeline may no longer contain this post. Its visible
      // original and explicit recipient are sufficient to write in this same editor;
      // they do not prove a status ID or authorize opening a reply intent elsewhere.
      if (allowComposerVisible && dialog.getAttribute?.("role") === "dialog" && articles.length === 1 && evidence.recipients.length === 1) return visibleComposerContext(source);
      if (!allowComposerVisible && !clicked && exactPage && normalizedHandle(exactPage.author) === normalizedHandle(source.author)) return contextWithIdentity(source, exactPage);
      return null;
    }

    // A compact detail-page reply field may omit the original, but its URL must identify it.
    if (!articles.length && !nodes(dialog, '[data-testid="tweetText"]').length && !clicked && exactPage && acceptAuthor(exactPage.author)) {
      const matching = timeline.filter(candidate => candidate.id === exactPage.id && normalizedHandle(candidate.author) === normalizedHandle(exactPage.author));
      const fingerprints = new Set(matching.map(candidate => JSON.stringify([normalizedText(candidate.text), mediaIdentities(candidate.media)])));
      return fingerprints.size === 1 ? matching[0] : null;
    }
    return null;
  }

  globalThis.__JieYiJuSource = Object.freeze({extractArticle, getReplyContext, isReplyComposer});
})();
