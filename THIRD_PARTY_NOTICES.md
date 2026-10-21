# 第三方依赖

浏览器扩展与可选本机桥接运行时使用浏览器／Node.js 内置模块，无第三方运行依赖。测试直接使用 jsdom（MIT）。下表从锁文件生成，安装包附带的原始 LICENSE/NOTICE 文件继续适用，不由本项目 MIT 替代。

| 测试依赖 | 锁定版本 | 声明许可证 |
| --- | --- | --- |
| @asamuzakjp/css-color | 3.2.0 | MIT |
| @csstools/color-helpers | 5.1.0 | MIT-0 |
| @csstools/css-calc | 2.1.4 | MIT |
| @csstools/css-color-parser | 3.1.0 | MIT |
| @csstools/css-parser-algorithms | 3.0.5 | MIT |
| @csstools/css-tokenizer | 3.0.4 | MIT |
| agent-base | 7.1.4 | MIT |
| cssstyle | 4.6.0 | MIT |
| data-urls | 5.0.0 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js | 10.6.0 | MIT |
| entities | 6.0.1 | BSD-2-Clause |
| html-encoding-sniffer | 4.0.0 | MIT |
| http-proxy-agent | 7.0.2 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| iconv-lite | 0.6.3 | MIT |
| is-potential-custom-element-name | 1.0.1 | MIT |
| jsdom | 26.1.0 | MIT |
| lru-cache | 10.4.3 | ISC |
| ms | 2.1.3 | MIT |
| nwsapi | 2.2.28 | MIT |
| parse5 | 7.3.0 | MIT |
| punycode | 2.3.1 | MIT |
| rrweb-cssom | 0.8.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| saxes | 6.0.0 | ISC |
| symbol-tree | 3.2.4 | MIT |
| tldts | 6.1.86 | MIT |
| tldts-core | 6.1.86 | MIT |
| tough-cookie | 5.1.2 | BSD-3-Clause |
| tr46 | 5.1.1 | MIT |
| w3c-xmlserializer | 5.0.0 | MIT |
| webidl-conversions | 7.0.0 | BSD-2-Clause |
| whatwg-encoding | 3.1.1 | MIT |
| whatwg-mimetype | 4.0.0 | MIT |
| whatwg-url | 14.2.0 | MIT |
| ws | 8.22.0 | MIT |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xmlchars | 2.2.0 | MIT |

Draft.js 官方源码链接仅作为富文本行为的参考，见编辑器测试注释。合成页面没有打包 X 网页内容。新图标由内置 imagegen 生成，见 docs/BRANDING.md。

## README 演示动画

`docs/assets/readme-demo.gif`、`readme-demo.mp4` 与 `docs/demo/` 是独立的演示素材，不会打包进浏览器安装包。

- huashu-motion 0.1.1 的 `om.js`：MIT；保留 [HUASHU-LICENSE](docs/demo/HUASHU-LICENSE)。
- GSAP 3.14.2：单独的 Standard License；保留 [许可证说明](docs/demo/vendor/GSAP-LICENSE.txt) 和 [完整条款](docs/demo/vendor/GSAP-LICENSE.html)。
- Inter、Noto Sans SC：SIL Open Font License 1.1；保留 [字体版权](docs/demo/assets/fonts/LICENSES.md) 和 [OFL](docs/demo/assets/fonts/OFL.txt)。
- 项目图标、纯界面组件及编写的演示内容使用本项目 MIT 许可；未使用 huashu 的角色素材。

The extension/bridge remain separate from the optional demo. Animation libraries and fonts keep their own licenses; see [demo notices](docs/demo/THIRD_PARTY.md) and [editing instructions](docs/demo/README.md).
