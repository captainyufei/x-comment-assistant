# 参与贡献

欢迎修复问题、完善模型适配、改进回复质量和补充跨平台验收。

## 本地开发

普通用户从 [发行安装包](https://github.com/captainyufei/x-comment-assistant/releases/latest/download/x-comment-assistant.zip) 安装，无需 Node.js。下面的命令仅用于开发源码，需要 Node.js 20+：

```sh
git clone https://github.com/captainyufei/x-comment-assistant.git
cd x-comment-assistant
npm ci --ignore-scripts
npm test
npm run check:public
npm run build:user
```

调试浏览器直连时，在 Chrome／Edge 加载源码的 `extension/`，无需启动 `bridge.mjs`。`extension/shared/` 包含发布到浏览器的共享协议和提示词。修改根目录共享规则时，应同步浏览器副本并运行一致性检查，避免两份规则不同。`npm run build:user` 负责将扩展运行资源打包到 `dist/x-comment-assistant.zip`，并提供可直接加载的 `dist/XCommentAssistant/`；不要把打包当作自动同步规则。

只有开发本地 Agent 或旧桥接功能时，才按 [docs/LOCAL_AGENT.md](docs/LOCAL_AGENT.md) 配置信任 ID 并启动本机服务。测试依赖模拟传输与合成输入；日常测试不应要求真实 API Key 或真实账户。

## 提交前

1. 说明触发条件、修改后的行为和验证范围。
2. 为解析、通信、凭据或编辑器回归补充有意义的测试，先运行相关测试，再运行完整测试与公开发布检查。
3. 界面修改附截图；模型适配注明实际协议、型号和能力，不根据品牌推断视觉或思考参数。
4. 将单元测试、发布包加载、真实模型调用、浏览器填入和真实发送分别记录。本项目默认不执行真实发送验收。
5. 检查普通用户 ZIP：`XCommentAssistant/manifest.json` 可直接加载，包含所有运行资源，不要求用户安装 Node 或执行构建。

请勿提交个人配置、真实 Key、会话凭证、浏览器资料、用户草稿、反馈数据、私有截图、日志或模型试评原始记录。示例使用合成文字，并标明来源性质。

## 保持这些约定

- 只有用户明确点击才开始生成，发送留给用户。
- 新安装默认浏览器直连 API／本地模型；本机桥接是本地 Agent 的可选路径，不应重新成为普通用户前置要求。
- 浏览器与桥接分别保存密钥，切换连接方式不自动复制 Key；读取设置只返回公开元数据，不能将 Key 回填到页面或内容脚本。
- 浏览器 Key 使用 AES-256-GCM 与扩展 IndexedDB 的不可导出密钥，不同步、不降级明文，也不宣传成系统级保险箱。
- 自动模式每条选择适合原帖的风格；手动模式四条保持所选风格，不用固定卡片标题伪装匹配。
- `replyStyle` 表示实际风格；历史 `style` 仅是兼容排序槽位。风格名称与规则来自共享目录。
- 变更回复协议时同步浏览器直连、桥接、后台、预览及测试，避免旧后台静默丢字段。
- 缺少关键媒体时说明缺口，不声称已看过未读取的画面或视频。
- 保留取消、超时、响应大小限制、来源校验、最小信任范围、服务商地址校验及密钥隔离。
- 新增平台或模型写清实际验收范围；没有 Windows 等设备证据时标注待验证。

## 报告问题

请提供版本、操作系统、浏览器、连接方式（浏览器直连／桥接）、模型来源与型号、复现步骤、预期和实际结果。错误码和脱敏截图通常足够；不要上传 Key、完整私有配置或包含个人信息的原始请求。

涉及凭据泄漏或访问校验绕过的问题，按 [SECURITY.md](SECURITY.md) 私下报告，避免先公开利用细节。

贡献默认按 MIT License 发布；引入第三方素材或代码前，确认许可证兼容并保留归属。
