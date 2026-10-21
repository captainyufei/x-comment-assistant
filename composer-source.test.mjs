import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import "./extension/composer-source.js";

const {extractArticle, getReplyContext, isReplyComposer} = globalThis.__JieYiJuSource;
const HOME = "https://x.com/home";
const EDITOR_SELECTOR = '[data-testid^="tweetTextarea_"][contenteditable="true"], [role="textbox"][contenteditable="true"]';
const MARKERS_SELECTOR = 'button, [role="button"], [data-testid="inlineReplyingTo"], [data-testid="replyingTo"]';
const PLACEHOLDERS_SELECTOR = '[data-testid$="_placeholder"], .public-DraftEditorPlaceholder-inner';

function element({parent = null, text = "", tag = "div", role = "", testid = "", href = "", time = false} = {}) {
  const selectors = new Map();
  return {
    parentElement: parent, innerText: text, tag, tagName: tag.toUpperCase(), role, testid, href, selectors,
    matches() { return role === "link" || ["quoteTweet", "card.wrapper"].includes(testid) || (tag === "a" && href.includes("/status/")); },
    contains(other) { for (let current = other; current; current = current.parentElement) if (current === this) return true; return false; },
    getAttribute(name) { return name === "href" ? href : name === "role" ? role : ""; },
    querySelectorAll(selector) { return selectors.get(selector) ?? []; },
    querySelector(selector) { if (selector === "time") return time ? {} : null; return this.querySelectorAll(selector)[0] ?? null; }
  };
}

function articleFixture({id = "1234567890123456789", author = "demo_writer", text = "复利要放在风险和波动里看。", quote = "", quoteFirst = false, quoteKind = "role", link = true, sourceHref, media = false, mediaItems = [], quoteMediaItems = [], photoLink = false} = {}) {
  const article = element();
  const body = element({parent: article});
  const header = element({parent: body, testid: "User-Name", text: `原作者\n@${author}\n·\n5小时`});
  header.selectors.set('a[href]', [element({parent: header, tag: "a", href: `https://x.com/${author}`})]);
  const mainText = text ? element({parent: body, testid: "tweetText", text}) : null;
  const mainLink = link ? element({parent: header, tag: "a", href: sourceHref ?? `https://x.com/${author}/status/${id}`, time: true}) : null;
  const quoted = element({parent: body, ...(quoteKind === "role" ? {role: "link"} : {testid: quoteKind})});
  const quoteText = quote ? element({parent: quoted, testid: "tweetText", text: quote}) : null;
  const quoteHeader = element({parent: quoted, testid: "User-Name", text: "引用的人\n@quoted"});
  quoteHeader.selectors.set('a[href]', [element({parent: quoteHeader, tag: "a", href: "https://x.com/quoted"})]);
  const quoteLink = quote ? element({parent: quoted, tag: "a", href: "https://x.com/quoted/status/2234567890123456789", time: true}) : null;
  const ordered = (main, other) => (quoteFirst ? [other, main] : [main, other]).filter(Boolean);
  article.selectors.set('[data-testid="tweetText"]', ordered(mainText, quoteText));
  article.selectors.set('[data-testid="User-Name"]', ordered(header, quote ? quoteHeader : null));
  article.selectors.set('a[href*="/status/"]', ordered(mainLink, quoteLink));
  const mediaParent = photoLink ? element({parent: body, tag: "a", href: `https://x.com/${author}/status/${id}/photo/1`}) : body;
  const mediaNode = (item, parent) => Object.assign(element({parent, tag: item.kind === "video-poster" && !item.imagePoster ? "video" : "img"}), {src: item.url, currentSrc: item.currentSrc ?? "", poster: item.url, alt: item.alt ?? ""});
  article.selectors.set("img, video", [...quoteMediaItems.map(item => mediaNode(item, quoted)), ...mediaItems.map(item => mediaNode(item, mediaParent))]);
  if (media) article.selectors.set('[data-testid="tweetPhoto"], video, [data-testid="videoPlayer"]', [{}]);
  return article;
}

