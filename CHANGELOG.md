# 更新日志

## 1.6.27

**修复：慢源（<1× 实时）的 MP2 频道「起播要等半天、播一会儿就见底」**

现场：用户点开 `需转码` 的线路（H.264 1920×1080 + MP2），界面长时间停在
「正在起播（已就绪 8 / 20 秒，最多等 12 秒）」。实测那条源的会话产出是
**34 个分片 / 90 秒 ≈ 0.76× 实时** —— 换句话说 **源比播放还慢**。

旧策略（为「源 1.35× 实时」调的）对这种源是反的：

- 起播门槛 10 片（20 秒内容）→ 用户先干等 20~30 秒；
- 开播时站在离边缘 4 片（8 秒）处 → 手里只有 8 秒余量；
- 落后超过 20 片（40 秒）就把播放头拽回边缘 + 1.05 倍速追 → 慢源必然被反复拽回、反复见底。

新策略（PotPlayer / mpv 的做法）：

- 起播门槛降到 **3 片（6 秒）/ 最多等 8 秒**；
- 起播位置 = **手里已有的最早那一片**（`liveSyncDurationCount` 取当前列表长度），
  于是开播时前向缓冲就是已发布的整个窗口；
- `liveMaxLatencyDurationCount` 放到很大、`maxLiveSyncPlaybackRate = 1`：
  **落后是常态，不是错误**，绝不往前拽；
- back buffer 30 → 60 秒，落后时已播的也不丢。

直出（浏览器原生）线路完全不受影响 —— 这些参数只用在 ffmpeg 产出的 HLS 上。
## 1.6.24

**找到并修掉了「avc1.640128」的真正根因 —— 不用再转码了**

现象：`-c:v copy` 出来的分片，浏览器报

```
Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided
('video/mp4;codecs=mp4a.40.2,avc1.640128') is unsupported
```

根因（实测三次定位）：这条源的 H.264 **SPS 里 `reserved_zero_2bits = 1`** ——
H.264 规定这两位必须为 0，是编码器写错了。ffmpeg 用 `-c:v copy` 时把 SPS 原样
抄进 fMP4 的 avcC，于是编码串变成 `avc1.640**1**28`；而 Chromium 的 MSE 解析器
**会校验这两位**，直接拒收。同一个串换成 `avc1.640028` 就是 true。
（ffmpeg 自己的 `h264_metadata` 位流过滤器也因为同一个非法值报
 `reserved_zero_2bits out of range: 1, but must be in [0,0]`，用不了。）

修复：服务端吐 `init.mp4` 时把这两位的**保留位清零**（`sanitizeInitSegment`）。
这不改变任何视频数据，只是把编码器的错误修正回规范值。

**实测对照**（同一会话、同一份分片，只改这一个字节）：

| | 结果 |
| --- | --- |
| 改前 | `mime=…avc1.640128` → `bufferAddCodecError` → 建不了 SourceBuffer |
| 改后 | `errs=[]`，`t=26.08`、`w=1280`、`rs=4` —— **`-c:v copy` 直接播，零转码开销** |

顺带的效果：这类源不再需要「先换壳→被拒→再重编」那一跳，起播更快、CPU 也不用花了。
转码档仍然保留，给真正没有解码器的编码（MPEG-2 / MPEG-4 part 2 / WMV / VC-1 等）用。
## 1.6.23

**优化一：HEVC 能硬解就直通，不再一律转码**

Chromium 在 Windows 上要拿到平台 HEVC 硬解才支持 H.265，所以服务端白名单里默认没有它 ——
结果是每一路 HEVC 频道都在白转码。实测这台机器 `hev1`/`hvc1` 的 MSE 支持都是 true，
而前端启动时本来就用 `mediaCapabilities` 探过一次（`state.decodeCap.hevc_1080`）。

改法：前端通过 `caps: { hevc: true }` 把探测结果带给服务端（`/api/remux`、`/api/local/open`），
`decide()` 在 `caps.hevc` 为真时把 hevc 当可直解处理；探不到支持就维持原样（照旧转码）。

