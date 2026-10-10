'use strict';

/**
 * 上游分片预取缓存。
 *
 * 为什么需要它（2026-10-07 实测得出的结论）：
 *   这条 MPEG-2 源是**突发式交付** —— 播放列表里**恒定握着约 21.6 秒存量**（5 片 × 4.3 秒），
 *   但新分片每 4.3~4.8 秒才发布一个，也就是**源端产出 ≈ 1.0 倍实时**。
 *   于是任何"按实时节奏读源"的播放端（ffmpeg 也好、播放器也好）都只能拿到
 *   刚好够播的量：缓冲永远在 0~2 秒徘徊，一遇到源端停顿就见底。
 *
 *   实测排除了其它可能：通道能力 9.3 倍实时（59~119 Mbps）、转码 1.8~4.4 倍、
 *   上游手上一直有 21.6 秒存量。**唯一的问题是我们在等源站发布。**
 *
 * 做法：
 *   发现播放列表后，**立刻把所有分片拉下来存到内存**（不等到被请求）。
 *   之后 /p 代理在内存里命中就直接吐出去，ffmpeg 读本地缓存能以最高速度跑，
 *   于是能真正跑在直播前面、把缓冲攒起来；源端停顿期间我们照样有货可发。
 *
 * 边界：
 *   - 只缓存分片（.ts/.m4s/.mp4/.aac 之类），不缓存播放列表（列表必须实时）；
 *   - 内存上限 96 MB，超了就丢最旧的（约 4~5 分钟 SD 内容，够用）；
 *   - 只预取最多 24 个分片，避免把上游窗口刷爆；
 *   - 单流最多 3 个并发下载，别把上游打疼。
 */

/** 分片特征：真正要缓存的是这些（播放列表走另一条路）。 */
const SEGMENT_RE = /\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i;

class PrefetchCache {
  constructor({ maxBytes = 96 * 1024 * 1024, concurrency = 3, horizon = 24, pollMs = 2000 } = {}) {
    this.maxBytes = maxBytes;
    this.concurrency = concurrency;
    this.horizon = horizon;
    this.pollMs = pollMs;
    this.bytes = 0;
    this.store = new Map();      // url -> { buf, type, at }
    this.streams = new Map();    // playlistUrl -> { inflight, seen:Set, timer, stats }
    this.stats = { fetched: 0, hits: 0, misses: 0, expired: 0 };
  }

  /** 是否值得预取（只挑分片，列表/密钥/字幕之类跳过）。 */
  isSegment(url) { return SEGMENT_RE.test(String(url)); }

  /** 命中缓存：返回 { buf, type } 或 null。 */
  get(url) {
    const hit = this.store.get(url);
    if (hit) {
      hit.at = Date.now();
      this.stats.hits += 1;
      return hit;
    }
    this.stats.misses += 1;
    return null;
  }

  _put(url, buf, type) {
    if (this.store.has(url)) return;
    this.store.set(url, { buf, type, at: Date.now() });
    this.bytes += buf.length;
    this.stats.fetched += 1;
    // 超限就按最旧的使用时间淘汰（简单 LRU）
    while (this.bytes > this.maxBytes) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.store) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      }
      if (!oldestKey) break;
      this.bytes -= this.store.get(oldestKey).buf.length;
      this.store.delete(oldestKey);
      this.stats.expired += 1;
    }
  }

  /**
   * 开始盯一条上游播放列表：每次刷新都把所有新出现、还没缓存的分片排进下载队列。
   * 幂等 —— 同一条列表重复调用不会重复起线程。
   */
  watch(playlistUrl, ctx = {}, fetcher) {
    if (this.streams.has(playlistUrl)) return;
    const st = { inflight: 0, queue: [], seen: new Set(), timer: null, playlist: playlistUrl, ctx, errors: 0 };
    this.streams.set(playlistUrl, st);
    const tick = async () => {
      try {
        const list = await fetcher.fetchPlaylist(playlistUrl, ctx);
        const segs = list.filter((u) => this.isSegment(u));
        const fresh = segs.filter((u) => !st.seen.has(u) && !this.store.has(u));
        for (const u of fresh) {
          if (st.seen.size > 4000) st.seen.clear();
          st.seen.add(u);
          st.queue.push(u);
        }
        // 只保留最新的一段，避免无限追
        if (st.queue.length > this.horizon) st.queue = st.queue.slice(-this.horizon);
        this._pump(st, fetcher);
      } catch (err) {
        st.errors += 1;
      } finally {
        st.timer = setTimeout(tick, this.pollMs);
        if (st.timer.unref) st.timer.unref();
      }
    };
    tick();
  }

  _pump(st, fetcher) {
    while (st.inflight < this.concurrency && st.queue.length) {
      const url = st.queue.shift();
      st.inflight += 1;
      fetcher.fetchSegment(url, st.ctx)
        .then((r) => { if (r && r.buf && r.buf.length) this._put(url, r.buf, r.type); })
        .catch(() => { /* 预取失败不影响播放：真播时还会再请求一次 */ })
        .finally(() => { st.inflight -= 1; this._pump(st, fetcher); });
    }
  }

  /** 诊断快照。 */
  snapshot() {
    return {
      entries: this.store.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      streams: [...this.streams.entries()].map(([u, s]) => ({
        playlist: u, seen: s.seen.size, queued: s.queue.length,
        inflight: s.inflight, errors: s.errors,
      })),
      stats: this.stats,
    };
  }

  stop() {
    for (const st of this.streams.values()) { if (st.timer) clearTimeout(st.timer); }
    this.streams.clear();
  }
}

/**
 * 用 Node 自带 http/https 抓一份内容（只用于预取，不复用代理那条路径，
 * 避免「预取 → 代理 → 预取」绕成圈）。
 */
function fetchBinary(urlStr, ctx = {}, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (err) { return reject(err); }
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const headers = { 'User-Agent': ctx.ua || 'okhttp/4.9.0' };
    if (ctx.ref) headers.Referer = ctx.ref;
    const req = mod.get({
      protocol: u.protocol, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, headers, timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchBinary(new URL(res.headers.location, u).toString(), ctx, limit).then(resolve, reject);
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        buf: Buffer.concat(chunks),
        type: String(res.headers['content-type'] || 'video/mp2t'),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * 把一份**原始**播放列表里的分片 URL 解析成绝对地址。
 * 只认分片行（非 # 开头），并把相对路径按 baseUrl 补全。
 */
function segmentUrls(rawText, baseUrl) {
  const out = [];
  for (const line of String(rawText || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    try { out.push(new URL(s, baseUrl).toString()); } catch (err) { /* 跳过坏行 */ }
  }
  return out;
}

module.exports = { PrefetchCache, fetchBinary, segmentUrls };