function dialogFixture({articles = [articleFixture({link: false})], recipient = "demo_writer", editor = true, placeholder = "", replyMarker = true} = {}) {
  const dialog = element({role: "dialog"});
  for (const article of articles) article.parentElement = dialog;
  dialog.selectors.set('article[data-testid="tweet"]', articles);
  dialog.selectors.set('[data-testid="tweetText"]', articles.flatMap(article => article.querySelectorAll('[data-testid="tweetText"]')));
  if (editor) dialog.selectors.set(EDITOR_SELECTOR, [element({parent: dialog})]);
  dialog.selectors.set(MARKERS_SELECTOR, replyMarker ? [element({tag: "button", text: `回复 @${recipient}`})] : []);
  dialog.selectors.set(PLACEHOLDERS_SELECTOR, placeholder ? [element({text: placeholder})] : []);
  return dialog;
}

function context(options = {}) { return extractArticle(articleFixture(options), HOME); }

test("composer extraction keeps quoted cards separate even before the main author's time link", () => {
  for (const quoteKind of ["role", "quoteTweet", "card.wrapper"]) {
    const source = extractArticle(articleFixture({quote: "引用正文。", quoteFirst: true, quoteKind, media: true}), HOME);
    assert.equal(source.id, "1234567890123456789");
    assert.equal(source.author, "@demo_writer");
    assert.equal(source.text, "复利要放在风险和波动里看。");
    assert.equal(source.quote, "引用正文。");
    assert.equal(source.hasMedia, true);
  }
});

test("reply modal with its own exact permalink wins over a stale clicked snapshot", () => {
  const dialog = dialogFixture({articles: [articleFixture({id: "1234567890123456790"})]});
  const actual = getReplyContext(dialog, {clickedContext: context(), locationHref: HOME});
  assert.equal(actual.id, "1234567890123456790");
});

test("source-less modal recovers a clicked original only when author and text match", () => {
  const clicked = context();
  assert.equal(getReplyContext(dialogFixture(), {clickedContext: clicked, locationHref: HOME}).id, clicked.id);
  const changedText = dialogFixture({articles: [articleFixture({link: false, text: "完全不同的一条推文。"})]});
  assert.equal(getReplyContext(changedText, {clickedContext: clicked, locationHref: HOME}), null);
  const changedAuthor = dialogFixture({articles: [articleFixture({link: false, author: "other"})], recipient: "other"});
  assert.equal(getReplyContext(changedAuthor, {clickedContext: clicked, locationHref: HOME}), null);
});

test("refreshed reply modal restores source from a unique same-text same-author timeline context", () => {
  const actual = getReplyContext(dialogFixture({articles: [articleFixture({link: false, text: "复利要放在风险\n和波动里看。"})]}), {
    locationHref: HOME,
    timelineContexts: [context({author: "other"}), context({text: "完全不同的内容。"}), context({text: "复利要放在风险 和波动里看。"})]
  });
  assert.equal(actual.id, "1234567890123456789");
  assert.equal(actual.author, "@demo_writer");
});

test("two same-author same-text original IDs are ambiguous and never choose the first", () => {
  const matches = [context(), context({id: "1234567890123456790"})];
  assert.equal(getReplyContext(dialogFixture(), {locationHref: HOME, timelineContexts: matches}), null);
  assert.equal(getReplyContext(dialogFixture(), {locationHref: HOME, timelineContexts: matches.reverse()}), null);
  assert.equal(getReplyContext(dialogFixture(), {locationHref: HOME, timelineContexts: [context(), context()]}).id, "1234567890123456789");
});

test("recipient mismatch cannot restore a different author's source", () => {
  assert.equal(getReplyContext(dialogFixture({recipient: "other"}), {locationHref: HOME, clickedContext: context(), timelineContexts: [context()]}), null);
  assert.equal(getReplyContext(dialogFixture({recipient: "other"}), {locationHref: "https://x.com/other/status/1234567890123456790", timelineContexts: [context({author: "other", id: "1234567890123456790"})]}), null);
});

test("a post or repost composer does not qualify without reply-specific UI", () => {
  const unrelated = dialogFixture({replyMarker: false, placeholder: "有什么新鲜事？"});
  assert.equal(isReplyComposer(unrelated), false);
  assert.equal(getReplyContext(unrelated, {locationHref: HOME, clickedContext: context()}), null);
  assert.equal(isReplyComposer(dialogFixture({editor: false})), false);
  assert.equal(isReplyComposer(dialogFixture({replyMarker: false, placeholder: "Post your reply"})), true);
});

