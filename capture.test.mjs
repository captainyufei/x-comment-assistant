import test from "node:test";
import assert from "node:assert/strict";
import {captureVisibleTweets} from "./extension/capture.js";

function node({parentElement = null, role = "", testid = "", tag = "div", href = "", innerText = "", time = false} = {}) {
  return {
    parentElement, href, innerText, tagName: tag.toUpperCase(),
    matches() { return role === "link" || ["quoteTweet", "card.wrapper"].includes(testid) || (tag === "a" && href.includes("/status/")); },
    querySelector(selector) { return selector === "time" && time ? {} : null; }
  };
}

function articleFixture({id = "1234567890123456789", main = "主作者自己的观察。", quote = "", quoteContainer = "role", quoteFirst = false, top = 10, mediaItems = [], quoteMediaItems = [], photoLink = false, author = "demo_user", sourceAuthor = "demo_user"} = {}) {
  const article = node();
  const wrapper = node({parentElement: article});
  const quoteWrapper = node({parentElement: wrapper, ...(quoteContainer === "role" ? {role: "link"} : {testid: quoteContainer})});
  const mainText = main ? node({parentElement: wrapper, innerText: main}) : null;
  const quoteText = quote ? node({parentElement: quoteWrapper, innerText: quote}) : null;
  const mainAuthor = node({parentElement: wrapper, innerText: `示例用户\n@${author}\n·\n1小时`});
  const quoteAuthor = node({parentElement: quoteWrapper, innerText: "引用作者\n@quoted\n·\n2小时"});
  const mainLink = node({parentElement: wrapper, tag: "a", href: `https://x.com/${sourceAuthor}/status/${id}`, time: true});
  const quoteLink = node({parentElement: quoteWrapper, tag: "a", href: "https://x.com/quoted/status/2234567890123456789", time: true});
  const order = (mainNode, quoteNode) => (quoteFirst ? [quoteNode, mainNode] : [mainNode, quoteNode]).filter(Boolean);
  const mediaParent = photoLink ? node({parentElement: wrapper, tag: "a", href: `https://x.com/${sourceAuthor}/status/${id}/photo/1`}) : wrapper;
  const mediaNode = (item, parentElement) => Object.assign(node({parentElement, tag: item.kind === "video-poster" && !item.imagePoster ? "video" : "img"}), {src: item.url, currentSrc: item.currentSrc ?? "", poster: item.url, alt: item.alt ?? ""});
  article.querySelectorAll = selector => {
    if (selector === '[data-testid="tweetText"]') return order(mainText, quoteText);
    if (selector === '[data-testid="User-Name"]') return order(mainAuthor, quote ? quoteAuthor : null);
    if (selector === 'a[href*="/status/"]') return order(mainLink, quote ? quoteLink : null);
    if (selector === "img, video") return [...quoteMediaItems.map(item => mediaNode(item, quoteWrapper)), ...mediaItems.map(item => mediaNode(item, mediaParent))];
    return [];
  };
  article.querySelector = () => null;
  article.getBoundingClientRect = () => ({width: 600, height: 150, left: 0, right: 600, top, bottom: top + 150});
  return article;
}

