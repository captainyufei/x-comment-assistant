import test from "node:test";
import assert from "node:assert/strict";

test("background keeps pairing private, captures only on request, and restores source-bound job results", async t => {
  const runtimeId = "a".repeat(32);
  const pairingCode = "test-pairing-code-0123456789";
  const source = {id: "1234567890123456789", text: "AI 回复要保留自己的观察。", url: "https://x.com/demo_user/status/1234567890123456789", authorName: "示例用户"};
  const callbacks = {};
  const session = {};
  const local = {replyTransport: "bridge"};
  const events = [];
  const openedTabs = [];
  let jobStatus = "running";
  let captureContexts = [source];
  let injected = 0;
  const candidates = ["witty", "humor", "insight", "story"].map((style, i) => ({style, label: style, text: `候选 ${i}`}));
  const storageArea = data => ({
    async get(key) { return structuredClone({[key]: data[key]}); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async setAccessLevel(value) { assert.equal(value.accessLevel, "TRUSTED_CONTEXTS"); }
  });
  const chromePrevious = globalThis.chrome;
  const fetchPrevious = globalThis.fetch;
  globalThis.chrome = {
    storage: {session: storageArea(session), local: storageArea(local)},
    runtime: {
      id: runtimeId,
      onMessage: {addListener(callback) { callbacks.message = callback; }},
      onInstalled: {addListener(callback) { callbacks.installed = callback; }},
      async sendMessage() {}
    },
    action: {async openPopup(options) { events.push(["popup", options]); }},
    sidePanel: {open() { events.push("open"); return Promise.resolve(); }},
    contextMenus: {async removeAll() {}, create() {}, onClicked: {addListener(callback) { callbacks.menu = callback; }}},
    tabs: {
      async query() { return [{id: 1, windowId: 1, url: "https://x.com/home"}]; },
      async create(options) { openedTabs.push(options.url); }
    },
    scripting: {async executeScript(options) {
      events.push("capture"); injected += 1;
      assert.equal(options.target.tabId, 1);
      assert.equal(typeof options.func, "function");
      return [{result: {contexts: captureContexts}}];
    }}
  };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, "http://127.0.0.1:8769");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    if (path === "/health") {
      assert.equal(options.headers["X-Reply-Bridge-Token"], undefined);
      assert.equal(options.headers["X-Reply-Protocol"], undefined);
      return Response.json({service: "x-reply-codex-bridge", authenticated: true, authentication: "ChatGPT"});
    }
    assert.equal(options.headers["X-Reply-Bridge-Token"], pairingCode);
    assert.equal(options.headers["X-Reply-Protocol"], '4');
    if (path === "/pair") return Response.json({paired: true});
    if (path === "/jobs" && options.method === "POST") {
      const request = JSON.parse(options.body);
      assert.equal(request.context.text, "我修正后的原文。");
      assert.equal(request.preferences.style, "all");
      return Response.json({job: {id: "job-123", status: "running"}});
    }
    if (path === "/jobs/job-123") return Response.json({job: {id: "job-123", status: jobStatus, ...(jobStatus === "completed" ? {candidates, contextStatus: "sufficient", missingContext: ""} : {})}});
    throw new Error("unexpected endpoint");
  };
  try {
    await import(`./extension/background.js?test=${Date.now()}`);
    const sender = {id: runtimeId, url: `chrome-extension://${runtimeId}/panel.html`};
    const message = (value, from = sender) => new Promise(resolve => callbacks.message(value, from, resolve));

    await t.test("startup and state reads never inject page scripts", async () => {
      const response = await message({type: "getState"});
      assert.equal(response.ok, true);
      assert.deepEqual(response.state.contexts, []);
      assert.equal(injected, 0);
    });
    await t.test("web pages and content scripts cannot invoke a privileged action", async () => {
      const result = await message({type: "capture"}, {...sender, tab: {id: 1}, url: "https://x.com/home"});
      assert.equal(result.code, "UNTRUSTED_SENDER");
      assert.equal(injected, 0);
    });
    await t.test("context menu opens only the compact popup; explicit legacy capture remains source-bound", async () => {
      callbacks.menu({menuItemId: "reply-selected-tweet", selectionText: "do not capture"}, {id: 1, windowId: 1, url: "https://x.com/home"});
      assert.deepEqual(events, [["popup", {windowId: 1}]]);
      assert.equal(injected, 0);
      const response = await message({type: "capture"});
      assert.deepEqual(events, [["popup", {windowId: 1}], "capture"]);
      assert.equal(response.state.selectedContext.id, source.id);
      assert.equal(injected, 1);
    });
    await t.test("pairing is checked by the bridge and only its boolean is returned", async () => {
      const response = await message({type: "saveSettings", pairingCode, preferences: {tone: "轻松"}});
      assert.equal(response.ok, true);
      assert.equal(response.state.settings.paired, true);
      assert.equal(JSON.stringify(response).includes(pairingCode), false);
      assert.equal(JSON.stringify(local).includes(pairingCode), false);
      assert.equal(session.replySessionState.pairingToken, pairingCode);
    });
    await t.test("generation accepts text corrections and preserves their source snapshot", async () => {
      const response = await message({type: "generate", context: {...source, text: "我修正后的原文。"}});
      assert.equal(response.ok, true);
      assert.equal(response.job.status, "running");
      assert.equal(response.job.context.text, "我修正后的原文。");
      const duplicate = await message({type: "generate", context: source});
      assert.equal(duplicate.code, "JOB_RUNNING");
    });
    await t.test("completion persists all candidates alongside the original generation context", async () => {
      jobStatus = "completed";
      const response = await message({type: "pollJob", id: "job-123"});
      assert.equal(response.ok, true);
      assert.equal(response.state.results.length, 4);
      assert.equal(response.state.resultsContext.text, "我修正后的原文。");
      assert.ok(response.state.results.every(candidate => candidate.context.id === source.id));
      assert.equal(JSON.stringify(response).includes(pairingCode), false);
    });
    await t.test("saved reply source can be regenerated after capturing a different timeline screen", async () => {
      captureContexts = [{...source, id: "2234567890123456789", url: "https://x.com/other/status/2234567890123456789", text: "另一条推文。"}];
      const recaptured = await message({type: "capture"});
      assert.equal(recaptured.state.contexts[0].id, captureContexts[0].id);
      assert.equal(recaptured.state.resultsContext.id, source.id);
      const response = await message({type: "generate", context: recaptured.state.resultsContext});
      assert.equal(response.ok, true);
      assert.equal(response.job.context.id, source.id);
    });
    await t.test("opening a reply creates only an encoded X intent tab", async () => {
      const response = await message({type: "openReply", context: source, draftText: "有点道理 & 试试 🤔"});
      assert.equal(response.opened, true);
      assert.equal(openedTabs.length, 1);
      const intent = new URL(openedTabs[0]);
      assert.equal(intent.pathname, "/intent/post");
      assert.equal(intent.searchParams.get("text"), "有点道理 & 试试 🤔");
      const invalid = await message({type: "openReply", context: {...source, id: "2"}, draftText: "回复"});
      assert.equal(invalid.ok, false);
      assert.equal(openedTabs.length, 1);
    });
  } finally {
    globalThis.chrome = chromePrevious;
    globalThis.fetch = fetchPrevious;
  }
});