test("pure-media and quote-only originals are not passed off as a readable main post", () => {
  for (const original of [articleFixture({text: "", media: true}), articleFixture({text: "", quote: "这是引用作者说的。", quoteFirst: true})]) {
    assert.equal(extractArticle(original, HOME), null);
    assert.equal(getReplyContext(dialogFixture({articles: [original]}), {locationHref: "https://x.com/demo_writer/status/1234567890123456789", timelineContexts: [context()]}), null);
  }
});

test("strict source URLs reject external hosts, invalid IDs, photo links and header mismatches", () => {
  for (const sourceHref of [
    "https://evil.example/demo_writer/status/1234567890123456789",
    "http://x.com/demo_writer/status/1234567890123456789",
    "https://x.com/demo_writer/status/1234",
    `https://x.com/demo_writer/status/${"1".repeat(26)}`,
    "https://x.com/demo_writer/status/1234567890123456789/photo/1",
    "https://x.com/other/status/1234567890123456789"
  ]) {
    const original = articleFixture({sourceHref});
    assert.equal(extractArticle(original, HOME), null, sourceHref);
    assert.equal(getReplyContext(dialogFixture({articles: [original]}), {locationHref: HOME, clickedContext: context()}), null, sourceHref);
  }
  assert.equal(extractArticle(articleFixture({sourceHref: "https://twitter.com/demo_writer/status/12345?s=20"}), HOME).url, "https://x.com/demo_writer/status/12345");
});

test("an exact detail URL supplies only its own author and ID when no clicked snapshot exists", () => {
  const locationHref = "https://x.com/demo_writer/status/1234567890123456789";
  assert.equal(getReplyContext(dialogFixture(), {locationHref}).id, "1234567890123456789");
  assert.equal(getReplyContext(dialogFixture(), {locationHref, clickedContext: context({text: "另一条内容。"})}), null);
  assert.equal(getReplyContext(dialogFixture(), {locationHref: "https://x.com/other/status/1234567890123456789"}), null);
  assert.equal(getReplyContext(dialogFixture(), {locationHref: HOME}), null);
});

test("a compact detail-page reply field selects the exact URL context and never arbitrary timeline content", () => {
  const dialog = dialogFixture({articles: [], replyMarker: false, placeholder: "发布你的回复"});
  const timelineContexts = [context({id: "1234567890123456790", text: "前面一条内容。"}), context()];
  const locationHref = "https://x.com/demo_writer/status/1234567890123456789";
  assert.equal(getReplyContext(dialog, {locationHref, timelineContexts}).id, "1234567890123456789");
  assert.equal(getReplyContext(dialog, {locationHref: HOME, timelineContexts}), null);
  assert.equal(getReplyContext(dialog, {locationHref, timelineContexts, clickedContext: timelineContexts[0]}), null);
});

test("unvalidated clicked contexts cannot invent an ID, author or source URL", () => {
  const actual = context();
  for (const clickedContext of [
    {...actual, id: "1234567890123456790"},
    {...actual, author: "@other"},
    {...actual, url: "https://evil.example/demo_writer/status/1234567890123456789"},
    {...actual, text: ""}
  ]) assert.equal(getReplyContext(dialogFixture(), {locationHref: HOME, clickedContext}), null);
});

test("detail main with several reply articles selects only the exact original ID", () => {
  const scope = dialogFixture({
    articles: [articleFixture({id: "1234567890123456790", text: "别人的回复。"}), articleFixture(), articleFixture({author: "other", id: "1234567890123456791"})],
    replyMarker: false,
    placeholder: "发布你的回复"
  });
  scope.tagName = "MAIN";
  const locationHref = "https://x.com/demo_writer/status/1234567890123456789";
  const actual = getReplyContext(scope, {locationHref, timelineContexts: [context({id: "1234567890123456792", text: "时间线另外一条。"})]});
  assert.equal(actual.id, "1234567890123456789");
  assert.equal(actual.text, "复利要放在风险和波动里看。");
  // The same multiple-source structure inside a dialog stays ambiguous.
  scope.tagName = "DIV";
  assert.equal(getReplyContext(scope, {locationHref}), null);
});

