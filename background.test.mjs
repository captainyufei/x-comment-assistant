import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {REPLY_PROTOCOL_VERSION, sourceFromUrl, validateContext, validateInlineContext, validatePreferences, buildReplyIntent, isTrustedSender, isTrustedInlineSender, ownsInlineSession, publicHealth, publicState, normalizeCandidates, normalizeUnderstanding, validateInlineFeedback} from "./extension/background-core.js";

const context = {id: "1234567890123456789", url: "https://x.com/demo_user/status/1234567890123456789", text: "AI 回复要保留自己的观察。", authorName: "示例用户"};
const composerContext = {contextKind: "composer-visible", id: null, url: null, author: "@0xyouyu", text: "回复弹窗里实际显示的原文。", authorName: "有鱼", quote: "", hasMedia: true, capturedAt: "2026-10-10T10:00:00.000Z"};

test('reply protocol identifies the four-type compact response contract', () => {
  assert.equal(REPLY_PROTOCOL_VERSION, '4');
});

test("source links normalize Twitter and strip query without accepting unrelated paths", () => {
  assert.deepEqual(sourceFromUrl("https://twitter.com/demo_user/status/1234567890123456789?s=20"), {id: context.id, handle: "demo_user", url: context.url});
  for (const url of ["http://x.com/a/status/1", "https://evil.test/a/status/1", "https://x.com/a/status/1/photo/1", "https://x.com/a/status/1/analytics", "https://x.com:8769/a/status/1", "https://secret@x.com/a/status/1", "https://x.com/a/status/notanid"]) assert.throws(() => sourceFromUrl(url));
});

test("source ID must agree with permalink and source content is bounded", () => {
  assert.equal(validateContext(context).author, "@demo_user");
  assert.throws(() => validateContext({...context, id: "other"}), /编号不一致/);
  assert.throws(() => validateContext({...context, text: ""}));
  assert.throws(() => validateContext({...context, text: "a".repeat(12001)}));
  assert.equal(validateContext({...context, token: "secret"}).token, undefined);
  for (const id of ["1234", "1".repeat(26)]) assert.throws(() => sourceFromUrl(`https://x.com/demo_user/status/${id}`));
  for (const id of ["12345", "1".repeat(25)]) assert.equal(sourceFromUrl(`https://x.com/demo_user/status/${id}`).id, id);
});

test("reply URL preserves Unicode and text literally, and never creates a sending request", () => {
  const draft = "🤣 这个观察值一杯咖啡！ & 下一步 #试试 ?";
  const url = new URL(buildReplyIntent(context, draft));
  assert.equal(url.origin, "https://x.com");
  assert.equal(url.pathname, "/intent/post");
  assert.equal(url.searchParams.get("in_reply_to"), context.id);
  assert.equal(url.searchParams.get("text"), draft);
  assert.equal(url.searchParams.size, 2);
  assert.doesNotThrow(() => buildReplyIntent(context, "🤣".repeat(280)));
  assert.throws(() => buildReplyIntent(context, "🤣".repeat(281)));
});

test("visible composer content supports only explicit inline generation and never invents a post identity", () => {
  assert.deepEqual(validateInlineContext({...composerContext, pairingToken: "secret"}), composerContext);
  assert.deepEqual(validateInlineContext(context), validateContext(context));
  const candidates = ["witty", "humor", "insight", "story"].map((style, i) => ({style, label: "中文角度", text: `中文候选 ${i}`}));
  assert.ok(normalizeCandidates(candidates, composerContext, {inline: true}).every(candidate => candidate.context.contextKind === "composer-visible" && candidate.context.id === null && candidate.context.url === null));
  assert.throws(() => validateContext(composerContext), /真实链接/);
  assert.throws(() => normalizeCandidates(candidates, composerContext), /真实链接/);
  assert.throws(() => buildReplyIntent(composerContext, "一条中文回复。"), /真实链接/);
});

