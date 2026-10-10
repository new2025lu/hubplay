# HubPlay 1.6.8 / 1.6.9 · 两轮修复说明（2026-10-10 夜）

> 承接 `PATCH-NOTES-1.6.7.md`（转码播放列表被自己的读句柄锁死）。
> 这两版处理的是用户截图里剩下两类「明明能播却当场判死」和「画面反复黑一下」。

---

## 1.6.8 · 两类误判

### 1. `bufferAddCodecError` 不再拉黑线路，改走 ffmpeg

- 含义：hls.js 连 SourceBuffer 都建不起来 —— 这条流的编码 Chromium 不认
  （MP2 / AC-3 音频、HEVC 视频这类），**不是线路坏了**。
- 旧行为：掉进「换下一条线路」的逻辑 → 面板留下一条
  「已失败: bufferAddCodecError」，而去试的下一条常常是同一个源，一样建不起来。
- 新行为（`renderer/app.js`）：拿**当前这条**线路交给内置 ffmpeg 换壳/转码，
  并和转码档主路径一样挂上 `activeAttempt` + 起播看门狗 + 解码看门狗；
  ffmpeg 真起不来才退回原来的换线逻辑。

### 2. 预检判死前复测一次

- 现场：CCTV5 线路三被判「源不可用：列表里没有分片」，而几秒后同一批线路重跑预检
  全部是活的 —— 直播源换窗口的那一瞬间播放列表确实可能是空的。
- 新行为（`src/server.js`）：`preflightHls` 包了一层 —— 凡属「可能只是一时抖动」的原因
  （空列表 / 主列表没有变体 / 4xx / 5xx / 拒连）都隔 700 毫秒复测一次；
  复测通过按活线用（并记 note），复测仍判死才真判死，复测本身出错按「不确定」处理。

---

## 1.6.9 · 慢源被自己的「救援」救坏

### 现场（2026-10-10 21:46~21:48，CCTV1 直解线路，应用内诊断日志）

```
21:46:23 [play] 缓冲见底（1.1s），救活加载器（startLoad）（第 1 次）
21:46:29 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 2 次）
21:46:35 [play] 缓冲见底（0.6s），重建 MediaSource（recoverMediaError）（第 3 次）
21:46:45 [play] 缓冲见底（0.6s），重建 MediaSource（recoverMediaError）（第 4 次）
21:46:51 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 5 次）
21:46:53 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 6 次）
21:46:55 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 7 次）
21:48:39 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 8 次）
21:48:41 [play] 缓冲见底（0.1s），重建 MediaSource（recoverMediaError）（第 9 次）
```

3 分钟 9 次重建，每次都是一次可见黑屏；而同一条源在 103 秒里把时间轴推进了 105 秒
（≈1×，并没有断流）。**越救越糟**：每重建一次，播放头落到最新数据处，前向缓冲只剩几秒，
下一次抖动必然又见底。

### 外部依据（不是自己拍脑袋）

- hls.js 官方文档 `docs/API.md` 对 `hls.recoverMediaError()` 的原话：
  「Resets the MediaSource and restarts streaming from the last known playhead position.
  **This should only be used when the media element is in an error state. It should not be
  used in response to non-fatal hls.js error events.**」而「前向缓冲见底」正是非致命状态。
- hls.js 自己就带直播延迟控制器：`liveSyncDurationCount`、`liveMaxLatencyDurationCount`、
  **`liveSyncOnStallIncrease`**、`maxLiveSyncPlaybackRate`（默认 1，即不追速）、
  `nudgeMaxRetry`（默认 3）、`detectStallWithCurrentTimeMs`（默认 1250）。
  卡顿时正确的动作是让 hls.js 自己加大目标延迟/重挂加载，而不是我们重建 MediaSource。

### 改动（`renderer/app.js`）

1. 看门狗新增「数据还在不在来」的判据（缓冲末端是否还在增长），按三档处理：
   ① 时间轴还在动 → 什么都不做；② 时间轴不动但 8 秒内来过数据 → 继续等；
   ③ 时间轴不动且连续 8 秒没有新数据（`STALL_QUIET_MS`）→ 先 `startLoad()`，
   第二次仍僵住才 `recoverMediaError()`。
2. `checkStarvation`（喂不满码率）补一道同样的闸：只有源真的停供才拉黑换线，
   缓冲薄但一直在交付的慢源不再被判死。
3. 致命缓冲错误不再 `seekToLiveEdge('缓冲见底')`（那等于把攒下的缓冲一次丢掉），
   只保留「缓冲里真有空洞」时的跳洞。

---

## 验证状态

| 项 | 结果 |
| --- | --- |
| 预检复测 | 用「第一次返回空列表、之后返回正常列表」的本地源实测：1.6.8 判活（合成服务器请求计数 = 2） |
| 1.6.9 起播后 30 秒 | `state.loaderRescues = 0`（旧版同一时段已经开始重建） |
| 更长的连续观测 | **未完成** —— 观测期间应用进程退出了 3 次（无崩溃记录），日志只拿到 30 秒样本 |
| 面板仍标红的两条 | 线路一（bufferAddCodecError 后 ffmpeg 也没起来）、线路四（**最新**分片持续 403）→ 下一轮候选改法：最新分片 403 时退一格取次新分片再判死 |