function captureFixture(articles) {
  const values = {
    location: {hostname: "x.com", href: "https://x.com/home"},
    getComputedStyle: () => ({display: "block", visibility: "visible"}),
    innerHeight: 900,
    innerWidth: 1200,
    document: {querySelectorAll: () => articles}
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  try {
    // Injection serializes the function; this also detects any accidental outer-module dependency.
    const injected = Function(`return (${captureVisibleTweets.toString()})`)();
    return injected();
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
}

test("quote-only cards do not impersonate the containing tweet's main author", () => {
  for (const quoteContainer of ["role", "card.wrapper", "quoteTweet"]) {
    const result = captureFixture([articleFixture({main: "", quote: "这只是被引用作者的正文。", quoteContainer})]);
    assert.deepEqual(result.contexts, []);
    assert.ok(result.error);
  }
});

test("main text and quote remain separate even when a quoted time link appears first", () => {
  for (const quoteContainer of ["role", "card.wrapper", "quoteTweet"]) {
    const result = captureFixture([articleFixture({main: "主作者补充的观点。", quote: "被引用的观点。", quoteContainer, quoteFirst: true})]);
    assert.equal(result.contexts.length, 1);
    const context = result.contexts[0];
    assert.equal(context.text, "主作者补充的观点。");
    assert.equal(context.quote, "被引用的观点。");
    assert.equal(context.id, "1234567890123456789");
    assert.equal(context.author, "@demo_user");
    assert.equal(context.authorName, "示例用户");
  }
});

test("capture reads at most eight visible unique tweets and excludes off-screen articles", () => {
  const visible = Array.from({length: 10}, (_, i) => articleFixture({id: String(1234567890123456789n + BigInt(i)), main: `可见 ${i}`}));
  const hidden = articleFixture({id: "9234567890123456789", main: "屏幕以外", top: 1000});
  const duplicate = articleFixture({id: visible[0].querySelectorAll('a[href*="/status/"]')[0].href.split("/").pop(), main: "重复"});
  const result = captureFixture([hidden, visible[0], duplicate, ...visible.slice(1)]);
  assert.equal(result.contexts.length, 8);
  assert.equal(new Set(result.contexts.map(context => context.id)).size, 8);
  assert.equal(result.contexts.some(context => context.text === "屏幕以外" || context.text === "重复"), false);
});

test("capture and bridge use the same five-to-twenty-five digit source ID range", () => {
  const result = captureFixture([articleFixture({id: "1234"}), articleFixture({id: "1".repeat(26)}), articleFixture({id: "12345"}), articleFixture({id: "1".repeat(25)})]);
  assert.deepEqual(result.contexts.map(context => context.id), ["12345", "1".repeat(25)]);
});

const image = (name, alt = "") => ({kind: "image", url: `https://pbs.twimg.com/media/${name}?format=jpg&name=small`, ...(alt ? {alt} : {})});

test("serialized capture keeps original photo-link images and video covers apart from quote media", () => {
  for (const quoteContainer of ["role", "quoteTweet", "card.wrapper"]) {
    const result = captureFixture([articleFixture({photoLink: true, quote: "引用正文", quoteContainer, mediaItems: [image("body", "  现场  图  "), {kind: "video-poster", url: "https://pbs.twimg.com/tweet_video_thumb/clip.jpg"}], quoteMediaItems: [image("quote")]})]);
    assert.deepEqual(result.contexts[0].media, [image("body", "现场 图"), {kind: "video-poster", url: "https://pbs.twimg.com/tweet_video_thumb/clip.jpg"}]);
    assert.equal(result.contexts[0].hasMedia, true);
    assert.equal(result.contexts[0].quote, "引用正文");
  }
});

test("image-only capture preserves an empty original body and validates its author's permalink", () => {
  const result = captureFixture([
    articleFixture({main: "", mediaItems: [image("unmatched")], author: "different"}),
    articleFixture({main: "", quote: "引用正文", quoteMediaItems: [image("quote_only")]}),
    articleFixture({main: "", mediaItems: [image("image_only")], id: "2234567890123456789"})
  ]);
  assert.equal(result.contexts.length, 1);
  assert.equal(result.contexts[0].text, "");
  assert.deepEqual(result.contexts[0].media, [image("image_only")]);
  assert.equal(result.contexts[0].author, "@demo_user");
});

test("capture rejects avatar and unsafe image URLs, deduplicates and limits media to four", () => {
  const result = captureFixture([articleFixture({mediaItems: [
    {kind: "image", url: "https://pbs.twimg.com/profile_images/123/avatar.jpg"},
    {kind: "image", url: "https://pbs.twimg.com.evil.example/media/foreign"},
    {kind: "image", url: "http://pbs.twimg.com/media/insecure"},
    {kind: "image", url: "https://user@pbs.twimg.com/media/credential"},
    {kind: "image", url: "https://pbs.twimg.com:4433/media/port"},
    image("one", "图片"), {...image("one"), url: "https://pbs.twimg.com/media/one?name=large"},
    image("two", "字".repeat(600)), image("three"), image("four"), image("five")
  ]})]);
  assert.equal(result.contexts[0].media.length, 4);
  assert.equal("alt" in result.contexts[0].media[0], false);
  assert.equal(Array.from(result.contexts[0].media[1].alt).length, 500);
  assert.equal(result.contexts[0].media.some(item => item.url.includes("five")), false);
});

test("capture cleans modal picture-link decoration without inventing image content", () => {
  const result = captureFixture([articleFixture({main: "只有正文。\nhttps://pic.x.com/decorated"})]);
  assert.equal(result.contexts[0].text, "只有正文。");
  assert.deepEqual(result.contexts[0].media, []);
  assert.equal(result.contexts[0].hasMedia, true);
});