**优化二：转码档把解码交给 GPU**

这个包里的 ffmpeg 带 `mpeg2_qsv` / `hevc_amf` / `h264_amf` / `h264_qsv` 等硬件解码器，
而转码档以前是软件解码 + 软件编码，CPU 两头都吃。现在只在**转码档**给输入加
`-hwaccel auto`（换壳档是 `-c:v copy` 用不上；而且它是输入级选项，必须写在 `-i` 之前，
绝不会混进喂给 ffprobe 的那份参数 —— 那是 1.6.11 踩过的坑）。

**自动回退**：硬件解码在本机不成立时 ffmpeg 会在启动阶段就退出。这种情况只重试一次：
清掉会话目录里的半成品、去掉 `-hwaccel` 再跑一遍，不会因此判死一条线路。
## 1.6.19

**新增：用外部播放器打开（播不了就切给别的播放器）**

背景：Chromium 的 MSE 有一批它就是不收的流 ——

- MP2 / MPEG-2 音视频没有解码器（VLC / PotPlayer / mpv 自带 libavcodec，所以它们能播）；
- 源的 H.264 SPS 带了它不认的 constraint 位（实测 `avc1.640128` → `isTypeSupported=false`，
  同一档次换成 `avc1.640028` 就是 true，差别只在第二个字节）；
- 分片地址没有扩展名时，ffmpeg 的默认白名单还会挡一次（1.6.10 已放宽）。

内置 ffmpeg 兜底（可以理解成「把 libavcodec 借过来，只是跑在进程外」）能解决绝大多数，
但代价是起播要重编、吃 CPU。所以再加一条最省事的路：**把地址交给本机已有的播放器**。

用法：错误面板上多一个「用外部播放器打开」按钮。播放器路径按这个顺序找：

1. 环境变量 `HUBPLAY_EXTERNAL_PLAYER`；
2. `C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe` 等常见安装位置
   （PotPlayer / VLC / mpv，32/64 位都试一遍）。

**这不是换内核**：它是在 HubPlay 之外起一个进程播同一路流；真正的「内置第二内核」
（嵌入 libmpv / libvlc）是另一个量级的工程，需要单独评估。
## 1.6.18

**修复：不再依赖「浏览器那次拒绝」能被及时发现**

CCTV13 线路一的现场（2026-10-10 22:18）：接管会话建好了、播放列表在涨，
但 `loadedmetadata` 始终 `0×0`，界面一直转圈 —— 而**那次「浏览器拒收」的
bufferAddCodecError 始终没到**（旧实例排队事件被丢弃，或 hls.js 只是安静地
建不出 SourceBuffer），于是 1.6.13 的「被拒后再重编」永远没机会触发。

三处改动（`renderer/app.js`）：

1. **按源地址记结论**：新增模块级 `TRANSCODE_URLS`。只要某条源被浏览器拒过一次，
   以后**第一次就直接用重编档**，不再靠那次失败的及时性；
2. **兜底计时器**：会话体检里，换壳档 15 秒还没出画（`videoWidth === 0`）就自动改成
   视频重编，并顺手记进 `TRANSCODE_URLS`（只做一次）；
3. **防抖改成限时**：1.6.16/1.6.17 的接管锁改回「接管后 15 秒内忽略重复报错」，
   过期允许再试 —— 一刀切的永久忽略会让一次没成的接管变成永远转圈（这正是
   22:19 CCTV1 卡住的原因，实测状态：`line=1 / ff=false / 重编重试=0 / spinner 一直转`）。
## 1.6.17

**修复：旧 hls.js 实例的「迟到事件」污染新会话**

同一根因的两个表现，都是被销毁的实例把排队中的 ERROR 事件派发出来：

1. **反复拆会话**（1.6.16 已缓解，这里根治）：线路一刚建好的 ffmpeg 会话被连着拆两次，
   每次重新等 20 秒起播。
