# HubPlay 1.6.10 → 1.6.27 · 这一轮的病根与验证

同一份内容在 CHANGELOG.md 里按版本记着，这里只留**最值得记的三件事**和证据。

## 1. 真根因：源 SPS 的保留位（1.6.24）

- 现象：`-c:v copy` 出来的 fMP4，浏览器报
  `addSourceBuffer … ('video/mp4;codecs=mp4a.40.2,avc1.640128') is unsupported`。
- 取证：`ffmpeg -bsf:v trace_headers` 读出这条源 `profile_idc=100`、
  `constraint_set0~5 全为 0`；ffmpeg 把 SPS 原样抄进 avcC 后，
  `profile_compatibility` 字节 = 0x01（那两位 `reserved_zero_2bits`，规范要求为 0）。
- 对照实验：同一会话、同一份分片，只把该字节 0x01 改成 0x00 →
  `errs=[]`、`t=26.08`、`w=1280`、`rs=4` —— **不转码直接播**。
- 修复：服务端吐 `init.mp4` 时清掉这两位（`sanitizeInitSegment`，src/server.js）。
- 附带：这条源的分片里也内嵌同一个非法 SPS 时，换壳档会被浏览器拒收
  （`CHUNK_DEMUXER_ERROR_APPEND_FAILED`）→ 1.6.25 起自动升级为重编并记住该源。

## 2. 慢源要按慢源的策略播（1.6.27）

- 实测某 MP2 频道：34 个分片 / 90 秒 ≈ **0.76× 实时**（源比播放还慢）。
- 旧策略（起播等 10 片 / 站边缘 8 秒 / 落后超 40 秒拽回边缘）对它是反的：
  用户先干等 20~30 秒，开播时只剩 8 秒余量，然后反复见底。
- 新策略：门槛 3 片、最多等 8 秒；起播位置 = **最早一片**；
  `liveMaxLatencyDurationCount` 拉大、追速 = 1（落后是常态，不往前拽）。
- 实测起播时序：

```
22:57:49.178 起播等待：列表已就绪 2 秒（目标 6 秒）
22:57:49.583 起播就绪：10 秒内容（达标即开播）
22:57:51.585 [play] 出画成功：rs=4 1280x720 t=1.76
```

**2.4 秒出画**（旧版 20~30 秒）。

## 3. 工程上的两个坑

- `src/preload.js` 之前不在打包文件列表里 → preload 的改动一直不生效
  （1.6.21 修正；此后每次打包都解包回来 grep 关键改动）。
- `-readrate` 是 ffmpeg CLI 专有选项、ffprobe 不认 → 编码探测长期静默失效（1.6.11 修正）。

## 4. 这一轮新增的能力

- **用外部播放器打开**（1.6.19/21/22）：自动识别 PotPlayer / VLC / mpv，
  并把防盗链的 UA/Referer 传给 VLC（`--http-referrer` / `--http-user-agent`）与 mpv
  （`--http-header-fields`）；PotPlayer 没有这个开关，界面会如实提示。
  实测命令行：
  `"…\vlc.exe" --http-referrer=https://tv.cctv.com/ --http-user-agent=HubPlayTest/1.0 http://…`
- **HEVC 直通**（1.6.23）：渲染端把 `mediaCapabilities` 的结论带给服务端，能硬解就不转码。
- **转码档硬件解码**（1.6.23）：`-hwaccel auto`（在 `-i` 之前），本机不成立时自动去掉重跑一次。