test("composer validation rejects mixed or missing identities, malformed authors and unknown source kinds", () => {
  for (const changed of [
    {id: "1234567890123456789"}, {url: context.url}, {id: undefined}, {url: undefined},
    {author: "0xyouyu"}, {author: " @0xyouyu"}, {author: "@too_long_handle_0"}, {author: "@有鱼"},
    {text: " "}, {text: "中".repeat(12001)}, {quote: "中".repeat(5001)}, {capturedAt: "x".repeat(101)},
    {contextKind: "guessed"}, {contextKind: ""}, {contextKind: null}
  ]) assert.throws(() => validateInlineContext({...composerContext, ...changed}));
  for (const contextKind of ["permalink", "guessed", null, ""]) assert.throws(() => validateInlineContext({...context, contextKind}));
});

test("only exact same-extension panel and setup pages pass extension-page trust", () => {
  const id = "a".repeat(32);
  assert.equal(isTrustedSender({id, url: `chrome-extension://${id}/panel.html`}, id), true);
  assert.equal(isTrustedSender({id, url: `chrome-extension://${id}/setup.html`}, id), true);
  assert.equal(isTrustedSender({id, tab: {id: 42}, url: `chrome-extension://${id}/setup.html`}, id), true);
  assert.equal(isTrustedSender({id, tab: {id: 42}, url: `chrome-extension://${id}/panel.html`}, id), false);
  for (const sender of [{id, tab: {id: 1}, url: "https://x.com"}, {id, url: `chrome-extension://${id}/other.html`}, {id: "b".repeat(32), url: `chrome-extension://${id}/panel.html`}, {id, url: "https://x.com/panel.html"}, {id, url: `chrome-extension://${id}/setup.html?token=secret`}]) assert.equal(isTrustedSender(sender, id), false);
});

test("inline requests trust only this extension's top-frame X content in an identified document", () => {
  const id = "a".repeat(32);
  const sender = {id, tab: {id: 1}, frameId: 0, documentId: "document-a", url: "https://x.com/home"};
  assert.equal(isTrustedInlineSender(sender, id), true);
  assert.equal(isTrustedInlineSender({...sender, url: "https://twitter.com/user/status/12345"}, id), true);
  for (const changed of [
    {id: "b".repeat(32)}, {tab: undefined}, {tab: {id: "1"}}, {tab: {id: -1}},
    {documentId: ""}, {documentId: undefined}, {frameId: 1}, {frameId: undefined},
    {url: "http://x.com/home"}, {url: "https://x.com.evil.test/home"}, {url: "https://x.com:8769/home"},
    {url: "https://secret@x.com/home"}, {url: `chrome-extension://${id}/panel.html`}
  ]) assert.equal(isTrustedInlineSender({...sender, ...changed}, id), false);
});

test("inline ownership survives a same-document route but cannot move to another tab or document", () => {
  const session = {owner: {tabId: 1, documentId: "a", frameId: 0}};
  const sender = {tab: {id: 1}, documentId: "a", frameId: 0, url: "https://x.com/home"};
  assert.equal(ownsInlineSession(session, {...sender, url: "https://x.com/user/status/12345"}), true);
  assert.equal(ownsInlineSession(session, {...sender, tab: {id: 2}}), false);
  assert.equal(ownsInlineSession(session, {...sender, documentId: "b"}), false);
  assert.equal(ownsInlineSession(session, {...sender, frameId: 1}), false);
  assert.equal(ownsInlineSession(undefined, sender), false);
});

test("public health and candidates copy only documented fields", () => {
  const health = publicHealth({health: {authenticated: true, authentication: "ChatGPT", service: "reply", token: "secret", pairingToken: "secret", internal: {token: "secret"}}});
  assert.deepEqual(health, {service: "reply", version: "", codexVersion: "", authenticated: true, authentication: "ChatGPT"});
  const values = ["witty", "humor", "insight", "story"].map((style, index) => ({style, label: style, text: `候选 ${index}`, token: "secret"}));
  assert.equal(JSON.stringify(normalizeCandidates(values, context)).includes("secret"), false);
});

test("public state exposes paired flag without local token", () => {
  const state = publicState({pairingToken: "secret", pairingVerified: true, contexts: [context]});
  assert.equal(state.settings.paired, true);
  assert.equal(JSON.stringify(state).includes("secret"), false);
  assert.equal(publicState({pairingToken: "stale-secret"}).settings.paired, false);
  assert.equal(publicState({pairingToken: "stale-secret", pairingVerified: false}).settings.paired, false);
});

