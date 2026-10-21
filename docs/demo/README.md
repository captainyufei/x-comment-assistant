# Editable README demo / 可编辑演示

This is the source of the [README GIF](../assets/readme-demo.gif) and [60 fps MP4](../assets/readme-demo.mp4). It is a presentation fixture, not an extension feature or real-account recording.

这是 README 动画的源码：点击生成 → 四条候选 → 选择并修改 → 人工发送。使用真实插件的纯界面组件和本地示例数据；不会访问 X、调用模型、读取设置或发送评论。演示节奏已加速，不代表真实模型速度。

## Watch / 观看

- [60 fps MP4](../assets/readme-demo.mp4): 20 s, 1600×900, 1200 rendered frames, no audio, about 2.9 MiB. Prefer this for judging motion.
- [README GIF](../assets/readme-demo.gif): 20 s, 1200×675, 25 fps, infinite loop, about 8.9 MiB.
- [Poster](../assets/readme-demo-poster.png) · [Storyboard](treatment.md)

The GIF uses fewer frames and colors for browser/README compatibility. The actual interface and reply text in both versions are Chinese; an English README does not imply an English interface.

## Edit / 编辑

**End users do not need these tools to install or use the browser extension.** Only editing or rendering this optional demo requires Node.js 22+, an installed Chrome/Chromium/Edge, and FFmpeg.

普通插件用户无需安装以下工具；仅制作动画时需要 Node.js 22+、Chrome/Chromium/Edge 和 FFmpeg。

Run these commands from the repository root / 在仓库根目录执行：

```sh
npx --yes huashu-motion@0.1.1 studio docs/demo --no-open
```

Open the local URL printed by the command. Play/pause, seek on the timeline, or press **C** and click the frame to leave a local note. Intro/outro text is editable in the parameter panel. Local notes, render history and output files are ignored by Git.

打开命令输出的本机地址，可播放、暂停或拖动时间轴；按 **C** 后点击画面可写本地修改意见。右侧参数可修改开场/结束文案。生成结果、历史版本和意见不会提交到仓库。

- `index.html`: composition, deterministic timeline, authored fixtures and no-op handlers.
- `assets/plugin/`: a frozen copy of the real composer View and style catalog, for reproducible renders.
- `assets/fonts/`, `assets/logo.png`, `vendor/`: local fonts, project logo and animation helpers. The composition does not require remote assets.

## Validate and render / 检查并导出

```sh
npx --yes huashu-motion@0.1.1 check docs/demo
npx --yes huashu-motion@0.1.1 render docs/demo --format mp4 --fps 60 --blur 2 --workers 2 --silent
npx --yes huashu-motion@0.1.1 qa docs/demo --loop
```

The renderer prints a versioned MP4 path under `docs/demo/out/`; it does not automatically replace the published media in `docs/assets/`. Review the rendered file before copying it there. This film declares no soundtrack or audio. Layout/contrast and motion checks are diagnostics, not complete accessibility or visual-quality guarantees.

命令会输出 `docs/demo/out/` 下带版本号的 MP4。审阅后再更新 `docs/assets/` 中的公开素材。动画未声明音乐、音效或音轨；检查结果不等于完整无障碍认证或审美验收。

To derive the README GIF, replace `INPUT.mp4` with that rendered path / 将 `INPUT.mp4` 替换为刚导出的文件：

```sh
ffmpeg -i INPUT.mp4 -filter_complex "[0:v]fps=25,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 -an OUTPUT.gif
```

## Provenance and licenses / 来源与许可

Authored with [huashu-motion 0.1.1](https://github.com/alchaincyf/huashu-motion/tree/5f2608c2e12abcf518f74dde86093b19f7f88603), source commit `5f2608c2e12abcf518f74dde86093b19f7f88603`. See [THIRD_PARTY.md](THIRD_PARTY.md): huashu runtime is MIT, GSAP uses its separate Standard License, and Inter/Noto Sans SC fonts use SIL OFL. Their notices are included. No third-party character artwork is used. HyperFrames and Remotion are not bundled.
