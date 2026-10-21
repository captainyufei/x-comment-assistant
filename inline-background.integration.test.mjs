import test from "node:test";
import assert from "node:assert/strict";

test("inline jobs remain private to their reply document and never grant panel capabilities", async t => {
  const runtimeId = "a".repeat(32);
  const pairingCode = "test-pairing-code-0123456789";
  const sourceA = {id: "1234567890123456789", text: "回复里补一点自己的观察。", url: "https://x.com/demo_user/status/1234567890123456789", authorName: "示例用户"};
  const sourceB = {...sourceA, id: "2234567890123456789", text: "另一个回复窗口的原文。", url: "https://x.com/other/status/2234567890123456789"};
  const composerSource = {contextKind: "composer-visible", id: null, url: null, author: "@0xyouyu", authorName: "有鱼", text: "回复弹窗内显示的原文。", quote: "", hasMedia: true, capturedAt: "2026-10-10T10:00:00.000Z"};
  const panel = {id: runtimeId, url: `chrome-extension://${runtimeId}/panel.html`};
  const setup = {...panel, tab: {id: 42}, frameId: 0, documentId: "extension-setup-document", url: `chrome-extension://${runtimeId}/setup.html`};
  const contentA = {id: runtimeId, tab: {id: 1}, frameId: 0, documentId: "document-a", url: "https://x.com/home"};
  const contentB = {...contentA, tab: {id: 2}, documentId: "document-b"};
  const sessionStorage = {};
  const localStorage = {};
  const callbacks = {};
  const openedTabs = [];
  const calls = [];
  const jobs = new Map();
  let jobNumber = 0;
  let requestCount = 0;
  let nextGetStatus = 200;
  let nextPairStatus = 200;
  let codexAuthenticated = true;
  let holdCreate = null;
  const candidates = ["witty", "humor", "insight", "story"].map((style, i) => ({style, label: style, text: `中文候选 ${i}`, pairingToken: pairingCode, context: sourceB}));
  const area = data => ({
    async get(key) { return structuredClone({[key]: data[key]}); },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async setAccessLevel(value) { assert.equal(value.accessLevel, "TRUSTED_CONTEXTS"); }
  });
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: {session: area(sessionStorage), local: area(localStorage)},
    runtime: {
      id: runtimeId,
      getURL(path) { return `chrome-extension://${runtimeId}/${path}`; },
      onMessage: {addListener(callback) { callbacks.message = callback; }},
      onInstalled: {addListener(callback) { callbacks.installed = callback; }},
      async sendMessage() {}
    },
    action: {onClicked: {addListener(callback) { callbacks.action = callback; }}},
    sidePanel: {async open() {}},
    contextMenus: {async removeAll() {}, create() {}, onClicked: {addListener(callback) { callbacks.menu = callback; }}},
    tabs: {
      async query() { return [{id: 1, url: "https://x.com/home"}]; },
      async create(options) { openedTabs.push(options.url); },
      onRemoved: {addListener(callback) { callbacks.tabRemoved = callback; }}
    },
    scripting: {async executeScript() { return [{result: {contexts: [sourceA]}}]; }}
  };
  globalThis.fetch = async (url, options) => {
    requestCount += 1;
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, "http://127.0.0.1:8769");
    const call = {path, method: options.method, body: options.body ? JSON.parse(options.body) : null};
    calls.push(call);
    if (path === "/health") {
      assert.equal(options.headers["X-Reply-Bridge-Token"], undefined);
      assert.equal(options.headers["X-Reply-Protocol"], undefined);
      return Response.json({authenticated: codexAuthenticated, authentication: "ChatGPT", codexVersion: "test", pairingToken: pairingCode});
    }
    if (path === "/extension/connect") {
      assert.equal(options.headers["X-Reply-Bridge-Token"], undefined);
      assert.equal(options.headers["X-Reply-Protocol"], undefined);
      assert.deepEqual(call.body, {extensionId: runtimeId});
      return Response.json({paired: true, token: pairingCode});
    }
    assert.equal(options.headers["X-Reply-Bridge-Token"], pairingCode);
    assert.equal(options.headers["X-Reply-Protocol"], '4');
    if (path === "/pair") {
      const status = nextPairStatus; nextPairStatus = 200;
      return status === 200 ? Response.json({paired: true, token: pairingCode}) : Response.json({error: `stale ${pairingCode}`, code: "UNPAIRED"}, {status});
    }
    if (path === "/jobs") {
      assert.equal(call.body.preferences.style, "all");
      assert.equal(Object.hasOwn(call.body.preferences, "contextNote"), false);
      const job = {id: `inline-job-${++jobNumber}`, status: "running", contextStatus: "sufficient", missingContext: "", context: sourceB, preferences: {tone: pairingCode}};
      jobs.set(job.id, job);
      if (holdCreate) await holdCreate.promise;
      return Response.json({job});
    }
    const id = path.slice("/jobs/".length);
    if (options.method === "GET" && nextGetStatus !== 200) {
      const status = nextGetStatus; nextGetStatus = 200;
      return Response.json({error: `secret ${pairingCode}`, code: status === 404 ? "JOB_NOT_FOUND" : "PAIRING_EXPIRED"}, {status});
    }
    const job = jobs.get(id);
    if (!job) return Response.json({error: "missing", code: "JOB_NOT_FOUND"}, {status: 404});
    if (options.method === "DELETE") job.status = "cancelled";
    return Response.json({job});
  };
  const message = (value, sender = contentA) => new Promise(resolve => callbacks.message(value, sender, resolve));
  const freshBackground = async () => import(`./extension/background.js?inline-test=${Date.now()}-${Math.random()}`);
  let sessionA;
  let sessionB;
  let jobA;
  let jobB;
  let composerSession;
  let composerJob;
  let secondComposerSession;
  let secondComposerJob;
  try {
    await freshBackground();
    await t.test("untrusted pages and content cannot call panel, pairing, or cross-origin methods", async () => {
      for (const type of ["getState", "capture", "saveSettings", "generate", "pollJob", "cancelJob", "openReply", "inlinePair"]) {
        const result = await message({type, pairingCode, context: sourceA});
        assert.equal(result.code, "UNTRUSTED_SENDER");
      }
      for (const sender of [{...contentA, id: "b".repeat(32)}, {...contentA, url: "https://evil.test/"}, {...contentA, documentId: ""}, {...contentA, frameId: 1}]) {
        assert.equal((await message({type: "inlineInit", context: sourceA}, sender)).code, "UNTRUSTED_SENDER");
      }
      assert.equal(requestCount, 0);
      assert.equal((await message({type: "inlineInit", context: sourceA}, panel)).code, "UNKNOWN_MESSAGE");
    });
    await t.test("setup opens only an extension-origin setup page with pairing and health permissions", async () => {
      assert.deepEqual(await message({type: "inlineOpenSetup", url: "https://evil.test"}), {ok: true, opened: true});
      assert.deepEqual(openedTabs, [`chrome-extension://${runtimeId}/setup.html`]);
      for (const type of ["capture", "generate", "openReply", "setPreferences", "inlineInit", "inlinePair"]) {
        assert.equal((await message({type, context: sourceA}, setup)).code, "UNTRUSTED_SENDER");
      }
      const paired = await message({type: "saveSettings", pairingCode, preferences: {tone: "轻松自然", personalExperience: "个人设置"}}, setup);
      assert.equal(paired.ok, true);
      assert.equal(paired.state.settings.paired, true);
      assert.equal(JSON.stringify(paired).includes(pairingCode), false);
      assert.equal(JSON.stringify(localStorage).includes(pairingCode), false);
      const state = await message({type: "getState"}, setup);
      const health = await message({type: "checkBridge"}, setup);
      assert.equal(state.ok, true);
      assert.equal(health.ok, true);
      assert.equal(JSON.stringify(state).includes(pairingCode), false);
      assert.equal(JSON.stringify(health).includes(pairingCode), false);
      assert.equal((await message({type: "saveSettings", pairingCode}, {...setup, id: "b".repeat(32)})).code, "UNTRUSTED_SENDER");
      assert.equal((await message({type: "saveSettings", pairingCode}, {...setup, url: "https://x.com/setup.html"})).code, "UNTRUSTED_SENDER");
    });
    await t.test("explicit init validates source and returns only owned session metadata", async () => {
      const invalid = await message({type: "inlineInit", context: {...sourceA, id: "1"}});
      assert.equal(invalid.ok, false);
      sessionA = (await message({type: "inlineInit", context: sourceA})).sessionId;
      const result = await message({type: "inlineInit", context: sourceB}, contentB);
      sessionB = result.sessionId;
      assert.deepEqual(Object.keys(result).sort(), ["ok", "paired", "sessionId"]);
      assert.equal(result.paired, true);
      assert.notEqual(sessionA, sessionB);
      const health = await message({type: "inlineHealth"});
      assert.equal(health.paired, true);
      assert.equal(health.health.authenticated, true);
      assert.equal(JSON.stringify(health).includes(pairingCode), false);
    });
    await t.test("concurrent inline jobs cannot overwrite source or start twice", async () => {
      const results = await Promise.all([
        message({type: "inlineGenerate", sessionId: sessionA, style: "mix"}),
        message({type: "inlineGenerate", sessionId: sessionB, style: "humor"}, contentB)
      ]);
      assert.equal(results[0].ok, true);
      assert.equal(results[1].code, "JOB_RUNNING");
      jobA = results[0].job.id;
      assert.equal(results[0].job.context.id, sourceA.id);
      assert.equal(results[0].job.preferences, undefined);
      assert.equal(calls.filter(call => call.path === "/jobs").length, 1);
      const panelState = await message({type: "getState"}, panel);
      assert.equal(panelState.state.job, null);
      assert.equal(panelState.state.selectedContext, null);
      assert.equal(JSON.stringify(panelState).includes(sessionA), false);
      assert.equal((await message({type: "generate", context: sourceA}, panel)).code, "JOB_RUNNING");
    });
    await t.test("poll, cancel, and close reject other tabs, replaced documents, and cross-session job ids", async () => {
      const before = requestCount;
      for (const type of ["inlinePoll", "inlineCancel", "inlineClose"]) {
        assert.equal((await message({type, sessionId: sessionA, id: jobA}, contentB)).code, "INLINE_SESSION_EXPIRED");
        assert.equal((await message({type, sessionId: sessionA, id: jobA}, {...contentA, documentId: "new-document"})).code, "INLINE_SESSION_EXPIRED");
      }
      assert.equal((await message({type: "inlinePoll", sessionId: sessionB, id: jobA}, contentB)).code, "JOB_NOT_FOUND");
      assert.equal(requestCount, before);
    });
    await t.test("worker restoration preserves ownership and candidates never include unexpected secret fields", async () => {
      await freshBackground();
      jobs.get(jobA).status = "completed";
      jobs.get(jobA).candidates = candidates;
      const result = await message({type: "inlinePoll", sessionId: sessionA, id: jobA});
      assert.equal(result.job.status, "completed");
      assert.equal(result.job.candidates.length, 4);
      assert.ok(result.job.candidates.every(candidate => candidate.context.id === sourceA.id));
      assert.equal(JSON.stringify(result).includes(pairingCode), false);
      assert.equal(result.job.preferences, undefined);
      const mutated = await message({type: "inlineGenerate", sessionId: sessionA, context: sourceB, style: "mix"});
      assert.equal(mutated.code, "SOURCE_CHANGED");
      const invalidStyle = await message({type: "inlineGenerate", sessionId: sessionB, preferences: {style: "send-automatically"}}, contentB);
      assert.equal(invalidStyle.ok, false);
    });
    await t.test("closing a completed session leaves another reply window's running job untouched", async () => {
      const started = await message({type: "inlineGenerate", sessionId: sessionB, style: "humor"}, contentB);
      assert.equal(started.ok, true);
      jobB = started.job.id;
      assert.equal(calls.at(-1).body.context.id, sourceB.id);
      assert.equal(calls.at(-1).body.preferences.style, "all");
      const before = requestCount;
      assert.deepEqual(await message({type: "inlineClose", sessionId: sessionA}), {ok: true, closed: true});
      assert.equal(requestCount, before);
      assert.equal(jobs.get(jobB).status, "running");
      assert.equal((await message({type: "inlinePoll", sessionId: sessionA, id: jobA})).code, "INLINE_SESSION_EXPIRED");
      const closed = await message({type: "inlineClose", sessionId: sessionB}, contentB);
      assert.deepEqual(closed, {ok: true, closed: true});
      assert.equal(jobs.get(jobB).status, "cancelled");
      assert.equal(sessionStorage.replySessionState.inlineSessions[sessionB], undefined);
    });
    await t.test("missing bridge jobs unblock a session and expired pairing fails only public state", async () => {
      const initialized = await message({type: "inlineInit", context: sourceA});
      sessionA = initialized.sessionId;
      let started = await message({type: "inlineGenerate", sessionId: sessionA, style: "mix"});
      nextGetStatus = 404;
      const missing = await message({type: "inlinePoll", sessionId: sessionA, id: started.job.id});
      assert.equal(missing.ok, true);
      assert.equal(missing.job.status, "failed");
      assert.equal(JSON.stringify(missing).includes(pairingCode), false);
      started = await message({type: "inlineGenerate", sessionId: sessionA, style: "witty"});
      nextGetStatus = 401;
      const expired = await message({type: "inlinePoll", sessionId: sessionA, id: started.job.id});
      assert.equal(expired.code, "PAIRING_EXPIRED");
      assert.equal(JSON.stringify(expired).includes(pairingCode), false);
      const health = await message({type: "inlineHealth"});
      assert.equal(health.paired, true);
      const ownState = sessionStorage.replySessionState.inlineSessions[sessionA];
      assert.equal(ownState.job.status, "failed");
      assert.deepEqual(await message({type: "inlineClose", sessionId: sessionA}), {ok: true, closed: true});
    });
    await t.test("reloads cancel only obsolete work in their tab and a missed completion poll cannot block the next window", async () => {
      await message({type: "saveSettings", pairingCode}, setup);
      const old = await message({type: "inlineInit", context: sourceA});
      const sibling = await message({type: "inlineInit", context: sourceB}, contentB);
      const started = await message({type: "inlineGenerate", sessionId: old.sessionId, style: "mix"});
      const newDocument = {...contentA, documentId: "document-reloaded"};
      const replacement = await message({type: "inlineInit", context: sourceA}, newDocument);
      assert.equal(replacement.ok, true);
      assert.equal(jobs.get(started.job.id).status, "cancelled");
      assert.equal(sessionStorage.replySessionState.inlineSessions[old.sessionId], undefined);
      assert.ok(sessionStorage.replySessionState.inlineSessions[sibling.sessionId]);
      const next = await message({type: "inlineGenerate", sessionId: replacement.sessionId, style: "mix"}, newDocument);
      jobs.get(next.job.id).status = "completed";
      jobs.get(next.job.id).candidates = candidates;
      const other = await message({type: "inlineGenerate", sessionId: sibling.sessionId, style: "mix"}, contentB);
      assert.equal(other.ok, true);
      assert.equal(sessionStorage.replySessionState.inlineSessions[replacement.sessionId].job.status, "completed");
      callbacks.tabRemoved(1);
      await message({type: "getState"}, panel);
      assert.equal(sessionStorage.replySessionState.inlineSessions[replacement.sessionId], undefined);
      assert.equal(sessionStorage.replySessionState.inlineSessions[sibling.sessionId].job.status, "running");
      assert.equal(jobs.get(other.job.id).status, "running");
      callbacks.tabRemoved(2);
      await message({type: "getState"}, panel);
      assert.equal(sessionStorage.replySessionState.inlineSessions[sibling.sessionId], undefined);
      assert.equal(jobs.get(other.job.id).status, "cancelled");
    });
    await t.test("closing while generation is pending cancels the resulting owned job without retaining a stale session", async () => {
      const initialized = await message({type: "inlineInit", context: sourceA});
      let release;
      holdCreate = {promise: new Promise(resolve => { release = resolve; })};
      const generating = message({type: "inlineGenerate", sessionId: initialized.sessionId, style: "mix"});
      await new Promise(resolve => setTimeout(resolve, 0));
      const closing = message({type: "inlineClose", sessionId: initialized.sessionId});
      release();
      const [generated, closed] = await Promise.all([generating, closing]);
      holdCreate = null;
      assert.equal(generated.ok, true);
      assert.equal(generated.job.context.id, sourceA.id);
      assert.deepEqual(closed, {ok: true, closed: true});
      assert.equal(jobs.get(generated.job.id).status, "cancelled");
      assert.equal(sessionStorage.replySessionState.inlineSessions[initialized.sessionId], undefined);
      assert.equal(JSON.stringify(generated).includes(pairingCode), false);
    });
    await t.test("composer-visible sources remain exclusive to inline sessions and malformed sources never reach the bridge", async () => {
      const before = requestCount;
      for (const changed of [{id: sourceA.id}, {url: sourceA.url}, {author: "0xyouyu"}, {contextKind: "guessed"}, {contextKind: null}]) {
        assert.equal((await message({type: "inlineInit", context: {...composerSource, ...changed}})).ok, false);
      }
      for (const type of ["generate", "openReply"]) {
        assert.equal((await message({type, context: composerSource, draftText: "中文回复"}, panel)).ok, false);
      }
      assert.equal(requestCount, before);
      assert.deepEqual(openedTabs, [`chrome-extension://${runtimeId}/setup.html`]);
    });
    await t.test("explicit composer-visible jobs preserve the displayed original and reject cross-document generation", async () => {
      const initialized = await message({type: "inlineInit", context: {...composerSource, pairingToken: pairingCode}});
      assert.equal(initialized.ok, true);
      composerSession = initialized.sessionId;
      assert.equal((await message({type: "inlineGenerate", sessionId: composerSession}, contentB)).code, "INLINE_SESSION_EXPIRED");
      const generated = await message({type: "inlineGenerate", sessionId: composerSession, style: "mix"});
      assert.equal(generated.ok, true);
      composerJob = generated.job.id;
      assert.deepEqual(calls.at(-1).body.context, composerSource);
      assert.deepEqual(generated.job.context, composerSource);
      assert.equal(JSON.stringify(generated).includes(pairingCode), false);
      for (const type of ["inlinePoll", "inlineCancel", "inlineClose"]) {
        assert.equal((await message({type, sessionId: composerSession, id: composerJob}, contentB)).code, "INLINE_SESSION_EXPIRED");
      }
      assert.equal((await message({type: "getState"}, panel)).state.job, null);
    });
    await t.test("worker restore and missed completion retain null-identity source snapshots for separate composer sessions", async () => {
      await freshBackground();
      jobs.get(composerJob).status = "completed";
      jobs.get(composerJob).candidates = candidates;
      const secondSource = {...composerSource, author: "@second", text: "另一条弹窗原文。"};
      secondComposerSession = (await message({type: "inlineInit", context: secondSource}, contentB)).sessionId;
      assert.notEqual(secondComposerSession, composerSession);
      const generated = await message({type: "inlineGenerate", sessionId: secondComposerSession}, contentB);
      assert.equal(generated.ok, true);
      secondComposerJob = generated.job.id;
      assert.deepEqual(generated.job.context, secondSource);
      const saved = sessionStorage.replySessionState.inlineSessions[composerSession];
      assert.equal(saved.job.status, "completed");
      assert.ok(saved.job.candidates.every(candidate => candidate.context.author === composerSource.author && candidate.context.text === composerSource.text && candidate.context.id === null && candidate.context.url === null));
      assert.equal(JSON.stringify(saved.context).includes(pairingCode), false);
      assert.equal((await message({type: "inlinePoll", sessionId: secondComposerSession, id: composerJob}, contentB)).code, "JOB_NOT_FOUND");
      await message({type: "inlineCancel", sessionId: secondComposerSession, id: secondComposerJob}, contentB);
      const replaced = await message({type: "inlineGenerate", sessionId: composerSession, context: secondSource});
      assert.equal(replaced.code, "SOURCE_CHANGED");
    });
    await t.test("restoring completed composer candidates preserves original ownership and cannot open an intent", async () => {
      await freshBackground();
      const completed = await message({type: "inlinePoll", sessionId: composerSession, id: composerJob});
      assert.equal(completed.ok, true);
      assert.equal(completed.job.status, "completed");
      assert.ok(completed.job.candidates.every(candidate => candidate.context.contextKind === "composer-visible" && candidate.context.author === composerSource.author));
      assert.equal(JSON.stringify(completed).includes(pairingCode), false);
      const before = openedTabs.length;
      assert.equal((await message({type: "openReply", context: completed.job.context, draftText: "中文回复"}, panel)).ok, false);
      assert.equal(openedTabs.length, before);
      assert.deepEqual(await message({type: "inlineClose", sessionId: composerSession}), {ok: true, closed: true});
      assert.deepEqual(await message({type: "inlineClose", sessionId: secondComposerSession}, contentB), {ok: true, closed: true});
    });
    await t.test("cached codes are unverified after worker restore and connection checks authenticate them before reporting paired", async () => {
      await freshBackground();
      const cached = await message({type: "getState"}, setup);
      assert.equal(cached.state.settings.paired, false);
      const before = calls.length;
      const checked = await message({type: "checkBridge"}, setup);
      assert.equal(checked.paired, true);
      assert.deepEqual(calls.slice(before).map(call => call.path), ["/health", "/pair"]);
      assert.equal((await message({type: "getState"}, setup)).state.settings.paired, true);
      assert.equal(JSON.stringify(checked).includes(pairingCode), false);
    });
    await t.test("service-restart expiry reconnects automatically and existing reply sessions preserve their source", async () => {
      const sessionId = (await message({type: "inlineInit", context: composerSource})).sessionId;
      const started = await message({type: "inlineGenerate", sessionId});
      assert.equal(started.ok, true);
      nextPairStatus = 401;
      const before = calls.length;
      const recovered = await message({type: "inlineHealth"});
      assert.equal(recovered.paired, true);
      assert.equal(JSON.stringify(recovered).includes(pairingCode), false);
      assert.equal(sessionStorage.replySessionState.pairingToken, pairingCode);
      assert.equal(sessionStorage.replySessionState.pairingVerified, true);
      assert.equal(sessionStorage.replySessionState.inlineSessions[sessionId].job.status, "failed");
      assert.deepEqual(calls.slice(before).map(call => call.path), ["/health", "/pair", "/extension/connect"]);
      assert.equal((await message({type: "inlineHealth"})).paired, true);
      const resumed = await message({type: "inlineGenerate", sessionId});
      assert.equal(resumed.ok, true);
      assert.deepEqual(resumed.job.context, composerSource);
      await message({type: "inlineClose", sessionId});
    });
    await t.test("Codex logout is distinguished from pairing failure and rechecking restores a valid existing connection", async () => {
      codexAuthenticated = false;
      const before = calls.length;
      const unavailable = await message({type: "inlineHealth"});
      assert.equal(unavailable.code, "AUTH_REQUIRED");
      assert.match(unavailable.error, /当前模型尚未就绪/);
      assert.deepEqual(calls.slice(before).map(call => call.path), ["/health"]);
      assert.equal((await message({type: "getState"}, setup)).state.settings.paired, false);
      assert.equal(sessionStorage.replySessionState.pairingToken, pairingCode);
      const priorSessions = Object.keys(sessionStorage.replySessionState.inlineSessions).length;
      const denied = await message({type: "inlineInit", context: sourceA});
      assert.equal(denied.code, "AUTH_REQUIRED");
      assert.equal(Object.keys(sessionStorage.replySessionState.inlineSessions).length, priorSessions);
      assert.equal((await message({type: "saveSettings", pairingCode}, setup)).code, "AUTH_REQUIRED");
      codexAuthenticated = true;
      const recovered = await message({type: "inlineHealth"});
      assert.equal(recovered.paired, true);
      assert.equal(recovered.health.authenticated, true);
      assert.equal((await message({type: "getState"}, setup)).state.settings.paired, true);
    });
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});