test("candidate snapshots survive switching selected tweet", () => {
  const candidates = ["witty", "humor", "insight", "story"].map((style, i) => ({style, label: style, text: `候选 ${i}`}));
  const normalized = normalizeCandidates(candidates, context);
  assert.equal(normalized.length, 4);
  assert.ok(normalized.every(item => item.context.id === context.id && item.context !== context));
  const natural = normalizeCandidates(candidates.slice(0, 2), context);
  assert.equal(natural.length, 2);
  assert.ok(natural.every(item => item.context.id === context.id && item.context !== context));
  assert.throws(() => normalizeCandidates(candidates.slice(0, 1), context));
  assert.throws(() => normalizeCandidates(candidates.slice(1), context));
  assert.throws(() => normalizeCandidates(candidates.map(item => ({...item, text: "重复"})), context));
});

test("preferences only keep supported bounded fields", () => {
  assert.deepEqual(validatePreferences({style: "humor", tone: "轻松", token: "secret"}), {style: "humor", tone: "轻松", personalExperience: ""});
  assert.throws(() => validatePreferences({style: "automatic-send"}));
  assert.throws(() => validatePreferences({personalExperience: "a".repeat(3001)}));
});

const understanding = {meaning: '作者在反讽加班，想有人接住吐槽。', signals: ['反讽', '吐槽'], evidence: ['太好了与凌晨加班形成反差。'], contextStatus: 'sufficient', missingContext: '', replyAction: '顺着加班的吐槽接一句，不祝贺。'};

test('understanding copies only bounded documented fields and requires a specific missing-context gap', () => {
  assert.deepEqual(normalizeUnderstanding({...understanding, token: 'secret', internal: {token: 'secret'}}), understanding);
  for (const changed of [
    {meaning: ''}, {meaning: '中'.repeat(201)}, {signals: '反讽'}, {signals: Array(5).fill('反讽')},
    {signals: ['中'.repeat(31)]}, {evidence: Array(4).fill('依据')}, {evidence: ['中'.repeat(201)]},
    {contextStatus: 'certain'}, {missingContext: '中'.repeat(301)}, {replyAction: ''}, {replyAction: '中'.repeat(81)},
    {contextStatus: 'missing', missingContext: ''}
  ]) assert.throws(() => normalizeUnderstanding({...understanding, ...changed}));
});

test('new interpretation jobs allow one or two natural replies and zero only with a stated context gap', () => {
  const candidates = ['witty', 'humor', 'insight', 'story'].map((style, i) => ({style, label: '接一句', text: `候选 ${i}`}));
  assert.equal(normalizeCandidates(candidates.slice(0, 1), context, {understanding}).length, 1);
  assert.equal(normalizeCandidates(candidates.slice(0, 2), context, {understanding}).length, 2);
  assert.throws(() => normalizeCandidates(candidates.slice(0, 3), context, {understanding}));
  assert.equal(normalizeCandidates(candidates, context, {understanding, style: 'humor'}).length, 4);
  assert.throws(() => normalizeCandidates([], context, {understanding}));
  const missing = {...understanding, contextStatus: 'missing', missingContext: '缺少视频的对白，封面不足以判断笑点。'};
  assert.deepEqual(normalizeCandidates([], context, {understanding: missing}), []);
  assert.throws(() => normalizeCandidates(candidates.slice(0, 1), context, {understanding: missing}));
  assert.deepEqual(normalizeCandidates([], context, {understanding: {...missing, contextStatus: 'limited'}}), []);
  assert.throws(() => normalizeCandidates([], context, {understanding: {...understanding, contextStatus: 'limited'}}));
  assert.throws(() => normalizeCandidates(candidates.slice(0, 2), context, {understanding, style: 'auto-send'}));
  // Legacy service/cache responses still require exactly two or four candidates.
  assert.throws(() => normalizeCandidates([], context));
  assert.throws(() => normalizeCandidates(candidates.slice(0, 1), context));
  assert.equal(normalizeCandidates(candidates, context).length, 4);
});

