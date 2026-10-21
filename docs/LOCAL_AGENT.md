# 可选：本地 Agent 与本机桥接

**只有需要调用电脑中的 Codex／Claude Code，或继续使用旧版桥接配置时，才需要这份文档。** 使用云 API 或已经运行的 Ollama／LM Studio 服务，直接安装用户 ZIP 即可，见 [使用教程](USAGE.md)。

浏览器扩展不能直接启动本机命令行程序。可选桥接运行在 `127.0.0.1:8769`，校验明确配置的一个扩展 ID，再复用本机已登录的 Agent。它不要求手抄配对码，也不信任首个来访扩展。

本地安装 Agent 不等于离线推理；它可能调用自己的云端账户。

## 准备

- 已安装并加载「X Comment Assistant」浏览器扩展。
- Node.js 20+，可从 [Node.js 官网](https://nodejs.org/en/download) 安装适合系统的版本。
- 自行安装并登录 Codex 或 Claude Code，先在自己的终端确认 CLI 可用。本项目不替你安装或登录。
- 一份**完整源码**，因为用户 ZIP 只含浏览器需要的文件，不含桥接运行文件。

获取完整源码：在仓库点 **Code → Download ZIP** 并解压，或：

```sh
git clone https://github.com/captainyufei/x-comment-assistant.git
cd x-comment-assistant
```

在同时含有 `package.json`、`bridge.mjs`、`configure-extension.mjs` 和 `extension/` 的目录打开终端。确认：

```sh
node --version
```

运行桥接本身不需要 `npm install`；`npm ci` 用于开发测试。已有用户安装包时，不必再加载第二份源码扩展。

## 取得当前扩展 ID

在 `chrome://extensions` 或 `edge://extensions` 中，开启开发者模式，找到「X Comment Assistant」，复制其 **32 位扩展 ID**。

ID 是公开安装标识，不是 API Key；不要将密钥写入信任配置。Chrome、Edge、加载路径不同，ID 可能不同。当前一个桥接只信任一个明确 ID。

## macOS：先启动前台桥接

在完整源码目录运行，替换占位文字：

```sh
node configure-extension.mjs --extension-id "替换为扩展管理页的32位ID"
npm start
```

第一条命令只在本机生成已被 Git 忽略的 `extension-trust.json`，不写入 API Key。相同 ID 无需重写；主动更换信任的 ID 时才用 `--replace`。

保持终端开启。浏览器打开插件「模型设置」→「本地 Agent」→「检查本机桥接」，选择检测到的 Codex／Claude Code并保存。也可在底部「高级：连接方式」选择「本机桥接（本地 Agent）」。

保存只确认本机配置，CLI 登录及模型可用性在实际生成时确认。Gemini CLI 当前未启用。

### macOS 登录后运行（可选）

先等当前任务结束，在前台终端按 `Ctrl+C` 停止，然后在同一源码目录运行：

```sh
node service-manager.mjs install
```

也可使用源码中的「启动本机 Codex 服务.command」（历史文件名，适用于当前选定来源）。安装器从 `/opt/homebrew/bin/node` 或 `/usr/local/bin/node` 查找 Node；其他安装位置可继续使用前台方式。

安装器会复制所需运行文件和 `extension-trust.json` 到当前用户目录并注册登录服务。浏览器仍加载原来的扩展目录。修改信任文件或更新桥接代码后，应重新执行安装命令；有正在生成的任务时会拒绝更新。

## Windows：前台启动

在完整源码目录，用 PowerShell 运行：

```powershell
.\start-windows.ps1 -ExtensionId 你的实际32位扩展ID
```

每次启动都要传入 ID，脚本不会保存该参数，也不会修改 PowerShell 执行策略或要求管理员权限。保持窗口开启。

若组织策略禁止运行脚本，可在同一 PowerShell 会话中设置：

```powershell
$env:JIEYIJU_EXTENSION_ID = '你的实际32位扩展ID'
node bridge.mjs
```

之后在插件「本地 Agent」页检查本机桥接，选择实际可用的 Agent 并保存。

**Windows 实机验收尚未完成。** 当前没有 Windows 登录自启安装器；Agent 的可执行文件与 npm shim 发现仍需设备验证。Windows 桥接和 DPAPI 的代码适配不等于已证明所有 CLI 安装方式可用。

## 旧版 API 桥接与密钥

旧配置会保留桥接方式，避免升级自动改变数据去向。桥接模式也可以继续调用 API 或本地模型，但普通新用户无需使用它。

在「模型设置」底部「高级：连接方式」切换：

- **浏览器直连**：由扩展直接调用模型，Key 使用浏览器自己的加密存储。
- **本机桥接**：由本机服务调用模型，继续使用该服务的配置与凭据存储。

两侧独立保存，**切换不复制或迁移 Key**。从旧桥接转为浏览器直连时，需要再填一次自己的 Key；切换不会删除另一侧设置。生成过程中不能切换。

桥接密钥在明确保存时使用系统凭据保护：macOS 使用钥匙串中的随机加密密钥及 AES-256-GCM，Windows 使用当前用户 DPAPI。私有配置分别在 `~/Library/Application Support/Jieyiju` 与 `%LOCALAPPDATA%\Jieyiju`，不要打包或提交这些目录。浏览器直连使用的并不是系统钥匙串，见 [安全说明](../SECURITY.md)。

## 更新桥接与切换浏览器

### 更新

先等生成结束；前台服务按 `Ctrl+C` 停止。

- Git 源码：在原目录运行 `git pull --ff-only`，有自己改动时先备份处理，不强制重置覆盖。
- 源码 ZIP：更新原源码目录，保留自己生成的 `extension-trust.json` 和本地改动，不把个人配置上传到仓库。

macOS 登录服务重新执行 `node service-manager.mjs install`；前台重新 `npm start`。Windows 重新运行启动脚本，并再次传入实际扩展 ID。

浏览器扩展也需更新为对应版本，保持原加载路径，重载扩展并刷新 X。只更新磁盘文件不会自动替换浏览器已加载的代码。

### 更换浏览器或扩展 ID

先停止前台桥接或等待后台任务结束。在 macOS 源码目录运行：

```sh
node configure-extension.mjs --extension-id "替换为新浏览器的32位ID" --replace
```

使用登录服务时再执行 `node service-manager.mjs install`；前台重新 `npm start`。Windows 重新启动脚本并传入新 ID。

不要把两个 ID 拼到同一个参数，也不要改成信任所有扩展。浏览器直连不需要这些步骤。

## 停止与卸载桥接

- **前台方式**：在启动桥接的终端按 `Ctrl+C`；Windows 关闭对应启动窗口也会停止服务。
- **macOS 登录服务**：等生成完成后运行：

```sh
launchctl bootout "gui/$(id -u)/com.yufei.jieyiju.bridge"
```

然后在 Finder「前往文件夹」打开 `~/Library/LaunchAgents/`，将 `com.yufei.jieyiju.bridge.plist` 移到废纸篓，避免下次登录自动运行。没有安装登录服务时不需要此步骤；当前没有 `service-manager.mjs uninstall` 命令。

停止服务不删除桥接自己的配置和加密 Key。若要清理，先确认没有其他安装继续使用，再按 [安全说明](../SECURITY.md) 中的目录单独处理。移除浏览器扩展也不会替你停止桥接或清理其配置。

转用浏览器直连的用户，确认直连生成正常后可停止旧桥接；不必为继续使用 API 而保留桥接服务。

## 排查桥接问题

| 现象 | 先检查 |
| --- | --- |
| 本机服务未连接 | 启动窗口是否开启、端口 8769 是否被占用、实际扩展 ID 是否与信任配置一致 |
| Mac 修改 ID 后仍未连接 | 修改后是否重新执行安装，是否为当前登录用户的服务 |
| 未检测到 Agent | 先在终端确认安装、登录及 CLI 可用；Windows 发现流程尚待实机验证 |
| 协议版本不兼容 | 同时更新桥接与浏览器扩展，重新加载扩展并刷新 X |
| Key 保存失败 | 检查系统凭据保护能力；不要通过明文保存绕过 |
| 想改用 API 又不想启服务 | 切到浏览器直连，另填一次 API Key，按普通用户教程使用 |
