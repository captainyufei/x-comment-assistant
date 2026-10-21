# 详细使用教程

首次安装按 [README](../README.md#开始使用) 的顺序完成。最容易开始的方式是云 API：先加载扩展、配置扩展 ID，启动本机桥接，再在小窗填 Key。

## 下载 ZIP 后在哪里运行命令

1. 在仓库点 **Code → Download ZIP**，下载并解压，不要直接在压缩包里运行。
2. 找到同时含有 `package.json`、`bridge.mjs`、`configure-extension.mjs` 与 `extension/` 的目录。GitHub ZIP 的外层目录通常叫 `x-comment-assistant-main`。
3. macOS 在终端输入 `cd `（后面有空格），把这个文件夹拖入终端，再按回车。Windows 在该目录空白处右键，选择「在终端中打开」，使用 PowerShell。
4. 运行 `node --version`。提示找不到命令时，先从 [Node.js 官网](https://nodejs.org/en/download) 安装 LTS，安装后重新打开终端。

项目服务只需要 Node；不必为了运行而执行 `npm install`。

## 两部分都要运行

| 部分 | 做什么 | 如何就绪 |
| --- | --- | --- |
| 浏览器扩展 | 读取当前回复对应的原帖、显示候选、管理模型设置 | Chrome/Edge 扩展页加载 `extension/` |
| 本机桥接 | 调用模型、保存密钥和管理任务 | macOS 用 `npm start` 或安装登录服务；Windows 用启动脚本 |

扩展单独加载后显示“本机服务未连接”通常是桥接还未启动。填写的扩展 ID 必须与当前浏览器扩展卡片一致，不是 API Key。

## 选择模型来源

### 云 API

1. 打开工具栏「X 评论助手」→「模型设置」→「模型 API」。
2. 选择你有 API 额度的服务商，填写它自己的 API Key。不要将 Key 贴到 GitHub Issue。
3. 填写后点击输入框外，或点「刷新列表」。等待列表返回，明确选一个支持聊天生成的型号。
4. MiniMax／豆包目前需在下拉菜单选「手动填写模型名称…」，填写服务商控制台里的模型名或接入点 ID。
5. 点「保存配置」。留空 Key 只沿用同一服务商已经保存的 Key，不能用来表示“删除 Key”。
6. 第一次点生成时，才会实际验证生成权限、余额和模型兼容性。列表读取成功不等于一定能生成。

云服务使用你自己的账户和余额。ChatGPT 订阅不支付 DeepSeek 等其他公司的 API 费用。

### 本地 Agent

先自行安装 Codex 或 Claude Code，并在自己的终端完成登录、确认可用，再在「本地 Agent」选中并保存。Gemini CLI 当前未启用。本地 Agent 可能调用它自己的云模型，不代表离线推理。

### 本地模型

先启动 Ollama 或 LM Studio，并加载模型，再配置：

| 服务 | 默认本机服务地址 |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |

端口被改过时填写实际值；地址必须是本机回环 HTTP `/v1` 服务。刷新模型列表，选中模型后保存。插件不负责下载或加载模型，不能把本机模型当成默认支持图片的视觉模型。

## 每次如何回复

1. 在 X 上找到原帖，点击它的「回复」，确认回复对象正确。
2. 在本插件卡片点击「生成四条回复」。打开回复框或选择风格不会自动调用模型。
3. 阅读四条候选。自动匹配按语境选风格；手动选择则四条同风格，设置影响下一次生成。
4. 点某条「填入」，或点「复制」后粘贴。已有草稿时按提示决定替换或追加。
5. 修改内容并检查事实，最后自己点击 X 的「回复」。本插件不自动发送。

普通发帖窗口没有原帖对象，不显示本插件的回复候选。若有多个 AI 扩展同时安装，请认准「X 评论助手」卡片中的入口。

视频目前只能读封面。关键图片、对白或前文缺失时，不应期待模型准确猜出整个梗；请只发送你确认合适的候选。

## 更新与卸载

### 更新：保留路径和本机身份

先等生成结束。若前台运行桥接，在原终端按 `Ctrl+C` 停止。

**Git 下载：** 进入原项目目录，运行 `git pull --ff-only`。有本地改动时先备份处理，不用强制重置覆盖。

**ZIP 下载：** 先备份原目录中的 `extension-trust.json` 和自己改动过的文件。下载新版并解压，把新版项目文件更新到原目录；保留原 `extension-trust.json`，不要换掉扩展原加载路径。不要把含 Key 的个人配置上传回仓库。

之后按启动方式继续：

- macOS 登录服务：在原项目目录再次运行 `node service-manager.mjs install`。有正在生成的任务时会拒绝更新，等完成后再试。
- macOS 前台：再次 `npm start`。
- Windows：再次运行 `.\start-windows.ps1 -ExtensionId 你的实际32位扩展ID`，每次都需要该参数。

最后在浏览器扩展页对本插件点「重新加载」，刷新 X。只更新磁盘文件不能替换已加载的浏览器代码。

### 切换浏览器或扩展 ID

一个本机桥接当前只信任一个明确 ID。Chrome 和 Edge 的 ID 通常不同。切换前先停前台服务，或等待后台任务结束。

macOS 在项目目录运行：

```sh
node configure-extension.mjs --extension-id "替换为新浏览器的32位ID" --replace
```

若使用登录服务，再执行 `node service-manager.mjs install`；前台用户重新 `npm start`。Windows 重新启动脚本时传入新 ID。不要把两个 ID 拼到同一个参数中，也不要改成信任所有扩展。

### 卸载：先停服务，再移除扩展

- 前台方式：在桥接终端按 `Ctrl+C`。Windows 关闭启动窗口也会停止服务。
- macOS 登录服务：先等待生成结束，在终端运行：

```sh
launchctl bootout "gui/$(id -u)/com.yufei.jieyiju.bridge"
```

然后在 Finder 用「前往文件夹」打开 `~/Library/LaunchAgents/`，把 `com.yufei.jieyiju.bridge.plist` 移到废纸篓，避免下次登录自动运行。没有安装登录服务时无需这一步。当前没有 `service-manager.mjs uninstall` 命令。

最后在 Chrome/Edge 的扩展管理页移除「X 评论助手」。私有模型配置、加密 Key 和反馈默认仍保留在本机用户目录，移除扩展不会替你删除它们；需要彻底清理时，先确认备份与其他安装是否还在使用。配置位置见 [SECURITY.md](../SECURITY.md)。

## 验收范围

当前主要实测环境是 macOS。Windows 有前台启动及 DPAPI 实现，但尚未完成 Windows 实机验收；没有 Windows 登录自启安装器。Linux 尚未适配完整的系统凭据保存流程。CI 里的离线测试不能替代实机、模型调用或真实 X 页面验收。
