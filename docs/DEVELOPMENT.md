# 开发说明

## 环境

- Windows 10/11 x64
- Node.js 18+（建议 20 LTS）
- 首次 `npm install` 会拉 Electron，网络不好时建议先配置镜像

## 常用命令

```bash
npm start                 # 直接跑（开发模式）
npm run dist:dir          # 只产出解包目录 dist/win-unpacked，便于快速替换调试
npm run dist:win          # 产出 dist/HubPlay-<version>-win.zip
```

## 改动界面后如何验证

界面代码在 `renderer/`，走本地服务加载，改完直接刷新窗口即可（不必重新打包）。

命令行常用开关（见 `src/main.js`）：

```
HubPlay.exe --remote-debugging-port=9222   # 挂 DevTools
HubPlay.exe --disable-gpu                  # 排查渲染问题
```

## 自测脚本

| 脚本 | 用途 | 是否需要网络 |
| --- | --- | --- |
| `tools/frame_progress_check.js` | 出画判据与看门狗单测 | 否 |
| `tools/smoke.js` | 本地服务冒烟（导入、接口连通） | 是 |
| `tools/codec_route_check.js` | 服务端链路：判定 / 编码 / ffmpeg 产物 | 是 |
| `tools/asar_tool.js verify <asar> <dir>` | 校验打包产物完整性 | 否 |

## 调试技巧

- 界面按 `L`：内建诊断日志，可一键复制。排查「为什么这条线路不行」时先看它。
- 界面按 `I`：播放统计（缓冲、丢帧、硬解状态、转码会话）。
- `GET /api/remux/status`：确认 ffmpeg 是否真的起来了（`started`）、写了几个分片、stderr 尾部。
- `GET /api/prefetch`：确认分片是否已经被提前取到内存。

## 提交前

1. `node tools/frame_progress_check.js` 通过。
2. 若改动涉及打包：确认 `package.json` 的 `build.files` 覆盖了新增文件。
3. 更新 `CHANGELOG.md`。