2. **假报错面板**（CCTV13 截图）：画面上弹出「ffmpeg 转码播放失败
   bufferIncompatibleCodecsError」，而底下 CCTV13 明明在正常播放 —— 那个面板
   再也没人收，因为原来的收起条件要求 spinner 还挂着。

修复（`renderer/app.js`）：

- 新增 `state.hlsSeq`：新建实例时自增并记下自己的序号，`destroyPlayer()` 也自增；
  两个 hls.js 实例（直解 / ffmpeg 产物）的 ERROR 回调**先比对序号**，不是当前实例的事件
  直接丢弃。
- 卡顿看门狗里：只要画面真的在动，就**无条件**收起 spinner 与错误面板
  （以前只在 spinner 还挂着时才收）。
## 1.6.16

**修复：编解码接管被「迟到的旧报错」反复触发，画面永远起不来**

现场（2026-10-10 22:16:26~28，线路一，应用内日志）：

```
22:16:26.762 [play] 编码不支持（bufferAddCodecError）：改走 ffmpeg 接管，线路1
22:16:26.777 [ffmpeg] 会话已建：id=2c57d71331ccac13 … 只换壳
22:16:27.289 [hls-ffmpeg] 起播等待：列表已就绪 4 秒（目标 20 秒）
22:16:28.885 [video] emptied            ← 刚建好的会话被拆掉
22:16:28.979 [play] 编码不支持（bufferAddCodecError）：改走 ffmpeg 接管，线路1
22:16:28.983 [ffmpeg] 已关闭上一个接管会话 2c57d71331ccac13
22:16:28.992 [ffmpeg] 会话已建：id=1e47ca5b88943873 …
22:16:34.692 [play] 编码不支持（bufferAddCodecError）：改走 ffmpeg 接管，线路1
```

被销毁的直解 hls.js 实例还有排队中的错误事件，它们在新会话「起播等待」期间才被派发，
于是一次次把刚建好的会话拆掉重建 —— 每次都要重新等 20 秒，画面一次都没起来。

修复（`renderer/app.js`）：

1. 编解码接管按**播放令牌**上锁（`state.ffmpegHandoffToken`）：同一次播放只交出去一次；
2. 只要已经在 ffmpeg 路径上（`state.ffmpegFallback` 或已有会话 `state.remuxSid`），
   这类报错一律忽略并记一行日志，不再触发接管；
3. 这条分支**永不落到 failNextEngine** —— 迟到报错不该把一条正在接管的线路拉黑。

**验证**：见 PATCH-NOTES-1.6.16.md（连续观测：接管次数 = 1，起播后时间轴持续推进）。
## 1.6.15

**修复：把「一时一地被拒」当成「线路死了」**

- 预检侧：分片返回 **403 / 429** 时不再判死线，按「不确定」放行。
  实测（2026-10-10 22:14）线路四那条 192.168.1.10:19105 中转源：预检报 403，
  同一时刻用普通 GET / 带 Range 的 GET / 6 个并发请求直接打它最新那片，全是 206 或 200 ——
  这个 403 是一时一地的，而按死线处理会把能播的线路标红。**404 / 410 仍然是真死。**
- 播放侧：分片 4xx 先跳到直播边缘重试；等 `edgeSeeks` 次数用尽还不行，
  就老老实实换线路（以前只弹一句提示、既不换线也不报错，表现就是「什么都不播」）。

**配套**：1.6.14 的「预检从最新一片往下退最多 3 片再判死」保留 —— 两条一起，
才既有容错、又不会把真死的线路（例如那两条列表只剩 1 片且那片 404 的中转源）留下来。
## 1.6.14

**修复：预检拿「最新那一片」判死，把能播的好线路误杀了**

现场（2026-10-10 22:12）：CCTV1 的线路二、线路三（都是 3.1 Mbps 的 H.264/AAC 直出，
本机实测能正常取流）同时被判「源不可用：分片 HTTP 404」，于是播放只好退到又慢、
又需要重编视频的线路上 —— 用户看到的就是「好线路全红、最后什么都播不了」。

