'use strict';
/**
 * 直播窗口测量 + hls.js 缓冲参数推导。
 *
 * 为什么要有这个文件（2026-10 实测结论，这是「很卡 / 基本看不了」的根因）：
 *
 * 这些 IPTV 源的 HLS 直播列表**只有 3~5 个分片**，也就是总共 15~25 秒的窗口
 * （CCTV1 的 11 条线路逐条实测：iptv-hub 自带 relay 是 3 分片 / 15 秒，
 *  其余 hls/54 类源是 5 分片 / 20 秒，tsfile 类源 5 分片 / 25~50 秒）。
 * 上游删分片还非常快 —— 在 5 分片的窗口里,第 3 旧的那个分片 10 秒内就变成 404，
 * 也就是说实际保留时间只有 16 秒左右。
 *
 * 而「调大缓冲」在直播里等于「把播放点往回挪」。一旦播放点被挪到窗口之外，
 * 我们要的分片上游早就删了 → hls.js 只能拿到空洞 → 画面卡住 → 因为每次卡顿
 * 都会让播放点更落后，它就一路漂到离直播边缘几十秒的地方再也回不来。
 * 症状就是统计面板上「前向缓冲 48.8 秒 / 目标 46.0」却依然一直卡 ——
 * 缓冲里堆的是能拿到的旧数据，而播放头所在的位置根本没有数据。
 *
 * PotPlayer / ok影视 / 手机端之所以正常，正是因为它们贴着直播边缘播、几乎不回看。
 *
 * 所以缓冲深度必须**由源窗口长度反推**，不能写死 60 / 120 秒。
 * 这里就是那个反推逻辑：纯函数、不碰浏览器 API，
 * 因此 tools/livewindow_check.js 可以在 Node 里直接对真实播放列表做断言。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveWin = api;
}(typeof self !== 'undefined' ? self : this, function () {
  /** 量不到窗口时的保守假设：3 个 5 秒分片 = 15 秒，比实测最窄的源还窄。 */
  const FALLBACK_TARGET_DURATION = 5;
  const FALLBACK_SEGMENTS = 3;

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  function toPositive(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * 解析一个 HLS 播放列表，量出「上游愿意给我们多少秒」。
   *
   * 只读文本，不依赖任何库。返回的 `live` 为 true 才代表这是一个可以播的
   * 直播窗口；`master` 为 true 表示这是主列表（内含 #EXT-X-STREAM-INF），
   * 它本身的 #EXTINF 是变体带宽而不是分片时长，不能当窗口用。
   */
  function parseLiveWindow(text) {
    const out = {
      ok: false,
      master: false,
      live: false,
      endList: false,
      targetDuration: 0,
      segments: 0,
      windowSeconds: 0,
      avgSegment: 0,
      minSegment: 0,
      maxSegment: 0,
      discontinuities: 0,
      mediaSequence: null,
    };
    if (typeof text !== 'string' || !text) return out;
    if (!/^\uFEFF?#EXTM3U/.test(text.replace(/^[\s\uFEFF]+/, ''))) return out;
    out.ok = true;

    const durations = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.charAt(0) !== '#') continue;   // 分片 URI，由 #EXTINF 负责计数

      if (line.startsWith('#EXT-X-STREAM-INF')) out.master = true;
      else if (line.startsWith('#EXT-X-TARGETDURATION')) out.targetDuration = toPositive(line.slice(line.indexOf(':') + 1));
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        const n = Number(line.slice(line.indexOf(':') + 1));
        if (Number.isFinite(n)) out.mediaSequence = n;
      } else if (line.startsWith('#EXT-X-ENDLIST')) out.endList = true;
      else if (line.startsWith('#EXT-X-DISCONTINUITY')) out.discontinuities += 1;
      else if (line.startsWith('#EXTINF:')) {
        // #EXTINF:4.72,  或者 #EXTINF:4.72,标题
        const d = toPositive(line.slice(8).split(',')[0]);
        if (d > 0) durations.push(d);
      }
    }

    out.segments = durations.length;
    if (durations.length) {
      out.windowSeconds = durations.reduce((a, b) => a + b, 0);
      out.avgSegment = out.windowSeconds / durations.length;
      out.minSegment = Math.min.apply(null, durations);
      out.maxSegment = Math.max.apply(null, durations);
    }
    out.live = !out.master && !out.endList && out.segments > 0;
    if (!out.targetDuration) out.targetDuration = out.avgSegment || FALLBACK_TARGET_DURATION;
    return out;
  }

  /**
   * 把「源能给多少秒」翻译成 hls.js 的参数。
   *
   * @param win     parseLiveWindow() 的结果
   * @param profile { latencyShare, bufferShare } —— 只用窗口比例表达，
   *                这样换档位不会又变出一组写死的秒数
   * @returns null 当这不是一个可用的直播窗口（点播/本地转码/主列表）——
   *          调用方应回退到静态档位值，那才是「能放心多缓」的场景
   */
  function planFromWindow(win, profile) {
    if (!win || !win.ok || !win.live) return null;
    const p = profile || {};

    const td = clamp(toPositive(win.targetDuration) || FALLBACK_TARGET_DURATION, 1, 30);
    const segments = Math.max(Math.floor(win.segments) || FALLBACK_SEGMENTS, 1);
    const windowSeconds = Math.max(toPositive(win.windowSeconds) || td * segments, td);

    /*
     * 第一步：算「我们敢用掉多少窗口」。
     *
     * 留 5~20% 余量：上游刷新、分片时长抖动、目标延迟向上取整成整片数，
     * 任何一个都可能把播放点顶到窗口外面。预算之外的分片我们一律不要。
     */
    const budgetShare = clamp(
      p.budgetShare == null ? 0.9 : Number(p.budgetShare),
      0.5, 1
    );
    const budget = windowSeconds * budgetShare;

    /*
     * 第二步：把预算分成「退多远」和「前向缓多深」。
     *
     * 抗抖动靠的是**前向缓冲**，而缓冲 = 预算 − 目标延迟，所以「多退一点」
     * 永远是拿缓冲换的。因此这里的 latencyShare 默认很小：只退到
     * 「刚好不在窗口最边上」的那 1 个分片，剩下的预算**全部**变成前向缓冲。
     *
     * 实测教训：在一条 50 秒窗口的线路上，退 20 秒 / 缓限 40 秒反而只剩
     * 2.4 秒实际缓冲（还出现 3 次卡顿）；退 10 秒 / 缓限 35 秒才吃得满。
     * 档位之间真正该拉的差距是「敢用掉多少窗口」，不是「退多远」。
     */
    const latencyShare = clamp(
      p.latencyShare == null ? 0.1 : Number(p.latencyShare),
      0.05, 0.5
    );
    const wantLatency = clamp(windowSeconds * latencyShare, td, budget * 0.5);
    /*
     * liveSyncDurationCount 的单位是分片数，且必须 >= 1。
     * 上限取 floor(segments / 2)：窗口只有 3 个分片时只允许退 1 个 ——
     * 取整是往上走的，如果先取整再夹，会出现「目标延迟比窗口一半还大」的组合
     * （3 分片窗口算出退 2 个 = 10 秒 > 7.5 秒），那正是要避免的越界。
     */
    const maxSync = Math.max(1, Math.floor(segments / 2));
    const liveSync = clamp(Math.round(wantLatency / td), 1, maxSync);
    const targetLatency = round1(liveSync * td);

    // 第三步：剩下的预算全给前向缓冲 —— 这才是抗抖动的余量，越多越好。
    const maxBufferLength = round1(clamp(budget - targetLatency, td, budget));
    const backBufferLength = round1(clamp(windowSeconds * 0.4, td, 30));
    return {
      known: true,
      vod: false,
      targetDuration: td,
      segments,
      windowSeconds: round1(windowSeconds),
      budget: round1(budget),
      targetLatency,
      minSegment: round1(toPositive(win.minSegment) || td),
      maxSegment: round1(toPositive(win.maxSegment) || td),
      liveSyncDurationCount: liveSync,
      // 漂过目标 1.5 个分片就必须往直播边缘拉回来。
      // 旧配置写的是 liveSync * 2（20 秒窗口容忍漂 50 秒）——漂出去就再也回不来。
      liveMaxLatencyDurationCount: round1(liveSync + 1.5),
      // 温和提速追直播：最多快 8%，肉眼看不出来，但能防止一路漂远。
      // PotPlayer 也是这么干的；旧配置是 1.0，等于完全不追。
      maxLiveSyncPlaybackRate: 1.08,
      maxBufferLength,
      // hls.js 的实际上限是 min(maxMaxBufferLength, max(码率推算值, maxBufferLength))，
      // 所以把它设成和 maxBufferLength 一样，才能真正压住。
      maxMaxBufferLength: maxBufferLength,
      // 回看深度不用大：窗口就那么点，留太多旧数据只会在空洞时把播放点拖住
      backBufferLength,
      // 分片 5~7MB、10~13Mbps 很常见，按 4MB/s 给足字节上限，别让字节数先于秒数生效
      maxBufferSize: Math.max(24 * 1e6, Math.round(maxBufferLength * 4 * 1e6)),
    };
  }

  /**
   * 兜底方案（量不到窗口，或者不是直播）。
   *
   * @param profile 缓冲档位
   * @param opts.generous true = 点播 / 本地转码：不受源窗口限制，可以放心多缓
   *                      false（默认）= 直播但没量到窗口：按最窄的源保守处理，
   *                      因为「缓得太深」在这些源上是会真的把播放点推出窗口的
   */
  function fallbackPlan(profile, opts) {
    const p = profile || {};
    const generous = !!(opts && opts.generous);
    const td = FALLBACK_TARGET_DURATION;
    const segments = FALLBACK_SEGMENTS;
    const windowSeconds = td * segments;
    const liveSync = clamp(Math.round(Number(p.liveSync) || 1), 1, segments);
    const maxBufferLength = round1(clamp(
      generous ? (Number(p.seconds) || 60) : (Number(p.liveSeconds) || windowSeconds),
      td, 600
    ));
    const maxMaxBufferLength = round1(clamp(
      generous ? (Number(p.maxSeconds) || maxBufferLength) : maxBufferLength,
      maxBufferLength, 600
    ));
    return {
      known: false,
      vod: generous,
      targetDuration: td,
      segments,
      windowSeconds: round1(windowSeconds),
      targetLatency: round1(liveSync * td),
      minSegment: td,
      maxSegment: td,
      liveSyncDurationCount: liveSync,
      liveMaxLatencyDurationCount: round1(liveSync + 1.5),
      maxLiveSyncPlaybackRate: 1.08,
      maxBufferLength,
      maxMaxBufferLength,
      backBufferLength: round1(clamp(Math.min(maxBufferLength, 30), td, 60)),
      maxBufferSize: Math.max(
        24 * 1e6,
        generous ? Math.round((Number(p.sizeMB) || 150) * 1e6) : 0,
        Math.round(maxBufferLength * 4 * 1e6)
      ),
    };
  }

  return {
    FALLBACK_TARGET_DURATION,
    FALLBACK_SEGMENTS,
    parseLiveWindow,
    planFromWindow,
    fallbackPlan,
  };
}));
