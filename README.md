# HubPlay

面向 [iptv-hub](https://github.com/) 的 **Windows 桌面 IPTV 播放器**（Electron）。

把播放源地址粘进顶栏 → 导入 → 左侧出频道 → 点击即播。

它的重点不是「能播 H.264 的台」，而是**把浏览器内核本来解不了的源也播出来**：
Chromium（也就是 Electron）没有 MPEG-2 / MP2 / HEVC / AC-3 这些解码器，
而很多 IPTV 源恰恰是这些编码 —— VLC、PotPlayer 自带解码器所以能播，浏览器内核直接播不了。
HubPlay 随包带一份 ffmpeg，遇到这类源就自动转成 H.264 + AAC 的 fMP4 HLS 交给播放器，
并在转码链路上做了抖动治理，尽量做到「不卡、不掉线」。

```
┌────────────────────────────────────────────────────────────────────┐
│ HubPlay  [粘贴源地址..................] [打开] [播放] [导入] [收藏] ● 2849 频道 │
├──────────────┬─────────────────────────────────────────────────────┤
│ 频道列表      │                                                     │
│ [全部][收藏][央视][地方台][其他]                                     │
│ [搜索........]│                    📺                                │
│  📺 CCTV1     │          粘贴源地址后点「导入」                        │
│  📺 CCTV2     │          也可以从左侧频道列表里选一个频道               │
└──────────────┴─────────────────────────────────────────────────────┘
```

## 功能

- **三种源地址自动识别**：iptv-hub 地址、`.m3u` 订阅、`.txt` 列表。
- **编码预判 + ffmpeg 兜底**：播放前先问清源编码，Chromium 解不了的直接交内置 ffmpeg 转码，
  不浪费二十秒让播放器撞墙。
- **多线路自动故障转移**：同一频道有多条镜像时按实测速度排序，起播前预检可用性，
  死线直接跳过并说明原因。
- **抖动治理**：目标延迟 / 前向缓冲按源窗口自动计算；上游停顿后用倍速追赶，缓冲不再触底。
- **硬件解码**：独显 → 核显 → 软件自动选择，可在界面切换。
- **本地视频播放**：支持 mp4 / mkv / avi / wmv / flv / ts / rmvb 等，不支持的自动转码。
- **诊断面板**：按 `L` 打开内建诊断日志（帧进度、出画判定、线路失败一览、ffmpeg 会话体检），
  出问题时可一键复制出来定位。

## 快速开始（直接下载可运行版）

1. 从 [Releases](https://github.com/new2025lu/hubplay/releases) 下载 `HubPlay-1.6.6-win-x64.zip`。
2. 解压到任意目录（**不要放在需要管理员权限的位置**，例如 `C:\Program Files` 根下）。
3. 双击 `HubPlay.exe`。
4. 顶栏粘贴源地址，点「导入」。

> 首次启动 Windows 可能弹 SmartScreen（程序未做代码签名）：点「更多信息」→「仍要运行」。

## 从源码运行

```bash
git clone https://github.com/new2025lu/hubplay.git
cd hubplay
npm install
npm start
```

环境要求：**Node.js 18+**、**Windows 10/11 x64**。

### 打包 Windows 版

内置 ffmpeg 需要先放到 `vendor-win/`（脚本会自动下载官方 GPL shared 构建）：

```bash
bash tools/fetch-ffmpeg.sh      # 下载 ffmpeg 到 vendor-win/
npm run dist:win                # 产出 dist/HubPlay-<version>-win.zip
```

`package.json` 的 `build.extraResources` 会把 `vendor-win/ffmpeg-master-latest-win64-gpl-shared/bin`
整份拷进 `resources/ffmpeg/`（不含 `ffplay.exe`）。

## 源地址能填什么

| 你贴的地址 | 识别为 | 说明 |
| --- | --- | --- |
| `http://<host>:<port>` | iptv-hub | 频道表 + 台标 + 测速 + 收藏同步 |
| `http://<host>:<port>/iptv` | iptv-hub 订阅地址 | 同上，并尊重地址里的 `mode` / `region` 参数 |
| 任意 `http://.../xxx.m3u` | 普通 M3U | 频道名 / 分组 / 多线路 / 防盗链头 |
| 任意 `http://.../xxx.txt` | TXT 列表 | 同上 |

列表里的 `#EXTVLCOPT:http-user-agent=` 与 `#EXTVLCOPT:http-referrer=` 会被解析并用于该条线路的请求。

## 为什么需要内置 ffmpeg

| 编码 | Chromium 能否直解 | HubPlay 的处理 |
| --- | --- | --- |
| H.264 / AAC | ✅ | 直接播，零 CPU 开销 |
| H.265 / HEVC 8bit | 视平台 | 能直解就直解，否则转码 |
| **MPEG-2 / MP2** | ❌ | **交给内置 ffmpeg 转码** |
| AC-3 / E-AC-3 | ❌ | 音频转 AAC（视频可原样） |
| 裸 MPEG-TS | 视内容 | 用 mpegts.js 重封装后交给 MSE |

转码会话的分片、播放列表都写在本机临时目录，播放器通过本地服务读取，
所以界面、接口、流三者同源，不存在跨域问题。

## 常见问题

**点了频道一直转圈 / 报「所有线路都放不出来」**

先在错误面板看逐条原因，再点「重试这个频道」。多数情况是源站那几条镜像暂时不可用。
按 `L` 导出诊断日志可以看到每条线路的判定结果。

**画面一顿一顿，缓冲只有一两秒**

通常是源端交付本来就偏慢（分片发布节奏 ≈ 1 倍速）。可以在底部把缓冲档位调为「延迟优先」，
或换该频道的其它线路。

**硬解没生效**

按 `I` 打开统计面板看硬解状态；底部「解码」可切换 自动 / 独显 / 核显 / 软解。
切换会重启应用（命令行开关只在启动时生效）。

## 项目结构

```
src/           主进程与本地服务
  main.js        窗口、菜单、命令行开关、硬解策略
  server.js      本地 HTTP 服务：界面托管 + /p 流代理 + /api/* 接口 + 预取缓存
  local.js       本地视频与 ffmpeg 转码编排
  stream.js      上游请求、播放列表改写、容器嗅探
  playlist.js    M3U / TXT 解析
  prefetch.js    分片预取缓存
renderer/      渲染进程（界面）
  app.js         界面逻辑：引擎选择、线路切换、看门狗、诊断
  livewin.js     直播窗口测量
  vendor/        hls.js / flv.js / mpegts.js
tools/         校验与诊断脚本
```

## 校验与自测

```bash
node tools/frame_progress_check.js          # 出画判据单测（不需要网络）
node tools/asar_tool.js verify <asar> <dir> # 校验打包产物内每个文件的完整性
node tools/smoke.js                         # 本地服务冒烟测试
```

## 已知限制

- **转码吃 CPU**：MPEG-2 SD 余量充足；4K HEVC 实时转码在普通机器上可能跟不上。
- **转码档有延迟**：为对抗抖动，转码线路会主动站在离直播边缘若干秒处（默认目标 8 秒）；
  能直解的线路不受影响。
- **未做代码签名**：首次运行会有 SmartScreen 提示。
- **裸 TS（`/rtp/`）** 能播，但画质与稳定性取决于源本身。
- 仅面向 Windows x64；其它平台未测试。

## 第三方组件

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| [hls.js](https://github.com/video-dev/hls.js) | 1.5.20 | Apache-2.0 |
| [flv.js](https://github.com/bilibili/flv.js) | 1.6.2 | Apache-2.0 |
| [mpegts.js](https://github.com/xqq/mpegts.js) | 1.7.3 | Apache-2.0 |
| [Electron](https://github.com/electron/electron) | 44.x | MIT |
| [FFmpeg](https://ffmpeg.org/) | 随发行包提供 | GPL（见下） |

> 发行版随包提供的 ffmpeg 为官方 **GPL** 构建。以二进制形式再分发时请一并遵守 GPL 的相应义务
> （提供许可证文本与对应源码获取方式）。若只需 LGPL 版本，可自行替换为 LGPL 构建。

## 免责声明

本项目只提供**播放器**，不提供、不托管、不分发任何频道源或内容。
软件中的频道均来自用户自行填写的第三方源地址，请确保你对所访问的内容拥有合法权利，
并遵守当地法律法规与源服务方的使用条款。

## 许可证

[MIT](LICENSE)