根因：预检只拿播放列表里**最新**那一片去试。有些中转源最新一片还没准备好
（回 404/403），倒数第二片却好好的；只试一片就会误判。

修复（`src/server.js`）：新增 `segmentCandidates()`，预检从最新一片往下**退最多 3 片**
依次试，任意一片能取到就判活线；三片都被明确拒绝才判死线。
超时与未知网络错误照旧不判死。

**验证**：见 PATCH-NOTES-1.6.14.md（对 CCTV1 全部线路重跑预检）。
## 1.6.13

**修复：源是 H.264、参数也「标准」，但 Chromium 就是不收 —— 根因是 SPS 里的 constraint 字节**

现场（2026-10-10 22:08 应用内日志）：ffmpeg 换壳成功、分片一直在产出，
播放器却在 append 时连报三个致命错误：

```
[hls-ffmpeg] ERROR mediaError/bufferAddCodecError fatal=true
[hls-ffmpeg] ERROR mediaError/bufferIncompatibleCodecsError fatal=true reason=could not create source buffer for media codec(s)
```

用一个干净的 hls.js 实例复现（新 video + 新 Hls），拿到了浏览器给的原文：

```
mime = video/mp4;codecs=mp4a.40.2,avc1.640128
err  = Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided
       ('video/mp4;codecs=mp4a.40.2,avc1.640128') is unsupported
```

逐条验证 `MediaSource.isTypeSupported`：

| codec 串 | 支持 |
| --- | --- |
| `avc1.640128` | **false** |
| `avc1.640129` | **false** |
| `avc1.640028` | true |
| `avc1.64001f` / `avc1.640020` / `avc1.4d401f` | true |

**差别只在第二个字节**（constraint flags 0x01 vs 0x00）。ffprobe 显示这条源是
H.264 High / level 4.0 / yuv420p / 1280×720 —— 一切「正常」，问题出在那个字节上。
`-c:v copy` 会把源 SPS 原样搬进输出，所以 ffmpeg 做得再对也没用；
而 VLC / PotPlayer 不走 MSE，自然没这回事。

修复（三处）：

1. `src/server.js`：`POST /api/remux` 新增可选参数 `video: 'copy' | 'transcode'`；
2. `src/local.js`：会话记住 `videoMode`，`transcode` 时用 libx264 真编一遍
   （libx264 产出的 SPS 是浏览器认的那种），音频照旧重编 AAC；
3. `renderer/app.js`：ffmpeg 产出的 HLS 一旦报 `bufferAddCodecError` /
   `bufferIncompatibleCodecsError`，自动带 `video:'transcode'` 重试一次
   （只重试一次，避免来回折腾），并把浏览器给的 mime 记进诊断日志。

**验证**：一个干净 hls.js 实例加载 `video:'transcode'` 的产物 —— 不再出现
bufferAddCodecError，时间轴推进、分辨率出画。
## 1.6.12

**修复：H.264 + ADTS AAC 的源，ffmpeg 换壳必失败**

线路一与线路四实测：`POST /api/remux` 返回 ok=true、ffmpeg 也起来了，但 1 秒后就死，
会话体检里的遗言是：

```
[out#0/hls @ ...] Error writing trailer: Operation not permitted
... use the audio bitstream filter 'aac_adtstoasc' to fix it ...
```

根因在 `src/local.js` 的输出参数：音频是 AAC 时走了 `-c:a copy`，而 **fMP4 容器不收
ADTS 形式的 AAC**，必须加 `-bsf:a aac_adtstoasc`。

修复：**音频一律重编 AAC**（`-c:a aac -b:a 128k -ac 2`），不再 copy。
128k 立体声对 CPU 是零头，而这一次性覆盖 MP2 / AC-3 / ADTS-AAC / LATM-AAC 全部情况；
视频仍然是 `-c:v copy`，真正吃 CPU 的部分没有变。