test('compact jobs require all four unique types, preserve owned source and defer only with a concrete context gap', () => {
  const candidates = ['witty', 'humor', 'insight', 'story'].map((style, i) => ({style, label: '中文类型', text: `候选 ${i}`}));
  const all = {style: 'all', contextStatus: 'sufficient', missingContext: ''};
  const normalized = normalizeCandidates(candidates, context, all);
  assert.deepEqual(normalized.map(candidate => candidate.style), ['witty', 'humor', 'insight', 'story']);
  assert.ok(normalized.every(candidate => candidate.context.id === context.id && candidate.context !== context));
  for (const items of [[], candidates.slice(0, 1), candidates.slice(0, 2), candidates.slice(0, 3), [...candidates, candidates[0]], [...candidates.slice(0, 3), {...candidates[3], style: 'insight'}]]) {
    assert.throws(() => normalizeCandidates(items, context, all));
  }
  assert.throws(() => normalizeCandidates(candidates, context, {style: 'all'}));
  const missing = {style: 'all', contextStatus: 'missing', missingContext: '没有收到原帖视频对白，无法判断是在夸赞还是反讽。'};
  assert.deepEqual(normalizeCandidates([], context, missing), []);
  assert.throws(() => normalizeCandidates(candidates, context, missing));
  assert.throws(() => normalizeCandidates([], context, {...missing, missingContext: ''}));
  assert.throws(() => normalizeCandidates([], context, {...missing, missingContext: '缺少上下文'}));
  assert.equal(normalizeCandidates(candidates, context, {...all, contextStatus: 'limited', missingContext: '没有演示图片，只回应已给出的文字建议。'}).length, 4);
  assert.throws(() => normalizeCandidates(candidates, context, {...all, contextStatus: 'limited'}));
  assert.throws(() => normalizeCandidates(candidates, context, {...all, missingContext: '没有收到原帖图片。'}));
});

test('local opinion notes require explicit supported categories and bounded nonempty text', () => {
  assert.deepEqual(validateInlineFeedback({category: 'voice', note: '  我平时不会讲这种大道理。  '}), {category: 'voice', note: '我平时不会讲这种大道理。'});
  for (const feedback of [null, [], {}, {category: 'clicked', note: '认可'}, {category: 'voice', note: ''}, {category: 'other', note: '中'.repeat(1201)}, {category: 'other', note: '意见', context: context}, {category: 'other', note: '意见', token: 'secret'}]) assert.throws(() => validateInlineFeedback(feedback));
});

test("manifest grants only supported API and loopback hosts with top-frame X composers", async () => {
  const manifest = JSON.parse(await readFile(new URL("./extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.13.1");
  assert.deepEqual(manifest.host_permissions, ["https://api.deepseek.com/*", "https://api.openai.com/*", "https://dashscope.aliyuncs.com/*", "https://dashscope-intl.aliyuncs.com/*", "https://*.cn-beijing.maas.aliyuncs.com/*", "https://api.moonshot.cn/*", "https://api.moonshot.ai/*", "https://api.minimax.cn/*", "https://api.minimax.io/*", "https://ark.cn-beijing.volces.com/*", "https://pbs.twimg.com/*", "http://127.0.0.1/*", "http://localhost/*"]);
  assert.ok(!manifest.host_permissions.some(host => ["<all_urls>", "https://*/*", "http://*/*"].includes(host)));
  for (const host of manifest.host_permissions) assert.ok(manifest.content_security_policy.extension_pages.includes(host.slice(0, -2).replace(/^(http:\/\/(?:localhost|127\.0\.0\.1))$/u, "$1:*")));
  assert.deepEqual(new Set(manifest.permissions), new Set(["activeTab", "scripting", "contextMenus", "storage"]));
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.side_panel, undefined);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["https://x.com/*", "https://twitter.com/*"],
    js: ["reply-style-catalog.js", "composer-source.js", "composer-ui.js", "composer.js"],
    run_at: "document_idle", all_frames: false
  }]);
});