test("detail main refuses missing exact source, conflicting source text and generic editors", () => {
  const locationHref = "https://x.com/demo_writer/status/1234567890123456789";
  const scope = dialogFixture({articles: [articleFixture({id: "1234567890123456790", text: "别人的回复。"})], placeholder: "Post your reply"});
  scope.tagName = "MAIN";
  assert.equal(getReplyContext(scope, {locationHref}), null);
  assert.equal(getReplyContext(scope, {locationHref: HOME, timelineContexts: [context()]}), null);
  assert.equal(getReplyContext(scope, {locationHref, timelineContexts: [context(), context({text: "同一个 ID 却有另一份正文。"})]}), null);
  assert.equal(getReplyContext(scope, {locationHref, timelineContexts: [context(), context()]}).id, "1234567890123456789");
  scope.selectors.set(PLACEHOLDERS_SELECTOR, [element({text: "What's happening?"})]);
  assert.equal(getReplyContext(scope, {locationHref, timelineContexts: [context()]}), null);
  scope.selectors.set(PLACEHOLDERS_SELECTOR, [element({text: "Post your reply"})]);
  scope.selectors.set(MARKERS_SELECTOR, [element({tag: "button", text: "回复 @other"})]);
  assert.equal(getReplyContext(scope, {locationHref, timelineContexts: [context()]}), null);
});

test("detail replyScope isolates the original editor's placeholder from another comment recipient", () => {
  const locationHref = "https://x.com/demo_writer/status/1234567890123456789";
  const scope = dialogFixture({articles: [articleFixture(), articleFixture({author: "commenter", id: "1234567890123456790", text: "评论正文。"})], recipient: "commenter", placeholder: "Post your reply"});
  scope.tagName = "MAIN";
  const firstEditor = scope.querySelector(EDITOR_SELECTOR);
  const replyScope = element({parent: scope});
  firstEditor.parentElement = replyScope;
  replyScope.selectors.set(EDITOR_SELECTOR, [firstEditor]);
  replyScope.selectors.set(PLACEHOLDERS_SELECTOR, [element({parent: replyScope, text: "Post your reply"})]);
  // Reading all of main wrongly sees the later comment's explicit recipient.
  assert.equal(getReplyContext(scope, {locationHref}), null);
  assert.equal(getReplyContext(scope, {locationHref, replyScope}).id, "1234567890123456789");
});

test("a different editor or node outside main cannot impersonate the original replyScope", () => {
  const locationHref = "https://x.com/demo_writer/status/1234567890123456789";
  const scope = dialogFixture({articles: [articleFixture()], placeholder: "Post your reply"});
  scope.tagName = "MAIN";
  const firstEditor = scope.querySelector(EDITOR_SELECTOR);
  const replyScope = element({parent: scope});
  firstEditor.parentElement = replyScope;
  replyScope.selectors.set(EDITOR_SELECTOR, [firstEditor]);
  replyScope.selectors.set(PLACEHOLDERS_SELECTOR, [element({text: "Post your reply"})]);
  const commentScope = element({parent: scope});
  const commentEditor = element({parent: commentScope});
  commentScope.selectors.set(EDITOR_SELECTOR, [commentEditor]);
  commentScope.selectors.set(PLACEHOLDERS_SELECTOR, [element({text: "Post your reply"})]);
  scope.selectors.set(EDITOR_SELECTOR, [firstEditor, commentEditor]);
  const outside = element();
  outside.selectors.set(EDITOR_SELECTOR, [firstEditor]);
  outside.selectors.set(PLACEHOLDERS_SELECTOR, [element({text: "Post your reply"})]);
  assert.equal(getReplyContext(scope, {locationHref, replyScope: commentScope}), null);
  assert.equal(getReplyContext(scope, {locationHref, replyScope: outside}), null);
  assert.equal(getReplyContext(scope, {locationHref, replyScope: scope}), null);
  assert.equal(getReplyContext(scope, {locationHref, replyScope}).id, "1234567890123456789");
});