**验证**：线路一（H.264 720p + AAC）用同参数手动换壳 14 秒产出 7 个分片，
浏览器可直接播的 fMP4 + AAC。
## 1.6.11

**修复：编码探测一直失败 —— ffprobe 吃了 ffmpeg 专有选项**

`src/local.js · networkInputArgs()` 里那三条吞吐/追赶选项
（`-readrate` / `-readrate_initial_burst` / `-readrate_catchup`）是 **ffmpeg CLI 自己的
输入选项**（在 fftools 里），**ffprobe 没有它们**。同一套参数喂给 ffprobe 时第一句就报：

```
Failed to set value '1' for option 'readrate': Option not found
```

于是每一次编码探测都直接退到「解析 `ffmpeg -i` 的 stderr」那条退路，而那条退路当时
拿的是**不带任何输入参数**的裸 `-i`，遇到「分片地址没有扩展名」的源（ysp-live 那种
`/segment/<base64>`）又被 ffmpeg 的扩展名检查拒掉 —— 两头都失败，界面显示
「无法解析这个文件（不是有效视频？）」，线路一因此被误判成播不了。

修复：

1. 新增 `probeInputArgs()`：喂给 ffprobe 之前把那三条 ffmpeg 专有选项摘掉；
2. 退路 `ffmpeg -i` 补上同一套输入参数（含 1.6.10 的扩展开关与防盗链头）。

**验证**：`ffprobe -extension_picky 0 -i <线路一>` 现在能读出
`aac,audio` + `h264,video`；同参数下 ffmpeg 手动换壳 14 秒产出 7 个分片。
## 1.6.10

**修复：两条「明明能播却标红」的线路，根因都找到了**

### 1. 线路一（ysp-live 中转源）：ffmpeg 直接拒收整条流

那条源的清单写着 `http://192.168.1.10:3000/cctv1/segment/<base64>` —— **分片地址没有 .ts 后缀**。
ffmpeg 的 hls 解复用器有两道扩展名检查（`allowed_segment_extensions` 白名单 +
`extension_picky` 格式与后缀一致性），任何一道不过就整条流报
「Invalid data found when processing input」——而 hls.js / VLC 根本不看后缀。

本机 ffprobe 实测同一条线路：

| 参数 | 结果 |
| --- | --- |
| （默认） | 失败：`is not in allowed_segment_extensions` |
| `-allowed_segment_extensions ALL` | 仍失败：`detected format mpegts extension none mismatches allowed extensions` |
| **`-extension_picky 0`** | **成功：`stream,aac,audio` + `stream,h264,video`** |

修复：`src/local.js · networkInputArgs()` 给所有网络输入加上
`-allowed_segment_extensions ALL -extension_picky 0`（两条都是输入级选项，写在 `-i` 之前）。
由此「PotPlayer / VLC 能播、我们的 ffmpeg 说不是有效视频」这一类现象一并解决。

### 2. 线路四（:19105 relay）：部分分片 403，不该判死整条线

本机用同一条 ffmpeg 命令单独拉那条 relay 实测：清单正常、**一部分分片 HTTP 403**，
ffmpeg 的处理是「failed too many times, skipping」跳过去继续出片（照样有画面）。
而应用里 403 掉进了「拉黑换线」，于是面板留下「已失败: fragLoadError」。
修复：`renderer/app.js` 把 `fragLoadError` 的处理从「只认 404/410」放宽到**所有 4xx** ——
跳到直播边缘要新分片，跳的次数仍由 `seekToLiveEdge` 自己封顶，不换线、不判死。
## 1.6.9

**修复：慢源被自己的「救援」救坏 —— 3 分钟重建 9 次 MediaSource**

现场日志（2026-10-10 21:46~21:48，CCTV1 直解线路）：画面每隔几秒黑一下，
日志里是连续 9 次

```
21:46:29 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 2 次）
21:46:35 [play] 缓冲见底（0.6s），重建 MediaSource（recoverMediaError）（第 3 次）
...
21:48:41 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 9 次）
```

