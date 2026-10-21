# X Comment Assistant

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p align="center"><a href="https://github.com/captainyufei/x-comment-assistant/releases/latest/download/x-comment-assistant.zip">Download the extension</a> · <a href="docs/USAGE.md">User guide (Chinese)</a> · <a href="docs/LOCAL_AGENT.md">Optional local agents (Chinese)</a></p>

<p align="center"><img src="docs/assets/readme-hero.png" width="100%" alt="X Comment Assistant: one source post becomes four Chinese reply drafts; choose, edit and send yourself"></p>

<p align="center">Turn a post into four reply drafts. Pick one, make it yours, and send it yourself.</p>

<p align="center"><sub>Conceptual workflow illustration, not an actual product screenshot.</sub></p>

A Chrome / Edge extension that adds a reply assistant beside the X reply composer. Use your own model API, a running local model service, or an optional local agent.

**The interface and generated replies are currently in Chinese.** This English README explains installation and capabilities; it does not imply English reply support.

## Get started

**API mode needs only the browser extension. No Node.js, terminal, local bridge, extension ID, or pairing.**

### 1. Download and load

1. [Download `x-comment-assistant.zip`](https://github.com/captainyufei/x-comment-assistant/releases/latest/download/x-comment-assistant.zip) and extract it to a folder you will keep.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge. Enable **Developer mode**.
3. Click **Load unpacked** and select the extracted **`XCommentAssistant` folder**. It must contain `manifest.json` directly.
4. Pin **X Comment Assistant** from the browser's extensions menu.

Use the release package above. GitHub's **Code → Download ZIP** contains development source and has a different folder structure. Keep the extracted folder in place while the extension is installed.

### 2. Connect a model

Open the extension → **模型设置** (Model settings) → **模型 API** (Model API):

1. Choose your provider and enter your own API key.
2. Click outside the key field, or click **刷新列表** (Refresh list), then select a model.
3. If discovery is unavailable, choose **手动填写模型名称…** (Enter model name manually) and enter the model or endpoint ID from your provider's console.
4. Click **保存配置** (Save configuration).

The home screen's “configured; verified when generating” status confirms that settings were saved. Access, balance, and generation availability are checked during the actual request. API usage is billed to your own provider account.

### 3. Generate and review

Refresh X → open **Reply** on the original post → click **生成四条回复** (Generate four replies) in this extension's card → choose **填入** (Insert) or **复制** (Copy) → edit and send using X.

- Opening a reply composer does **not** generate automatically.
- The extension does **not** send comments automatically.
- Existing drafts are preserved unless you confirm replacement or appending.
- **换一组** (Generate another set) makes another model request.

## Reply styles

Eight styles are available: **Casual chat, Playful humor, Reasoned analysis, Sharp but restrained, Agreement and resonance, Another perspective, Practical advice, and Gentle empathy.**

- **Auto match:** selects suitable styles for the post's context; each candidate displays its actual style.
- **Manual selection:** returns four different replies in the selected style.
- Style changes apply to the next generation.

Understanding and writing happen in one model request, without a separate topic-classification round trip. Sarcasm, jokes, emotional intent, and factual claims can still be misunderstood. Review every draft before sending.

## Supported connections

| Connection | Supported options | Extra bridge required? |
| --- | --- | --- |
| Model API | DeepSeek, OpenAI, Qwen, Kimi, MiniMax, Doubao / Volcengine Ark | No; requests go directly from the extension |
| Local model | Ollama or LM Studio with a local OpenAI-compatible API | No; load a model and start its API service first |
| Local agent | Codex or Claude Code | Yes; optional [local bridge setup](docs/LOCAL_AGENT.md) |

DeepSeek, OpenAI, Qwen, Kimi, and the supported local services offer model-list discovery. Cloud discovery generally requires the corresponding API key. MiniMax and Doubao currently require a manually entered model or endpoint ID. A listed model is not a guarantee of generation access, credit, or vision capability.

Default local addresses are `http://127.0.0.1:11434/v1` for Ollama and `http://127.0.0.1:1234/v1` for LM Studio. These must be running loopback services; the extension does not download or load models. A key can be left empty if the local service does not require authentication.

Browsers cannot launch installed CLI agents directly. Only local-agent mode needs the optional bridge and an already configured CLI. Local agents may still use cloud models through their own accounts. Gemini CLI is not currently enabled.

## Media and accuracy

- Uses the post being replied to, quoted content, and available media. It does not collect your full account history or read X passwords or cookies.
- Only explicitly supported vision models receive limited public images. Other models use text and alternative text.
- **Video support is limited to the cover image.** The extension does not process video sequences, audio, or subtitles.
- There is no live web search. Missing essential media or context may produce a gap warning instead of usable drafts.
- Output-format validation does not establish factual accuracy or correct interpretation.

## API-key storage

In browser-direct mode, keys are saved separately for each provider and encrypted with **AES-256-GCM**. Ciphertext is stored in `chrome.storage.local`; the non-extractable encryption key is stored in the extension's IndexedDB.

Keys are not browser-synced, returned to the settings field, or exposed to X content scripts. They are sent to the selected provider to authenticate model requests and model-list discovery. A blank key field keeps that provider's saved key; entering a new value replaces it.

This is browser-local protection, **not an operating-system keychain**. It cannot protect against a compromised browser, extension code, or profile. Changing browser, device, or clearing extension data may require entering your key again. Old bridge credentials are not automatically copied into the browser. See [Security and privacy](SECURITY.md) for the separate optional bridge storage model.

## Update and troubleshoot

To update, download the new user ZIP, replace the files in the **same `XCommentAssistant` folder**, click **Reload** on the extensions page, then refresh X. Avoid removing the extension first if you want to retain settings.

| Problem | What to check |
| --- | --- |
| No model configured | Enter a provider key, select a model, and save |
| Empty model list | Check the key, network, and official endpoint; enter a model manually if needed |
| Authentication, balance, or rate-limit error | Check your provider account; the extension does not top up credit or switch models automatically |
| Old local-service connection warning after upgrading | In Model settings → **高级：连接方式** (Advanced: connection mode), switch to browser direct and enter your key again |
| No assistant card on X | Reload the extension, refresh X, and open Reply from the original post |
| A draft will not insert | Check the replacement prompt, or copy and paste manually |
| Local model connection fails | Start its API service, load a model, and verify the port |

The extension is currently distributed through **unpacked loading**, not a browser store. Chrome and Edge use the same ZIP. Most hands-on validation has been on macOS; **Windows device acceptance is still pending**. Offline tests are not a cross-platform guarantee.

For detailed update, removal, and troubleshooting steps, see the [Chinese user guide](docs/USAGE.md). When reporting an issue, include the version, OS, browser, connection mode, provider/model, and redacted reproduction details. Never post an API key or browser profile.

## Development and contributions

End users do not need to build the extension or install npm packages. For development, use Node.js 20+:

```sh
git clone https://github.com/captainyufei/x-comment-assistant.git
cd x-comment-assistant
npm ci --ignore-scripts
npm test
npm run check:public
npm run build:user
```

Load `extension/` to develop browser-direct features. `npm run build:user` creates the user ZIP in `dist/`. Set up the optional bridge only when working on local-agent functionality.

- `extension/`: Manifest V3 extension, popup, composer integration, and browser API engine.
- `bridge.mjs` and `*-runner.mjs`: optional local bridge and agent adapters.
- `*.test.mjs` and `fixtures/`: offline tests and synthetic pages.
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

CI uses no real model keys and sends no X comments. Public source excludes personal account history, private review data, keys, and private screenshots.

## License

[MIT](LICENSE). Provider APIs, CLI tools, and X retain their own account, billing, and usage terms.