const mediaBody = "我在认真做一件事。\n这张图只是补充现场。";
const pictureSuffix = "\nhttps://\npic.x.com/ob98q44ikg";

test("one or two duplicated picture URL spans do not prevent an exact clicked-source match", () => {
  const clickedContext = context({text: mediaBody, media: true});
  for (const count of [1, 2]) {
    const modal = dialogFixture({articles: [articleFixture({link: false, text: mediaBody + pictureSuffix.repeat(count), media: true})]});
    const actual = getReplyContext(modal, {locationHref: HOME, clickedContext});
    assert.ok(actual, `picture suffix count ${count}`);
    assert.equal(actual.id, clickedContext.id);
    assert.equal(actual.author, clickedContext.author);
    assert.equal(actual.text, mediaBody);
    assert.equal(actual.hasMedia, true);
  }
});

test("a unique timeline source matches modal text with added picture URL spans", () => {
  const original = context({text: mediaBody, media: true});
  for (const count of [1, 2]) {
    const modal = dialogFixture({articles: [articleFixture({link: false, text: mediaBody + pictureSuffix.repeat(count), media: true})]});
    const actual = getReplyContext(modal, {locationHref: HOME, timelineContexts: [context({text: "另一条正文。"}), original]});
    assert.ok(actual);
    assert.equal(actual.id, original.id);
    assert.equal(actual.text, mediaBody);
    assert.equal(actual.hasMedia, true);
  }
});

test("late duplicated picture links leave the extracted source body stable", () => {
  const original = articleFixture({text: mediaBody, media: true});
  const before = extractArticle(original, HOME);
  original.querySelector('[data-testid="tweetText"]').innerText = mediaBody + pictureSuffix.repeat(2);
  const after = extractArticle(original, HOME);
  assert.equal(after.id, before.id);
  assert.equal(after.text, before.text);
  assert.equal(after.quote, before.quote);
  assert.equal(after.hasMedia, true);
});

test("picture URL normalization preserves ambiguity between distinct same-author body IDs", () => {
  const first = context({text: mediaBody, media: true});
  const second = context({id: "1234567890123456790", text: mediaBody + "\nhttps://pic.x.com/different99", media: true});
  const modal = dialogFixture({articles: [articleFixture({link: false, text: mediaBody + pictureSuffix.repeat(2), media: true})]});
  assert.equal(getReplyContext(modal, {locationHref: HOME, timelineContexts: [first, second]}), null);
  assert.equal(getReplyContext(modal, {locationHref: HOME, timelineContexts: [second, first]}), null);
});