而那条源一直在约 1× 实时产出（时间轴 103 秒内推进了 105 秒）。根因是我们自己：

- hls.js 官方文档对 `recoverMediaError()` 写得很清楚 ——「Resets the MediaSource and
  restarts streaming from the last known playhead position. This should only be used
  when the media element is in an error state. **It should not be used in response to
  non-fatal hls.js error events.**」而「前向缓冲见底」正是非致命状态；
- 每重建一次，播放头就落到最新数据处，前向缓冲只剩几秒，下一次抖动必然又见底 ——
  于是「重建 → 缓冲归零 → 再重建」变成死循环，每次都是一次可见黑屏；
- VLC / mpv / PotPlayer 在这种情况下的做法只有「等」：数据一到接着播，时间轴不跳、
  缓冲不清。

**改动（`renderer/app.js`）**

1. 卡顿看门狗按「数据还在不在来」分三档：
   ① 时间轴还在动 → 什么都不做；
   ② 时间轴不动但缓冲末端还在长（8 秒内来过数据）→ 继续等；
   ③ 时间轴不动且连续 8 秒没有任何新数据（真僵住）→ 先 `startLoad()`，
   第二次仍僵住才 `recoverMediaError()`。
2. 「喂不满码率」判定补一道闸：只有源**真的停供**才拉黑换线；
   缓冲薄但一直在交付数据的慢源不再被判死（以前面板上一屏红色就是它）。
3. 致命缓冲错误不再 `seekToLiveEdge('缓冲见底')`（那等于把攒下的缓冲一次丢掉），
   只保留「缓冲里真有空洞」时的跳洞。

**验证**：见 PATCH-NOTES-1.6.9.md（实机连播观测：重建次数、卡顿次数、时间轴推进）。
## 1.6.8

**修复：两类「明明能播却当场判死」的线路**

1. **`bufferAddCodecError` 不再拉黑线路，改为交给内置 ffmpeg。**
   hls.js 报这个错的意思是「连 SourceBuffer 都建不起来」—— 这条流的编码 Chromium
   不认（MP2 / AC-3 音频、HEVC 视频这类），不是线路坏了。以前它掉进换线逻辑，
   面板上留下一条「已失败: bufferAddCodecError」，然后去试下一条（常常是同一个源，
   一样建不起来），于是一屏线路一条条变红。现在：直接拿当前这条线路走 ffmpeg
   换壳/转码，并和转码档主路径一样挂上 `activeAttempt`、起播看门狗、解码看门狗。

2. **预检判死前复测一次。**
   实测（2026-10-10 用户截图）CCTV5 线路三被判「源不可用：列表里没有分片」，
   而同一批线路几秒后重跑预检全部是活的 —— 直播源换窗口的那一瞬间播放列表
   确实可能是空的。现在凡属「可能只是一时抖动」的原因（空列表 / 4xx / 5xx / 拒连）
   都隔 700 毫秒复测一次，复测通过就按活线用，复测仍判死才真判死；
   复测过程本身出错时按「不确定」处理，不判死线。

**验证**
- 预检复测：用「第一次返回空列表、之后返回正常列表」的本地源实测，
  6.6 判死、6.8 判活。
- 转码接管：CCTV5 实机复现（详见 PATCH-NOTES-1.6.8.md）。
## 1.6.7

**修复：转码档「一直转圈不开播」（实测根因）**

- 现象：点开需要 ffmpeg 接管的线路后，画面中央永远停在
  「正在起播（已就绪 0 / 20 秒，最多等 12 秒）」，而右下角的分片其实一直在产出。
- 根因：`handleLocalHls` 等播放列表最长等 25 秒，而播放器读列表用的是
  「fetch + 2~3 秒超时中止」。文件刚写出来的那一刻，发起请求的客户端常常已经断开，
  代码却照样对已断开的响应开读流 —— 读流没有消费者就永远走不到 `end`，fd 再也关不掉。
  而 ffmpeg 每写一次播放列表都是「写 index.m3u8.tmp → 改名成 index.m3u8」，
  Windows 只要目标文件被任何句柄占住就改名失败（libuv 读句柄不带 FILE_SHARE_DELETE，
  已用 MoveFileEx 单独复现）。ffmpeg 对此只留一句 warning，而它是 `-loglevel error`，
  于是 **列表永远停在第一个分片**，播放器就永远等不到 10 片（20 秒）内容。
- 修复（`src/server.js`）：
  1. 循环里先看 `res.destroyed` —— 客户端走了就直接返回，绝不为它打开文件；
  2. 播放列表整份读进内存再回包，读句柄的生命周期与客户端彻底解耦；
  3. 分片仍走流式，但补上 `res.on('close') → stream.destroy()`，
     并且 `handleLocalRaw`（直出档）也一并加上同样的前置检查与兜底销毁。
- 另外（`src/local.js` / `renderer/app.js`）：`/api/remux/status` 新增 `playlistAgeMs`，
  诊断日志里出现「列表更新=32s前」且分片还在涨时按 warn 记录 —— 这类「列表停更但分片在涨」
  的故障从此在日志里看得见，不用再靠猜。

**验证**

- 最小复现（node，`/api/local/hls` 的两种写法 + 会中止的轮询客户端）：
  旧写法 → 文件被永久占住；只加 `res.on('close')` → 仍被占住（close 早已触发过）；
  本版写法 → 无占用。
- 线上实测：修复后在运行中的 HubPlay 上重放同一套中止轮询，播放列表持续增长、
  无句柄残留。

## 1.6.6

**可用性**
- 起播前对候选线路做可用性预检：把「播放列表能拿到、但分片被源站拒绝」的僵尸线路提前挑出并跳过。
  过去这类线路要等 HLS → 裸TS → FLV 三级引擎依次失败才放手，一条白烧十几秒，最后报出来的
  还是最后一级引擎的提示（如「FLV 解码失败」），与真实原因无关。
- 预检按错误类型区分：只有 `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ENETUNREACH` /
  `HTTP 4xx` / `HTTP 5xx` 才判死线；超时与未知网络错误不判死，避免源抖动时误杀正常线路。
- ffmpeg 兜底不再使用已判死的线路；指定的线路若已判死，自动改用下一条可用线路。
- 错误面板新增「重试这个频道」按钮，并把失败原因逐条列出（此前只报最后一条，且面板上
  写着「重新测速后再试」却没有任何可点的动作）。

**修复**
- 修 `measureLine()` 取错分片：过去取直播滑动窗口里**最旧**（通常已被上游删除）的分片做测速，
  必然 404，导致测速长期失败、候选排序拿不到实测速度。改为取最新分片。
- 死线判定结果带上原因并写入缓存，不再反复重探。
- 修复「起播等待」提示在画面已经在播时仍不消失的问题（清提示的逻辑过去只挂在直解路径上）。

**版本号**
- 统一版本号。此前 `package.json` 长期停留在 1.6.3，而界面标题与「关于」框都读该值，
  导致显示版本与实际内容不一致。本版起以界面标题为准。

## 1.6.5 及更早

- 内置 ffmpeg 兜底：Chromium 没有 MPEG-2 / MP2 / HEVC / AC-3 等解码器，
  由随包 ffmpeg 转成 H.264 + AAC 的 fMP4 HLS 播放；VLC / PotPlayer 能播而浏览器播不了的源由此可用。
- 抖动治理：目标延迟 8 秒、前向缓冲上限 120 秒；`-readrate` / `-readrate_initial_burst` /
  `-readrate_catchup` 三件套让转码跑在直播前面；服务端预取缓存把分片提前取到内存，不再等源站发布节奏。
- 看门狗与两级救援：缓冲见底先 `startLoad()`，仍无效则 `recoverMediaError()` 重建 MediaSource。
- 直播判活不再只看 `readyState`：改为「时间轴在推进且有分辨率」的帧读数，避免有数据但不出帧时永远转圈。