test("a restored reply dialog can use its visible original without inventing a permalink", () => {
  const dialog = dialogFixture();
  assert.equal(getReplyContext(dialog, {locationHref: "https://x.com/compose/post"}), null);
  const actual = getReplyContext(dialog, {locationHref: "https://x.com/compose/post", allowComposerVisible: true});
  assert.equal(actual.contextKind, "composer-visible");
  assert.equal(actual.id, null);
  assert.equal(actual.url, null);
  assert.equal(actual.author, "@demo_writer");
  assert.equal(actual.text, "复利要放在风险和波动里看。");
  assert.equal(actual.quote, "");
  assert.match(actual.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("visible-original fallback cleans picture suffixes and keeps quotes separate from the main body", () => {
  for (const count of [1, 2]) {
    const modal = dialogFixture({articles: [articleFixture({link: false, text: mediaBody + pictureSuffix.repeat(count), quote: "这是引用作者补充的话。", quoteFirst: true, media: true})]});
    const actual = getReplyContext(modal, {locationHref: HOME, allowComposerVisible: true});
    assert.equal(actual.contextKind, "composer-visible");
    assert.equal(actual.id, null);
    assert.equal(actual.url, null);
    assert.equal(actual.text, mediaBody);
    assert.equal(actual.quote, "这是引用作者补充的话。");
    assert.equal(actual.hasMedia, true);
  }
});

test("real source identity retains precedence over the visible-original subtype", () => {
  const cases = [
    [dialogFixture({articles: [articleFixture()]}), {}],
    [dialogFixture(), {clickedContext: context()}],
    [dialogFixture(), {timelineContexts: [context()]}]
  ];
  for (const [dialog, options] of cases) {
    const actual = getReplyContext(dialog, {locationHref: HOME, allowComposerVisible: true, ...options});
    assert.equal(actual.id, "1234567890123456789");
    assert.equal(actual.url, "https://x.com/demo_writer/status/1234567890123456789");
    assert.equal(actual.contextKind, undefined);
  }
});

test("visible-original fallback requires exactly one explicit recipient matching its author", () => {
  const options = {locationHref: HOME, allowComposerVisible: true};
  assert.equal(getReplyContext(dialogFixture({recipient: "other"}), options), null);
  assert.equal(getReplyContext(dialogFixture({recipient: "demo_writer @other"}), options), null);
  assert.equal(getReplyContext(dialogFixture({replyMarker: false, placeholder: "Post your reply"}), options), null);
  assert.equal(getReplyContext(dialogFixture({replyMarker: false, placeholder: "有什么新鲜事？"}), options), null);
  assert.equal(getReplyContext(dialogFixture({editor: false}), options), null);
  const nonDialog = dialogFixture();
  nonDialog.getAttribute = () => "";
  assert.equal(getReplyContext(nonDialog, options), null);
});

test("visible-original fallback refuses multiple descriptions, unreadable originals and conflicting time links", () => {
  const options = {locationHref: HOME, allowComposerVisible: true};
  for (const articles of [
    [articleFixture({link: false}), articleFixture({link: false, text: "另一条原帖正文。"})],
    [articleFixture({link: false}), articleFixture({link: false, author: "other", text: "另一个作者的正文。"})],
    [articleFixture({link: false, text: "", media: true})],
    [articleFixture({link: false, text: "", quote: "只有引用正文。", quoteFirst: true})],
    [articleFixture({sourceHref: "https://x.com/other/status/1234567890123456789"})],
    [articleFixture({sourceHref: "https://evil.example/demo_writer/status/1234567890123456789"})],
    [articleFixture({sourceHref: "https://x.com/demo_writer/status/1234567890123456789/photo/1"})]
  ]) assert.equal(getReplyContext(dialogFixture({articles}), options), null);
});

test("visible-original fallback does not erase conflicting timeline identity evidence", () => {
  const options = {locationHref: HOME, allowComposerVisible: true};
  const first = context({text: mediaBody, media: true});
  const second = context({id: "1234567890123456790", text: mediaBody, media: true});
  const dialog = dialogFixture({articles: [articleFixture({link: false, text: mediaBody + pictureSuffix.repeat(2), media: true})]});
  assert.equal(getReplyContext(dialog, {...options, timelineContexts: [first, second]}), null);
  assert.equal(getReplyContext(dialog, {...options, timelineContexts: [second, first]}), null);
});

const image = (name, alt = "") => ({kind: "image", url: `https://pbs.twimg.com/media/${name}?format=jpg&name=small`, ...(alt ? {alt} : {})});

test("source captures body images and video posters but excludes quoted media and avatars", () => {
  for (const quoteKind of ["role", "quoteTweet", "card.wrapper"]) {
    const source = context({photoLink: true, quote: "引用正文", quoteKind, mediaItems: [image("main1", "  项目  收入图  "), {kind: "video-poster", url: "https://pbs.twimg.com/ext_tw_video_thumb/12345/pu/img/cover.jpg"}, image("avatar")], quoteMediaItems: [image("quote1")]});
    assert.deepEqual(source.media.slice(0, 2), [image("main1", "项目 收入图"), {kind: "video-poster", url: "https://pbs.twimg.com/ext_tw_video_thumb/12345/pu/img/cover.jpg"}]);
    assert.equal(source.media.some(item => item.url.includes("quote1")), false);
    assert.equal(source.hasMedia, true);
  }
  const source = context({mediaItems: [{kind: "image", url: "https://pbs.twimg.com/profile_images/1234/avatar.jpg"}, {kind: "video-poster", imagePoster: true, url: "https://pbs.twimg.com/amplify_video_thumb/1234/img/cover.jpg"}]});
  assert.deepEqual(source.media, [{kind: "video-poster", url: "https://pbs.twimg.com/amplify_video_thumb/1234/img/cover.jpg"}]);
});

test("source media is limited to four unique public pbs image paths with short optional ALT", () => {
  const mediaItems = [
    {kind: "image", url: "http://pbs.twimg.com/media/insecure"},
    {kind: "image", url: "https://pbs.twimg.com.evil.example/media/foreign"},
    {kind: "image", url: "https://user@pbs.twimg.com/media/credential"},
    {kind: "image", url: "https://pbs.twimg.com:4433/media/port"},
    {kind: "image", url: "https://pbs.twimg.com/media/a..b"},
    image("one", "图片"), {...image("one"), url: "https://pbs.twimg.com/media/one?format=png&name=large"},
    image("two", "字".repeat(600)), image("three"), image("four"), image("five")
  ];
  const source = context({mediaItems});
  assert.equal(source.media.length, 4);
  assert.equal("alt" in source.media[0], false);
  assert.equal(Array.from(source.media[1].alt).length, 500);
  assert.equal(source.media.some(item => item.url.includes("five")), false);
});

test("image-only originals keep an empty body and still require a proven author and source", () => {
  const original = articleFixture({text: "", mediaItems: [image("image_only")]});
  const source = extractArticle(original, HOME);
  assert.equal(source.text, "");
  assert.deepEqual(source.media, [image("image_only")]);
  const modal = dialogFixture({articles: [articleFixture({link: false, text: "", mediaItems: [image("image_only")]})]});
  assert.equal(getReplyContext(modal, {locationHref: HOME, clickedContext: source}).id, source.id);
  const visible = getReplyContext(modal, {locationHref: HOME, allowComposerVisible: true});
  assert.equal(visible.contextKind, "composer-visible");
  assert.equal(visible.text, "");
  assert.equal(getReplyContext(dialogFixture({articles: [original], recipient: "other"}), {locationHref: HOME, allowComposerVisible: true}), null);
  assert.equal(extractArticle(articleFixture({text: "", quote: "引用正文", quoteMediaItems: [image("only_quote")]}), HOME), null);
});

test("a source-less image-only modal cannot match another image-only tweet from the same author", () => {
  const source = context({text: "", mediaItems: [image("one")]});
  const modal = dialogFixture({articles: [articleFixture({link: false, text: "", mediaItems: [image("two")]})]});
  assert.equal(getReplyContext(modal, {locationHref: HOME, clickedContext: source, timelineContexts: [source]}), null);
  const sameImageDifferentIds = [source, context({id: "1234567890123456790", text: "", mediaItems: [image("one")]})];
  const matchingModal = dialogFixture({articles: [articleFixture({link: false, text: "", mediaItems: [image("one")]})]});
  assert.equal(getReplyContext(matchingModal, {locationHref: HOME, timelineContexts: sameImageDifferentIds, allowComposerVisible: true}), null);
});

test("modal without media keeps validated matching original media, without mixing a different visible gallery", () => {
  const clicked = context({mediaItems: [image("original")]});
  assert.deepEqual(getReplyContext(dialogFixture(), {locationHref: HOME, clickedContext: clicked}).media, clicked.media);
  const explicit = dialogFixture({articles: [articleFixture({mediaItems: [image("current")]})]});
  assert.deepEqual(getReplyContext(explicit, {locationHref: HOME, clickedContext: clicked}).media, [image("current")]);
  const unrelated = dialogFixture({articles: [articleFixture({link: false, mediaItems: [image("different")]})]});
  assert.equal(getReplyContext(unrelated, {locationHref: HOME, clickedContext: clicked}), null);
});

test("detail source rejects media conflicts for the same source ID rather than combining stale snapshots", () => {
  const scope = dialogFixture({articles: [articleFixture({mediaItems: [image("new")]}), articleFixture({author: "reply_author", id: "1234567890123456790", mediaItems: [image("reply")]})], placeholder: "Post your reply", replyMarker: false});
  scope.tagName = "MAIN";
  const source = getReplyContext(scope, {locationHref: "https://x.com/demo_writer/status/1234567890123456789", timelineContexts: [context({mediaItems: [image("old")]})]});
  assert.equal(source, null);
  const current = getReplyContext(scope, {locationHref: "https://x.com/demo_writer/status/1234567890123456789", timelineContexts: [context({mediaItems: [image("new")]})]});
  assert.deepEqual(current.media, [image("new")]);
});

test("image-only clicked source must match the entire gallery rather than one shared image", () => {
  const clicked = context({text: "", mediaItems: [image("shared"), image("old")]});
  const current = context({id: "1234567890123456790", text: "", mediaItems: [image("shared"), image("current")]});
  const modal = dialogFixture({articles: [articleFixture({link: false, text: "", mediaItems: [image("shared"), image("current")]})]});
  assert.equal(getReplyContext(modal, {locationHref: HOME, clickedContext: clicked}), null);
  assert.equal(getReplyContext(modal, {locationHref: HOME, clickedContext: clicked, timelineContexts: [clicked, current]}).id, current.id);
  const partial = dialogFixture({articles: [articleFixture({link: false, text: "", mediaItems: [image("shared")]})]});
  assert.equal(getReplyContext(partial, {locationHref: HOME, clickedContext: clicked}), null);
});

test("media identity ignores name resolution but preserves format and rejects same-ID conflicts", () => {
  const first = image("same");
  const large = {...first, url: "https://pbs.twimg.com/media/same?name=large&format=jpg"};
  const differentFormat = {...first, url: "https://pbs.twimg.com/media/same?name=small&format=png"};
  const clicked = context({text: "", mediaItems: [first]});
  const modal = dialogFixture({articles: [articleFixture({link: false, text: "", mediaItems: [large]})]});
  assert.equal(getReplyContext(modal, {locationHref: HOME, clickedContext: clicked}).id, clicked.id);
  assert.equal(getReplyContext(modal, {locationHref: HOME, clickedContext: context({text: "", mediaItems: [differentFormat]})}), null);
  const scope = dialogFixture({articles: [articleFixture({text: "", mediaItems: [large]})], placeholder: "Post your reply", replyMarker: false});
  scope.tagName = "MAIN";
  const locationHref = "https://x.com/demo_writer/status/1234567890123456789";
  assert.equal(getReplyContext(scope, {locationHref, timelineContexts: [clicked]}).id, clicked.id);
  assert.equal(getReplyContext(scope, {locationHref, timelineContexts: [context({text: "", mediaItems: [differentFormat]})]}), null);
  const compact = dialogFixture({articles: [], placeholder: "Post your reply", replyMarker: false});
  assert.equal(getReplyContext(compact, {locationHref, timelineContexts: [clicked, context({text: "", mediaItems: [differentFormat]})]}), null);
});

test("real DOM photo wrappers cannot promote quote media or adjacent replies into the source", () => {
  const dom = new JSDOM(`<div role="dialog">
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="https://x.com/MediaAuthor">原作者</a> <span>@MediaAuthor</span> <a href="https://x.com/MediaAuthor/status/123456789"><time>1小时</time></a></div>
      <a href="https://x.com/MediaAuthor/status/123456789/photo/1"><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/body?format=jpg&amp;name=small" alt="正文图片"></div></a>
      <div role="link"><div data-testid="User-Name"><a href="https://x.com/quoted">引用作者</a><span>@quoted</span></div><div data-testid="tweetText">引用文字</div><a href="https://x.com/quoted/status/223456789/photo/1"><img src="https://pbs.twimg.com/media/quote"></a></div>
    </article>
    <button>回复 @MediaAuthor</button><div role="textbox" contenteditable="true" aria-label="发布你的回复"></div>
  </div>
  <article data-testid="tweet"><img src="https://pbs.twimg.com/media/recommendation"></article>`, {url: HOME});
  try {
    const dialog = dom.window.document.querySelector('[role="dialog"]');
    const source = getReplyContext(dialog, {locationHref: HOME, allowComposerVisible: true});
    assert.equal(source.id, "123456789");
    assert.equal(source.text, "");
    assert.equal(source.quote, "引用文字");
    assert.deepEqual(source.media, [{...image("body"), alt: "正文图片"}]);
  } finally { dom.window.close(); }
});
