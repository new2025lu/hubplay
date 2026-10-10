'use strict';

/**
 * 本地服务：界面托管 + 流代理 + iptv-hub 聚合。
 *
 * 把界面也放在这个 127.0.0.1 服务上，而不是用 file:// 打开，好处是
 * 「界面 / 接口 / 流」三者同源，CORS 问题一次性消失。
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { PassThrough } = require('stream');

const stream = require('./stream');
const playlist = require('./playlist');
const hub = require('./hub');
const local = require('./local');
const { PrefetchCache, fetchBinary, segmentUrls } = require('./prefetch');

/*
 * 上游分片预取缓存。
 *
 * 实测结论（2026-10-07）：这条 MPEG-2 源是突发式交付，新分片每 4.3~4.8 秒才发布一个、
 * 每片只有 4.3 秒内容 —— **源端产出 ≈ 1.0 倍实时**。所以任何「按实时节奏读源」的
 * 播放端都只能拿到刚好够播的量，缓冲永远在 0~2 秒徘徊。
 * 而通道有 9.3 倍余量、上游列表里恒定躺着 21.6 秒存量 —— 也就是说：
 * **只要我们把分片提前拉到本地，就不必再等源站发布。**
 * 这份缓存就是干这个的：/p 代理命中内存就直接吐，ffmpeg 因此能跑在直播前面。
 */
const prefetch = new PrefetchCache();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  // 本地视频/音频：Content-Type 给对，Chromium 才能正确选择解复用器
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.rm': 'application/vnd.rn-realmedia',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
};

const DEFAULT_CONFIG = {
  sourceUrl: '',
  favorites: [],
  volume: 1,
  lastChannel: '',
  mute: false,
  autoHide: true,
  bufferPreset: 'balanced',
  // 视频解码方式：auto(独显优先→核显→软件) | discrete | integrated | software
  // 主进程要在 app ready 之前读它来决定命令行开关，所以必须落盘。
  decodeMode: 'auto',
};

function sendJSON(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { ok: false, error: message });
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function safePathname(urlStr) {
  try {
    return new URL(urlStr).pathname;
  } catch (err) {
    return String(urlStr || '').split('?')[0];
  }
}

/** 固定并发跑一批任务，单个失败不影响其他。 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }));
  return results;
}

/**
 * 实测一条线路的吞吐（KB/s）。
 *
 * 是 m3u8 就先取播放列表、再抓第一个分片；是裸流就直接读。
 * 只读到时间预算用完或字节上限，然后立即断开。
 */
async function measureLine(line, budgetMs, maxBytes, deadlineMs) {
  const ctx = { ref: line.ref || '', ua: line.ua || '' };
  // 硬上限：读播放列表 + 采样。
  // 起播前的选线测速会显式传一个更小的 deadline —— 那一步用户正在等，
  // 宁可拿不到某条慢线路的数字，也不能让起播卡住（拿不到就按原顺序兜底）。
  const deadline = Math.min(Math.max(Number(deadlineMs) || (budgetMs + 6000), 1000), 20000);
  const withTimeout = (p, ms, msg) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);

  let upstream = null;
  try {
    const opened = await withTimeout(stream.openUpstream(line.url, ctx), deadline, '连接上游超时');
    upstream = opened.res;
    const finalUrl = opened.finalUrl;
    const status = upstream.statusCode || 200;
    if (status >= 400) throw new Error(`HTTP ${status}`);

    const ct = String(upstream.headers['content-type'] || '');
    const first = await withTimeout(stream.peekFirstChunk(upstream, 6000), deadline, '读取首包超时');
    const kind = stream.detectContainer(first, ct, safePathname(finalUrl));

    let target = upstream;
    let bitrateBps = 0;      // 估算码率，用来判断一条线路到底「够不够用」
    if (kind === 'hls') {
      // 读播放列表也要有超时：有的源返回的响应永远不结束，readAll 会一直挂着，
      // 进而把整个测速接口拖死（pool 在等这个 Promise）。
      const listBuf = await withTimeout(
        stream.readAll(upstream, 4 * 1024 * 1024, first),
        deadline,
        '播放列表读取超时'
      );
      const text = stream.decodeBody(listBuf, upstream.headers['content-encoding']).toString('utf8');
      const plain = text.split(/\r?\n/);
      /*
       * ⚠️ 必须取**最新**的分片（列表里最后一个），不能取第一个。
       *
       * 直播滑动窗口里第一条是**最旧的、通常已被上游删掉**，拿它去测必然 404。
       * 实测（某直播源）：滑动窗口里最旧的那个分片已经不存在，
       * 而列表里最后一条还在。方向反了会让测速对几乎所有直播线路都失败 ——
       * 表现就是「候选排序永远拿不到实测速度」+「好线路被当成死线」。
       */
      const segs = plain.filter((l) => l.trim() && !l.startsWith('#'));
      const seg = segs.length ? segs[segs.length - 1] : null;
      if (!seg) throw new Error('播放列表里没有分片');
      // 用 EXTINF 时长 + 分片字节数估算码率
      const ext = plain.find((l) => l.startsWith('#EXTINF'));
      const dur = ext ? parseFloat(ext.slice(ext.indexOf(':') + 1)) : 0;
      const segUrl = new URL(seg.trim(), finalUrl).href;
      const segRes = await withTimeout(stream.openUpstream(segUrl, ctx), deadline, '连接分片超时');
      target = segRes.res;
      if ((target.statusCode || 200) >= 400) throw new Error(`分片 HTTP ${target.statusCode}`);
      const segLen = Number(target.headers['content-length'] || 0);
      if (segLen > 0 && dur > 0) bitrateBps = (segLen * 8) / dur;
    }

    // 计时采样
    const started = Date.now();
    let bytes = 0;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        target.removeListener('data', onData);
        try { target.destroy(); } catch (err) { /* ignore */ }
        resolve();
      };
      const onData = (chunk) => {
        bytes += chunk.length;
        if (bytes >= maxBytes || Date.now() - started >= budgetMs) finish();
      };
      target.on('data', onData);
      target.on('end', finish);
      target.on('error', finish);
      setTimeout(finish, budgetMs + 2000);
    });

    const seconds = Math.max((Date.now() - started) / 1000, 0.05);
    return { kbps: bytes / 1024 / seconds, bitrateBps };
  } finally {
    // 不管成败都断开，别把连接漏在那儿
    try {
      if (upstream) upstream.destroy();
    } catch (err) { /* ignore */ }
  }
}

/** 主列表里的第一个变体地址（没有则返回 null）。 */
function firstVariant(text, baseUrl) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    try { return new URL(s, baseUrl).href; } catch (err) { return null; }
  }
  return null;
}

/** 媒体列表里**最新**那个分片（滑动窗口里唯一还该存在的）。 */
function newestSegment(text, baseUrl) {
  const list = segmentCandidates(text, baseUrl, 1);
  return list.length ? list[0] : null;
}

/**
 * 媒体列表里最后几个分片（最新在前）。
 *
 * 为什么需要「不止一个」：预检本来是拿**最新**那个分片去试，试不到就判这条线路死。
 * 但实测（2026-10-10 22:12）有这类中转源：清单正常，**最新那一片**还没准备好
 * （返回 404），而倒数第二片好好的。只试最新一片就会把完全能播的线路误判成死线，
 * 面板上留下「源不可用：分片 HTTP 404」，而播放器只好退到又慢又难解的线路上 ——
 * 这正是用户看到的「好线路全被标红、最后什么都播不了」。
 * 所以判死之前，允许往下退一两片再试。
 */
function segmentCandidates(text, baseUrl, limit = 3) {
  const segs = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    segs.push(s);
  }
  const out = [];
  for (let i = segs.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try { out.push(new URL(segs[i], baseUrl).href); } catch (err) { /* 跳过坏行 */ }
  }
  return out;
}

/**
 * HLS 可用性预检：列表拿得到 ≠ 能播。
 *
 * 判死条件（任一成立即返回 dead）：
 *   1. 主列表的变体取不到（变体 404 / 连不上）；
 *   2. 媒体列表解析不出任何分片；
 *   3. 最新分片取不到（源站只发列表不发分片 —— 实测那批僵尸线路就是这样）。
 *
 * 为什么用「最新分片」而不是第一个：直播滑动窗口里第一条是最旧的、通常已被删除，
 * 拿它判活会把正常线路误判成死线。
 */
async function preflightHlsOnce({ headBytes, headers, finalUrl, ctx }) {
  const withTimeout = (p, ms, msg) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
  const LIMIT = 6 * 1024 * 1024;

  const seed = new PassThrough();
  if (headBytes && headBytes.length) seed.write(headBytes);
  seed.end();
  let text = stream.decodeBody(
    await withTimeout(stream.readAll(seed, LIMIT), 8000, '列表读取超时'),
    headers && headers['content-encoding']
  ).toString('utf8');
  let base = finalUrl;

  if (/EXT-X-STREAM-INF/.test(text)) {
    const variant = firstVariant(text, base);
    if (!variant) return { dead: true, reason: '主列表里没有变体' };
    let vres;
    try {
      vres = await withTimeout(stream.openUpstream(variant, ctx), 8000, '变体连接超时');
    } catch (err) {
      const m = String(err && err.message || '');
      if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(m)) {
        return { dead: true, reason: '变体连不上：' + m };
      }
      return { dead: false, note: '变体探测不确定（' + m + '）' };
    }
    const vs = vres.res.statusCode || 200;
    if (vs >= 400) {
      vres.res.resume();
      return { dead: true, reason: '变体 HTTP ' + vs };
    }
    text = stream.decodeBody(
      await withTimeout(stream.readAll(vres.res, LIMIT, null), 8000, '变体读取超时'),
      vres.res.headers['content-encoding']
    ).toString('utf8');
    base = vres.finalUrl || variant;
  }

  const candidates = segmentCandidates(text, base, 3);
  if (!candidates.length) return { dead: true, reason: '列表里没有分片' };

  /*
   * 从最新那片往下退着试（最多 3 片）。
   * 最新一片 404/403 不等于这条线路死 —— 可能只是它还没准备好，
   * 或者中转源还没把上游那一片同步过来（见 segmentCandidates 注释）。
   */
  let lastReason = '';
  let lastSeg = candidates[0];
  for (const segUrl of candidates) {
    lastSeg = segUrl;
    try {
      const sres = await withTimeout(stream.openUpstream(segUrl, ctx), 8000, '分片连接超时');
      const ss = sres.res.statusCode || 200;
      sres.res.resume();
      /*
       * 403 / 429 是「拒绝访问 / 被限流」，**不等于这一片不存在** ——
       * 实测（2026-10-10 22:14）线路四那条 192.168.1.10:19105 中转源：
       * 预检报 403，而同一时刻用普通 GET、带 Range 的 GET、甚至 6 个并发请求
       * 直接打它最新那片，全是 206/200。也就是说这个 403 是**一时一地**的，
       * 而按死线处理会把一条完全能播的线路标红（面板上那句「源不可用：分片 HTTP 403」）。
       * 所以：403/429 按「不确定」放行，让播放去决定；404/410 才是真没了。
       */
      if (ss === 403 || ss === 429) {
        return { dead: false, segUrl, segStatus: ss, note: '分片被拒（HTTP ' + ss + '），按不确定处理' };
      }
      if (ss >= 400) { lastReason = '分片 HTTP ' + ss; continue; }
      return { dead: false, segUrl, segStatus: ss, tried: candidates.indexOf(segUrl) + 1 };
    } catch (err) {
      const m = String(err && err.message || '');
      if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|HTTP 4\d\d|HTTP 5\d\d/i.test(m)) {
        lastReason = '分片连不上：' + m;
        continue;
      }
      // 超时/未知网络错误：按「不确定」处理，不判死线
      return { dead: false, segUrl, note: '分片探测不确定（' + m + '），不判死线' };
    }
  }
  return { dead: true, reason: lastReason || '分片不可用', segUrl: lastSeg };
}

/**
 * 判死之前**再采一次样**。
 *
 * 起因（2026-10-10 用户截图）：CCTV5 的线路三被判「源不可用：列表里没有分片」，
 * 而几秒后我用同一个预检接口重跑，10 条线路全部是活的。
 * 直播源的播放列表在换窗口 / 上游重推的那一瞬间确实可能是空的，
 * 单次采样判死就会把好线路标成红的 —— 而且面板会显示「已失败」、这条线
 * 在这一轮里再也不会被尝试。PotPlayer / ok影视 不会被这种一瞬抖动骗到，
 * 我们也不该。
 *
 * 只有「可能只是一时抖动」的原因才复测：空列表、4xx/5xx、明确拒连。
 * 复测仍判死才真判死；复测通过就按活线返回，并留下 note 便于排查。
 */
const PREFLIGHT_RETRYABLE = /列表里没有分片|主列表里没有变体|HTTP 4\d\d|HTTP 5\d\d|连不上/;

async function preflightHls(opts) {
  const first = await preflightHlsOnce(opts);
  if (!first || !first.dead || !PREFLIGHT_RETRYABLE.test(String(first.reason || ''))) return first;
  await new Promise((r) => setTimeout(r, 700));
  try {
    const again = await preflightHlsOnce(opts);
    if (again && !again.dead) {
      return Object.assign({}, again, { note: `首测判死（${first.reason}），复测通过` });
    }
    return again || first;
  } catch (err) {
    // 复测本身出错：按「不确定」处理，不判死线（和 1.6.5 的取向一致）
    return { dead: false, note: `复测出错（${err.message}），不判死线` };
  }
}

/**
 * 把 fMP4 init 片段里 avcC 的 profile_compatibility 低位清零。
 *
 * 起因（2026-10-10 深夜，实测三次）：CCTV1 / CCTV13 线路一这类源，H.264 的 SPS 里
 * `reserved_zero_2bits = 1`（H.264 规定这两位必须为 0，编码器写错了）。
 * ffmpeg 用 `-c:v copy` 时会把 SPS 原样抄进 avcC，于是浏览器拿到的编码串是
 * `avc1.640128`；而 Chromium 的 MSE 解析器**校验这两位**，直接拒收：
 *
 *   Failed to execute 'addSourceBuffer': The type provided
 *   ('video/mp4;codecs=mp4a.40.2,avc1.640128') is unsupported
 *
 * 同一个串把第二位换成 00（`avc1.640028`）就 true —— 差别只在这 2 个保留位。
 * ffmpeg 自己的 h264_metadata 位流过滤器也因为这个非法值报
 * 「reserved_zero_2bits out of range: 1, but must be in [0,0]」而无法工作。
 *
 * 所以最省事、也最正确的做法是：**服务端吐 init 片段时把这两位清掉**。
 * 它不改变任何视频数据（这两位是保留位），只是把编码器的错修正回规范值；
 * 实测清掉之后，`-c:v copy` 的产物（不转码！）在浏览器里 errs=[] 正常播放。
 *
 * avcC 布局：['avcC'][version(1)][profile(1)][profile_compatibility(1)][level(1)]…
 * 所以从 'avcC' 起 +6 就是 profile_compatibility。
 */
function sanitizeInitSegment(buf) {
  const idx = buf.indexOf('avcC');
  if (idx < 0 || idx + 7 >= buf.length) return buf;
  const compat = idx + 6;
  if ((buf[compat] & 0x03) === 0) return buf;   // 保留位本来就是 0，不用动
  const out = Buffer.from(buf);
  out[compat] = out[compat] & 0xFC;
  return out;
}

class LocalServer {
  constructor(options) {
    this.rendererDir = options.rendererDir;
    this.dataDir = options.dataDir;
    this.port = options.port;
    this.server = null;
    this.origin = '';
    this.configPath = path.join(this.dataDir, 'config.json');
    this.cache = { url: '', kind: '', base: '', hub: null, channels: [], enriched: false, at: 0, index: null };
    this.normChannels = [];
    this.indexCache = new Map(); // base -> { items, at }
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) sendError(res, 500, err && err.message ? err.message : String(err));
        else res.destroy();
      });
    });
    this.server.keepAliveTimeout = 65000;
    this.server.headersTimeout = 70000;
    // 直播流是长连接，不能让它被默认超时掐断
    this.server.requestTimeout = 0;
    this.server.timeout = 0;

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    this.port = address.port;
    this.origin = `http://127.0.0.1:${this.port}`;
    return this.origin;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    // 关程序时把还在转码的 ffmpeg 一起收掉。
    // Windows 上 Node 的子进程不会随父进程退出，不收就会变成孤儿进程继续吃 CPU。
    try {
      await local.closeAll();
    } catch (err) {
      /* 退出阶段忽略 */
    }
  }

  // ---------------------------------------------------------------- 配置

  async loadConfig() {
    try {
      const text = await fsp.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(text);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      return { ...DEFAULT_CONFIG };
    }
  }

  async saveConfig(config) {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  // ---------------------------------------------------------------- 路由

  async handle(req, res) {
    const url = new URL(req.url, this.origin || `http://127.0.0.1:${this.port}`);
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end();
      return;
    }

    if (pathname === '/p') return this.handleProxy(req, res, url);
    if (pathname === '/api/import') return this.handleImport(req, res);
    if (pathname === '/api/enrich') return this.handleEnrich(req, res);
    if (pathname === '/api/lines') return this.handleLines(req, res, url);
    if (pathname === '/api/sniff') return this.handleSniff(req, res, url);
    if (pathname === '/api/codec') return this.handleCodec(req, res, url);
    if (pathname.startsWith('/api/local/hls/')) return this.handleLocalHls(req, res, pathname);
    if (pathname.startsWith('/api/local/raw/')) return this.handleLocalRaw(req, res, pathname);
    if (pathname === '/api/local/open') return this.handleLocalOpen(req, res);
    if (pathname === '/api/local/tools') return this.handleLocalTools(req, res);
    if (pathname === '/api/linespeed') return this.handleLineSpeed(req, res);
    if (pathname === '/api/remux') return this.handleRemux(req, res);
    // 预取缓存快照：诊断「分片是不是已经提前躺在本地了」
    if (pathname === '/api/prefetch') {
      return sendJSON(res, 200, Object.assign({ ok: true }, prefetch.snapshot()));
    }
    if (pathname === '/api/remux/status') return this.handleRemuxStatus(req, res, url);
    if (pathname === '/api/config') return this.handleConfig(req, res);
    if (pathname === '/api/favorite') return this.handleFavorite(req, res);
    if (pathname === '/api/hub') return this.handleHubProxy(req, res);
    if (pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, origin: this.origin, cached: this.cache.channels.length });
    }
    return this.handleStatic(req, res, pathname);
  }

  async handleStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    rel = decodeURIComponent(rel);
    const target = path.normalize(path.join(this.rendererDir, rel));
    if (!target.startsWith(this.rendererDir)) return sendError(res, 403, '禁止访问');
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      return sendError(res, 404, '文件不存在');
    }
    if (!stat.isFile()) return sendError(res, 404, '文件不存在');
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  }

  // ---------------------------------------------------------------- 流代理

  async handleProxy(req, res, url) {
    const target = url.searchParams.get('u');
    if (!target) return sendError(res, 400, '缺少 u 参数');

    /*
     * 分片：内存里有就直接给，不碰网络。
     * 这是整条链路能「跑在直播前面」的关键 —— ffmpeg 读的是本地内存，
     * 不再受上游 4.3 秒发布节奏的约束。
     */
    if (prefetch.isSegment(target)) {
      const hit = prefetch.get(target);
      if (hit) {
        res.writeHead(200, {
          'Content-Type': hit.type || 'video/mp2t',
          'Content-Length': hit.buf.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(hit.buf);
        return;
      }
      // 没命中：如果这条流已经在预取，请求一发起就顺带把它拉进缓存，下次就快了
    }

    const ctx = {
      ref: url.searchParams.get('r') || '',
      ua: url.searchParams.get('ua') || '',
      range: req.headers.range || '',
    };

    let upstream;
    try {
      upstream = await stream.openUpstream(target, ctx);
    } catch (err) {
      return sendError(res, 502, `上游连接失败: ${err.message}`);
    }

    const { res: up, finalUrl } = upstream;
    const status = up.statusCode || 200;
    if (status >= 400) {
      up.resume();
      return sendError(res, status, `上游返回 HTTP ${status}`);
    }

    const contentType = String(up.headers['content-type'] || '');
    const pathname = safePathname(finalUrl);
    const typeSaysPlaylist = /mpegurl/i.test(contentType) || /\.m3u8?$/i.test(pathname);
    const typeSaysBinary =
      /^(video|audio)\//i.test(contentType) || /mp2t/i.test(contentType) || /\.(ts|mp4|flv|m4s|aac)$/i.test(pathname);

    let isPlaylist = typeSaysPlaylist;
    let firstChunk = null;
    if (!isPlaylist && !typeSaysBinary) {
      firstChunk = await stream.peekFirstChunk(up);
      if (firstChunk) isPlaylist = stream.looksLikePlaylist(firstChunk);
    }

    if (isPlaylist) {
      const raw = await stream.readAll(up, stream.PLAYLIST_MAX_BYTES, firstChunk);
      const decoded = stream.decodeBody(raw, up.headers['content-encoding']);
      /*
       * 一看到上游播放列表，就**开始预取它列出的所有分片**（后台下载进内存）。
       * 这样等 ffmpeg 真去读那些分片时，它们已经在本地了 —— 它就能以
       * 「通道能力」的速度跑，而不是被上游 4.3 秒的发布节奏牵着走。
       * watch() 幂等：同一条列表重复调用不会重复起线程。
       */
      try {
        prefetch.watch(finalUrl, ctx, {
          fetchPlaylist: async (u, c) => segmentUrls((await fetchBinary(u, c, 4 * 1024 * 1024)).buf.toString('utf8'), u),
          fetchSegment: (u, c) => fetchBinary(u, c),
        });
      } catch (err) { /* 预取失败不影响正常代理 */ }
      const rewritten = stream.rewritePlaylist(decoded.toString('utf8'), finalUrl, this.origin, ctx);
      const body = Buffer.from(rewritten, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Content-Length': body.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    const headers = {
      'Content-Type': contentType || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': '*',
      'Cache-Control': 'no-store',
    };
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'content-encoding']) {
      if (up.headers[name] !== undefined) headers[name] = up.headers[name];
    }
    res.writeHead(status, headers);
    res.on('close', () => up.destroy());
    stream.pipeThrough(up, res, firstChunk);
  }

  // ---------------------------------------------------------------- 导入

  /**
   * 过滤掉指向本机服务自己的线路。
   *
   * 有些源的播放列表里会塞占位条目（实测 iptvs-app 的第 1 条就是
   * `http://127.0.0.1/` 配一个「更新时间」的名字）。那个地址正好命中
   * 我们自己的本地服务，返回的是一张 HTML 页面，hls.js 解析它会抛出
   * `Cannot read properties of null (reading 'currentURL')` 这种内部异常。
   */
  isSelfReference(url) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      // 整个 127.0.0.0/8 回环段 + localhost + ::1
      if (host === 'localhost' || host === '::1') return true;
      if (/^127\./.test(host)) return true;
      return false;
    } catch (err) {
      return false;
    }
  }

  /**
   * 剔除回环地址线路。
   *
   * ⚠️ 必须在**写进 cache 之前**做，不能在 normalizeChannels 里做：
   * 频道 id 就是数组下标，如果只过滤给前端看的那份、cache 里还是原始的，
   * 下标就会错位 —— 点「CCTV1」拿到的会是被过滤掉的那条。
   */
  stripLoopbackLines(rawChannels) {
    return rawChannels
      .map((c) => ({ ...c, lines: (c.lines || []).filter((l) => !this.isSelfReference(l.url)) }))
      .filter((c) => c.lines.length);
  }

  normalizeChannels(rawChannels, favorites) {
    const favSet = new Set(favorites || []);
    return rawChannels.map((channel, index) => {
      const playableLines = channel.lines.filter((l) => playlist.isPlayable(l.url));
      const kinds = Array.from(new Set(channel.lines.map((l) => l.kind)));
      return {
        id: index,
        favKey: channel.favKey,
        name: channel.name,
        group: channel.group,
        logo: channel.logo || '',
        key: channel.key || '',
        region: channel.region || '',
        speed: channel.speed ?? null,
        streamCount: channel.streamCount || channel.lines.length,
        sources: channel.sources || '',
        lineCount: channel.lines.length,
        playableCount: playableLines.length,
        kind: playableLines.length ? playableLines[0].kind : kinds[0] || 'unknown',
        favorite: favSet.has(channel.favKey),
      };
    });
  }

  buildSummary(extra = {}) {
    const channels = this.normChannels;
    const groups = new Map();
    let playable = 0;
    for (const channel of channels) {
      groups.set(channel.group, (groups.get(channel.group) || 0) + 1);
      if (channel.playableCount > 0) playable += 1;
    }
    return {
      ok: true,
      kind: this.cache.kind,
      url: this.cache.url,
      base: this.cache.base,
      enriched: this.cache.enriched,
      hub: this.cache.hub,
      total: channels.length,
      playable,
      groups: Array.from(groups.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      channels,
      ...extra,
    };
  }

  async handleImport(req, res) {
    if (req.method !== 'POST') return sendError(res, 405, '仅支持 POST');
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (err) {
      return sendError(res, 400, `请求解析失败: ${err.message}`);
    }
    const input = String(payload.url || '').trim();
    if (!input) return sendError(res, 400, '请填写源地址');

    const config = await this.loadConfig();
    const started = Date.now();

    try {
      await this.doImport(input, config);
    } catch (err) {
      // 上游抖动（iptv-hub 的 SQLite 临时空间只有 64MB，会间歇性 500）
      // 必须回一个能看懂的错，而不是裸 500
      return sendError(res, 502, `源读取失败：${err.message}。iptv-hub 可能正忙或数据库临时空间不足，稍后重试。`);
    }

    sendJSON(res, 200, {
      ...this.buildSummary(),
      elapsedMs: Date.now() - started,
      canEnrich: this.cache.kind === 'hub',
    });
  }

  async doImport(input, config) {
    const base = hub.normalizeBase(input);
    const hubBase = base ? await hub.detectHub(input) : null;

    let rawChannels = [];
    let hubInfo = null;
    let kind = 'playlist';

    const inputUrl = (() => {
      try {
        return new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`);
      } catch (err) {
        return null;
      }
    })();
    const isExportPath = !!inputUrl && /\/(iptv|playlist\.m3u|txt)\/?$/i.test(inputUrl.pathname);

    if (hubBase) {
      kind = 'hub';
      const meta = await hub.loadHubMeta(hubBase);
      // 用户直接贴了订阅地址就尊重它（可能带 mode/region 参数），否则用默认多线路导出
      const loaded = isExportPath
        ? await hub.loadExternalPlaylist(input)
        : await hub.loadHubPlaylist(hubBase);
      rawChannels = loaded.channels;
      hubInfo = {
        base: hubBase,
        exportUrl: isExportPath ? input : `${hubBase}/iptv?mode=multi`,
        meta: meta.meta,
        stats: meta.stats,
        groups: meta.groups,
        sources: (meta.sources || []).map((s) => ({
          slug: s.slug,
          name: s.name,
          priority: s.priority,
          entries: s.entries ?? s.entry_count ?? null,
          last_status: s.last_status ?? s.status ?? null,
          last_error: s.last_error ?? null,
        })),
      };
    } else {
      const result = await hub.loadExternalPlaylist(input);
      rawChannels = result.channels;
      hubInfo = { base, exportUrl: input, meta: null, stats: null, groups: [], sources: [] };
    }

    rawChannels = this.stripLoopbackLines(rawChannels);

    this.cache = {
      url: input,
      kind,
      base: hubBase || base || '',
      hub: hubInfo,
      channels: rawChannels,
      enriched: false,
      at: Date.now(),
      index: null,
    };

    const channels = this.normalizeChannels(rawChannels, config.favorites);
    this.normChannels = channels;
    // 配置写失败不能连累导入结果（沙箱 / 只读目录下都可能失败）
    try {
      await this.saveConfig({ ...config, sourceUrl: input });
    } catch (err) {
      /* 忽略：下次启动最多丢一个「上次的源」 */
    }
  }

  async handleEnrich(req, res) {
    if (req.method !== 'POST') return sendError(res, 405, '仅支持 POST');
    if (!this.cache.channels.length) return sendError(res, 409, '请先导入源');
    if (this.cache.kind !== 'hub' || !this.cache.base) {
      return sendJSON(res, 200, { ...this.buildSummary(), canEnrich: false, enrichNote: '当前源不是 iptv-hub，无需补全' });
    }

    const started = Date.now();
    let matched = 0;
    let indexed = 0;
    try {
      let index = this.indexCache.get(this.cache.base);
      if (!index || Date.now() - index.at > 10 * 60 * 1000) {
        const loaded = await hub.loadHubChannelIndex(this.cache.base);
        index = { items: loaded.items, total: loaded.total, at: Date.now(), failed: loaded.failed };
        this.indexCache.set(this.cache.base, index);
      }
      const merged = hub.mergeHubIndex(this.cache.channels, index.items);
      matched = merged.matched;
      indexed = merged.indexed;
      this.cache.enriched = true;
    } catch (err) {
      return sendError(res, 502, `元信息补全失败：${err.message}`);
    }

    const config = await this.loadConfig();
    const channels = this.normalizeChannels(this.cache.channels, config.favorites);
    this.normChannels = channels;

    const cached = this.indexCache.get(this.cache.base) || {};
    sendJSON(res, 200, {
      ...this.buildSummary(),
      canEnrich: false,
      enrich: {
        matched,
        indexed,
        failedPages: cached.failed || 0,
        elapsedMs: Date.now() - started,
      },
    });
  }

  /**
   * 探测一个地址的真实容器类型。
   *
   * 给地址里看不出扩展名的那批线路用（源里 645 条，实测其中约三分之一其实是 FLV）。
   * 只读开头一小段就断开，不会把整条流拉下来。
   */
  async handleSniff(req, res, url) {
    const target = url.searchParams.get('u');
    if (!target) return sendError(res, 400, '缺少 u 参数');
    const wantPreflight = url.searchParams.get('preflight') === '1';
    const ctx = {
      ref: url.searchParams.get('r') || '',
      ua: url.searchParams.get('ua') || '',
    };

    let upstream;
    try {
      upstream = await stream.openUpstream(target, ctx);
    } catch (err) {
      return sendJSON(res, 200, { ok: true, kind: 'dead', reason: err.message });
    }
    const { res: up, finalUrl } = upstream;
    const status = up.statusCode || 200;
    if (status >= 400) {
      up.resume();
      return sendJSON(res, 200, { ok: true, kind: 'dead', reason: `上游 HTTP ${status}` });
    }

    const first = await stream.peekFirstChunk(up, 8000);
    const kind = stream.detectContainer(first, up.headers['content-type'], safePathname(finalUrl));
    const contentType = up.headers['content-type'] || '';

    /*
     * 可用性预检（preflight=1）：只探容器不够，还得看**真正要播的那个分片在不在**。
     *
     * 实测（2026-10）在某些聚合源里存在一大批「僵尸 HLS 线路」：
     * 主列表能拿到、内容也是合法的 m3u8，但分片请求被源站用自己的 404 页挡回来 ——
     * 「404，您请求的文件不存在!」，换 UA、换分片序号都一样。这类线路没有任何播放器能播。
     * 不预检的代价是：每条僵尸线路都要等引擎判定失败、下一级引擎再失败，最后报一个
     * 和真实原因无关的错（用户看到的就是「FLV 解码失败」），一条要浪费十几秒。
     */
    let dead = null;
    let preflightDetail = null;
    if (wantPreflight && (kind === 'hls' || kind === 'unknown')) {
      try {
        const chk = await preflightHls({
          headBytes: first,
          headers: up.headers,
          finalUrl,
          ctx,
        });
        if (chk && chk.dead) dead = chk.reason;
        if (chk) preflightDetail = chk;
      } catch (err) { /* 预检本身出错不当成死线 */ }
    }
    up.destroy();
    if (dead) {
      return sendJSON(res, 200, { ok: true, kind: 'dead', reason: dead, contentType, finalUrl, preflight: preflightDetail });
    }
    return sendJSON(res, 200, {
      ok: true,
      kind,
      contentType,
      finalUrl,
      preflight: preflightDetail,
    });
  }

  /**
   * ffmpeg 会话体检。
   *
   * 「点了频道只有转圈、没有画面」时，界面能给的信息太少。这个接口把
   * ffmpeg 有没有起来、有没有报错、产出了几个分片、stderr 最后几行都摊开，
   * 用于定位是「拉不到流」「编不出来」还是「客户端没播起来」。
   */
  async handleRemuxStatus(req, res, url) {
    const id = url.searchParams.get('id');
    if (!id) {
      // 不带 id 就列出全部会话，方便一眼看出是不是全挂了
      const all = [];
      for (const session of local.sessions.values()) all.push(await local.sessionStatus(session));
      return sendJSON(res, 200, { ok: true, sessions: all });
    }
    const session = local.sessions.get(id);
    if (!session) return sendError(res, 404, '会话不存在或已过期');
    return sendJSON(res, 200, { ok: true, session: await local.sessionStatus(session) });
  }

  /**
   * 探测一条网络线路的真实编码（给「这条线路 Chromium 到底能不能解」用）。
   *
   * 这是解决「PotPlayer / 手机能播、Electron 内置播放器播不了」的关键一步：
   * 那些源里大量线路是 MPEG-2 视频 + MP2 音频，Chromium 根本没有这两种解码器
   * （VLC / PotPlayer 自带，所以它们能播）。以前只能等 hls.js 撞二十秒再换引擎，
   * 现在点开频道就先问清楚编码，Chromium 解不了的直接交给内置 ffmpeg。
   *
   * ffprobe 是本地进程、只采样开头一小段（实测 0.46 秒），比让播放器试错快得多。
   * 结果按 URL 缓存在 local.js 里，紧接着的 /api/remux 会命中同一份缓存。
   */
  async handleCodec(req, res, url) {
    const target = url.searchParams.get('u');
    if (!target) return sendError(res, 400, '缺少 u 参数');
    if (!/^https?:\/\//i.test(target)) return sendError(res, 400, '地址不合法');
    const ref = url.searchParams.get('r') || '';
    const ua = url.searchParams.get('ua') || '';

    // 走和播放同一条输入参数（防盗链头 + 重连），否则探测结论可能和真正播放不一致
    const info = await local.probe(target, local.networkInputArgs(target, ref, ua));
    if (!info || !info.ok) {
      return sendJSON(res, 200, { ok: false, error: (info && info.error) || '探测失败' });
    }

    /*
     * 这里不用 decide()：那是给本地文件定档的（还要看扩展名和容器），
     * 网络 HLS 走的是 hls.js，只关心「编码认不认识」。所以直接按
     * 编码在白名单里与否给结论，语义才准确。
     */
    const v = info.video ? info.video.codec : null;
    const a = info.audio ? info.audio.codec : null;
    const videoOk = !v || local.BROWSER_VIDEO.has(v);
    const audioOk = !a || local.BROWSER_AUDIO.has(a);
    let tier;
    let reason;
    if (videoOk && audioOk) {
      tier = 'direct';
      reason = `编码 ${v || '-'} / ${a || '-'} 浏览器可直解`;
    } else if (videoOk) {
      tier = 'remux';
      reason = `视频 ${v} 可直通，音频 ${a} 需转成 AAC`;
    } else {
      tier = 'transcode';
      reason = `视频 ${v}${a ? ` / 音频 ${a}` : ''} Chromium 没有解码器（VLC/PotPlayer 自带），转成 H.264+AAC`;
    }

    sendJSON(res, 200, {
      ok: true,
      url: target,
      video: info.video,
      audio: info.audio,
      tier,
      reason,
    });
  }

  /**
   * 线路测速。
   *
   * 同一频道的多条线路速度差别可以到 4 倍（实测 CCTV1：3.0 ~ 12.1 MB/s），
   * 而播放器默认是按列表顺序挑，经常挑中最慢的那条 —— 缓冲反复见底、画面卡顿。
   * 这里让前端把候选线路发过来，服务端**走和播放同一条代理路径**实测吞吐，
   * 只读一小段就断开（默认 4 秒 / 最多 768KB），不整片下载。
   */
  async handleLineSpeed(req, res) {
    if (req.method !== 'POST') return sendError(res, 405, '仅支持 POST');
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (err) {
      return sendError(res, 400, '请求解析失败');
    }
    const lines = Array.isArray(payload.lines) ? payload.lines.slice(0, 20) : [];
    if (!lines.length) return sendError(res, 400, '没有线路');
    const budgetMs = Math.min(Math.max(Number(payload.budgetMs) || 4000, 500), 12000);
    // 采样 2MB 左右才比较能反映持续速度；太短容易测到突发峰值。
    // 「起播前挑最快线路」那次会传更小的值——它只要能排出名次，不需要精确值。
    const maxBytes = Math.min(Math.max(Number(payload.maxBytes) || 2 * 1024 * 1024, 64 * 1024), 8 * 1024 * 1024);
    /*
     * 并发默认 3：后台测速本身吃带宽，太猛会干扰正在播放的那条。
     *
     * 但「起播前」的测速没有正在播放的流要保护，可以把并发放开，
     * 否则 10 条线路并发 3 要跑 4 轮 ≈ 12 秒，用户根本等不起 ——
     * 而这一步恰恰是高清卡顿最有效的解法（同一频道线路速度能差 8 倍）。
     */
    const concurrency = Math.min(Math.max(Number(payload.concurrency) || 3, 1), 16);
    // 整条线路的量测硬上限（含连接、读列表、开分片）。起播前的选线会传小值。
    const deadlineMs = Number(payload.deadlineMs) || 0;

    const results = await pool(lines, concurrency, async (line) => {
      const t0 = Date.now();
      try {
        const m = await measureLine(line, budgetMs, maxBytes, deadlineMs);
        return { url: line.url, kbps: Math.round(m.kbps), bitrateBps: Math.round(m.bitrateBps || 0), ms: Date.now() - t0 };
      } catch (err) {
        return { url: line.url, kbps: 0, ms: Date.now() - t0, error: err.message };
      }
    });
    sendJSON(res, 200, { ok: true, results });
  }

  /**
   * ffmpeg 兜底播放。
   *
   * 浏览器的三个引擎（hls.js / mpegts.js / flv.js）都放不出来的流走这里：
   * HEVC、AC-3/MP2 音频、非标准 TS 封装……ffmpeg 直接按 URL 拉，
   * 输出 H.264+AAC 的 HLS，Chromium 就一定能播。
   *
   * 这正是 MPV/VLC 能放、而 Electron 内置播放器放不出来的那部分 ——
   * 干脆把 ffmpeg 当播放器用，不必像 IPTVnator 那样甩给外部程序。
   */
  async handleRemux(req, res) {
    /*
     * DELETE /api/remux?id=<会话 id>：关掉一个 ffmpeg 接管会话。
     *
     * 没有这个接口时，每次换线路 / 换台 / 重新接管都会**另起一个 ffmpeg**：
     * 旧的那个继续按 URL 拉流、继续编码，直到进程退出才消失。换几次台就会
     * 挂一排 ffmpeg 抢 CPU 和带宽（实测日志里同一频道出现过多次接管）。
     */
    if (req.method === 'DELETE') {
      const sid = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || '';
      if (!sid) return sendError(res, 400, '缺少 id');
      try {
        await local.closeSession(sid);
      } catch (err) { /* 会话可能已经自己结束了 */ }
      return sendJSON(res, 200, { ok: true, closed: sid });
    }
    if (req.method !== 'POST') return sendError(res, 405, '仅支持 POST / DELETE');
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (err) {
      return sendError(res, 400, '请求解析失败');
    }
    const url = String(payload.url || '');
    if (!/^https?:\/\//i.test(url)) return sendError(res, 400, '地址不合法');
    try {
      const session = await local.openStream({
        url,
        ref: String(payload.ref || ''),
        ua: String(payload.ua || ''),
        name: String(payload.name || ''),
        // 'transcode' = 连视频一起重编（源的 H.264 参数浏览器不认时用；见 local.js）
        videoMode: String(payload.video || ''),
        // 客户端能力（前端用 mediaCapabilities 探到的）：目前只用一样 —— HEVC 能不能直解
        caps: payload.caps && typeof payload.caps === 'object' ? payload.caps : null,
      });
      /*
       * ⚠️ **立刻**把 ffmpeg 拉起来，不要等别人来请求播放列表。
       *
       * 原来是懒启动（第一次请求 /api/local/hls/... 时才 startTranscode），
       * 一旦客户端那次请求超时中止，ffmpeg 就永远不会启动 —— 会话空转、
       * 目录里一个文件都没有、播放器永远在等。实测（2026-10-07 01:56）：
       * 6 秒后 /api/remux/status 仍是 started:false，会话目录全空。
       * 起播前要读播放列表，这个读请求本身就可能被中止，所以不能依赖它。
       * startTranscode() 是幂等的，这里调一次、后面请求再调也没关系。
       */
      try {
        local.startTranscode(session);
      } catch (err) {
        /* 启动失败会在会话体检里带上 error，交给客户端显示 */
      }
      sendJSON(res, 200, {
        ok: true,
        id: session.id,
        tier: session.tier,
        reason: session.reason,
        video: session.info.video,
        audio: session.info.audio,
      });
    } catch (err) {
      sendError(res, 502, `ffmpeg 接管失败：${err.message}`);
    }
  }

  // ------------------------------------------------------------ 本地视频

  /** ffmpeg / ffprobe 是否就位。 */
  async handleLocalTools(req, res) {
    const os = require('os');
    const fsmod = require('fs');
    const probeOne = (bin) => {
      const { execFile } = require('child_process');
      return new Promise((resolve) => {
        execFile(bin, ['-version'], { timeout: 8000 }, (err, stdout) => {
          resolve(err ? null : String(stdout).split('\n')[0]);
        });
      });
    };
    sendJSON(res, 200, {
      ok: true,
      ffmpeg: local.FFMPEG,
      ffprobe: local.FFPROBE,
      ffmpegVersion: await probeOne(local.FFMPEG),
      ffprobeVersion: await probeOne(local.FFPROBE),
      platform: process.platform,
    });
  }

  /** 打开本地视频文件，返回会话信息（含判定档位）。 */
  async handleLocalOpen(req, res) {
    if (req.method !== 'POST') return sendError(res, 405, '仅支持 POST');
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (err) {
      return sendError(res, 400, '请求解析失败');
    }
    const paths = Array.isArray(payload.paths) ? payload.paths.filter(Boolean) : [];
    if (!paths.length) return sendError(res, 400, '没有选择文件');

    const opened = [];
    const failed = [];
    for (const file of paths) {
      try {
        const s = await local.openFile(String(file), payload.caps && typeof payload.caps === 'object' ? payload.caps : null);
        opened.push({
          id: s.id,
          name: s.name,
          path: s.file,
          tier: s.tier,
          reason: s.reason,
          duration: s.info.duration,
          size: s.info.size,
          video: s.info.video,
          audio: s.info.audio,
          direct: s.tier === 'direct',
        });
      } catch (err) {
        failed.push({ path: file, error: err.message });
      }
    }
    sendJSON(res, 200, { ok: true, opened, failed });
  }

  /** 直出模式：带 Range 的静态文件服务（拖动进度条靠它）。 */
  async handleLocalRaw(req, res, pathname) {
    const sid = pathname.slice('/api/local/raw/'.length).split('/')[0];
    const session = local.sessions.get(sid);
    if (!session) return sendError(res, 404, '会话不存在或已过期');
    session.touchedAt = Date.now();

    let stat;
    try {
      stat = await fsp.stat(session.file);
    } catch (err) {
      return sendError(res, 404, '文件已不可访问');
    }
    const total = stat.size;
    const type = MIME[path.extname(session.file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (!range) {
      // 客户端已断开就别开读流：读流没人消费就不会走到 'end'，fd 会一直挂着
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, {
        'Content-Type': type, 'Content-Length': total,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(session.file);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(session.file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /** 重封装/转码模式：按需启动 ffmpeg，再吐 HLS 播放列表与分片。 */
  async handleLocalHls(req, res, pathname) {
    const rest = pathname.slice('/api/local/hls/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return sendError(res, 404, '路径不对');
    const sid = rest.slice(0, slash);
    const name = path.basename(rest.slice(slash + 1));

    const session = local.sessions.get(sid);
    if (!session) return sendError(res, 404, '会话不存在或已过期');
    session.touchedAt = Date.now();
    if (session.tier === 'direct') return sendError(res, 400, '该文件走直出模式');

    local.startTranscode(session);

    const target = path.join(session.dir, name);
    if (!target.startsWith(session.dir)) return sendError(res, 403, '禁止访问');

    // 播放列表要等 ffmpeg 写出来；分片则等文件落盘（hls.js 本来也会重试）
    const deadline = Date.now() + (name === 'index.m3u8' ? 25000 : 15000);
    for (;;) {
      try {
        const stat = await fsp.stat(target);
        if (stat.size > 0) {
          /*
           * ⚠️ 走到这里时，发起请求的客户端**可能早就断了**。
           *
           * 上面这个循环最长等 25 秒，而播放器读列表用的是「fetch + 2~3 秒
           * AbortController 超时」（见 renderer/app.js 的 readPlaylist）——
           * 文件写出来的那一刻，那几个请求往往已经被自己中止了。
           *
           * 实测（2026-10-10 21:16 / 21:18 两轮）：对已经断开的响应写字，读流
           * 既没有消费者、也永远走不到 'end'，fd 就再也关不掉。而 ffmpeg 每写一次
           * 播放列表都是「写 index.m3u8.tmp → 改名成 index.m3u8」，Windows 只要
           * 目标文件被任何句柄占住就改名失败（libuv 的读句柄不带 FILE_SHARE_DELETE，
           * 已用 MoveFileEx 单独验证）。ffmpeg 对此只留一句 warning，
           * 而这里 ffmpeg 是 -loglevel error，于是：
           *   「列表永远停在第一个分片，分片其实一直在产出」
           * ——界面上就是「正在起播（已就绪 0 / 20 秒）」无休止地转圈。
           *
           * 三条对策：
           *   ① 客户端走了就直接 return，绝不碰文件；
           *   ② 播放列表整份读进内存再回包，读句柄的生命周期与客户端彻底解耦；
           *   ③ 分片仍然流式发，但 res 一关就把读流销毁掉（句柄必然归还）。
           */
          if (res.destroyed || res.writableEnded) return;
          const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
            : name.endsWith('.ts') ? 'video/mp2t'
            // fMP4 分片（.m4s / init.mp4）：必须给 video/mp4，否则 hls.js 拿到的
            // Content-Type 是 octet-stream，某些路径下会影响 MSE 建源缓冲
            : (name.endsWith('.m4s') || name.endsWith('.mp4')) ? 'video/mp4'
            : 'application/octet-stream';
          /*
           * init 片段要过一道「保留位清零」——见 sanitizeInitSegment 的注释。
           * 这个文件只有一两 KB，整份读进来改完再发最稳（也顺带不占着文件句柄）。
           */
          if (name === 'init.mp4') {
            const buf = sanitizeInitSegment(await fsp.readFile(target));
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(200, {
              'Content-Type': 'video/mp4',
              'Content-Length': buf.length,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store',
            });
            res.end(buf);
            return;
          }
          if (name.endsWith('.m3u8')) {
            const buf = await fsp.readFile(target);
            // 读的这几毫秒里客户端也可能断，回包前再确认一次
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(200, {
              'Content-Type': type,
              'Content-Length': buf.length,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store',
            });
            res.end(buf);
            return;
          }
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          });
          const stream = fs.createReadStream(target);
          res.on('close', () => stream.destroy());
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
      } catch (err) {
        /* 还没写出来 */
      }
      if (session.error) return sendError(res, 500, session.error);
      if (Date.now() > deadline) {
        return sendError(res, 504, session.finished ? '转码已结束但没产出内容' : '等待转码产出超时');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** 频道线路；hub 频道会在首次点开时补一次详情，拿到防盗链与全量线路。 */
  async handleLines(req, res, url) {
    const id = Number(url.searchParams.get('id'));
    const channel = this.cache.channels[id];
    if (!channel) return sendError(res, 404, '频道不存在');

    const skipDetail = url.searchParams.get('detail') === '0';
    let detailNote = '';
    if (!skipDetail && channel.key && !channel.detailLoaded && this.cache.base) {
      try {
        const detail = await hub.loadChannelDetail(this.cache.base, channel.key);
        const streams = Array.isArray(detail.streams) ? detail.streams : [];
        const known = new Map(channel.lines.map((l) => [l.url, l]));
        const merged = [];
        for (const s of streams) {
          if (!s || !s.url) continue;
          const existing = known.get(s.url);
          if (existing) {
            existing.ref = s.referrer || existing.ref;
            existing.ua = s.user_agent || existing.ua;
            existing.speed = typeof s.speed_kbps === 'number' ? s.speed_kbps : existing.speed;
            existing.source = s.source_name || existing.source;
            existing.health = s.health_status || '';
            merged.push(existing);
          } else {
            merged.push({
              url: s.url,
              ref: s.referrer || '',
              ua: s.user_agent || '',
              kind: playlist.streamKind(s.url),
              speed: typeof s.speed_kbps === 'number' ? s.speed_kbps : null,
              source: s.source_name || '',
              health: s.health_status || '',
              recommended: false,
            });
          }
        }
        // 详情接口已按可用性 + 速度排好序，这里只补上 M3U 里独有的线路
        for (const line of channel.lines) {
          if (!merged.some((m) => m.url === line.url)) merged.push(line);
        }
        if (merged.length) {
          channel.lines = merged;
          channel.detailLoaded = true;
          channel.lineCount = merged.length;
        }
      } catch (err) {
        detailNote = `频道详情获取失败: ${err.message}`;
      }
    }

    return sendJSON(res, 200, {
      ok: true,
      id,
      name: channel.name,
      favKey: channel.favKey,
      key: channel.key || '',
      note: detailNote,
      lines: channel.lines.map((line) => ({
        url: line.url,
        ref: line.ref || '',
        ua: line.ua || '',
        kind: line.kind,
        playable: playlist.isPlayable(line.url),
        speed: line.speed ?? null,
        source: line.source || '',
        recommended: !!line.recommended,
      })),
    });
  }

  async handleConfig(req, res) {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, config: await this.loadConfig() });
    }
    if (req.method === 'POST') {
      let payload;
      try {
        payload = await readJSONBody(req);
      } catch (err) {
        return sendError(res, 400, '请求解析失败');
      }
      const current = await this.loadConfig();
      const next = { ...current, ...(payload.config || payload) };
      await this.saveConfig(next);
      return sendJSON(res, 200, { ok: true, config: next });
    }
    return sendError(res, 405, '仅支持 GET / POST');
  }

  async handleFavorite(req, res) {
    if (req.method !== 'POST') return sendError(res, 405, '仅支持 POST');
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (err) {
      return sendError(res, 400, '请求解析失败');
    }
    const favKey = String(payload.favKey || '');
    if (!favKey) return sendError(res, 400, '缺少 favKey');
    const config = await this.loadConfig();
    const set = new Set(config.favorites || []);
    const want = payload.favorite === undefined ? !set.has(favKey) : !!payload.favorite;
    if (want) set.add(favKey);
    else set.delete(favKey);
    const favorites = Array.from(set);
    await this.saveConfig({ ...config, favorites });

    // 顺带同步到 iptv-hub（失败不影响本地收藏）
    let hubSynced = false;
    if (this.cache.kind === 'hub' && this.cache.base && payload.key) {
      try {
        await hub.hubRequest(this.cache.base, want ? 'PUT' : 'DELETE', `/api/favorites/${encodeURIComponent(payload.key)}`);
        hubSynced = true;
      } catch (err) {
        hubSynced = false;
      }
    }
    return sendJSON(res, 200, { ok: true, favorite: want, favorites, hubSynced });
  }

  async handleHubProxy(req, res) {
    if (req.method !== 'POST') return sendError(res, 405, '仅支持 POST');
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (err) {
      return sendError(res, 400, '请求解析失败');
    }
    const base = this.cache.base;
    if (!base) return sendError(res, 409, '请先导入 iptv-hub 源');
    const method = String(payload.method || 'GET').toUpperCase();
    const apiPath = String(payload.path || '');
    if (!apiPath.startsWith('/api/')) return sendError(res, 400, '仅允许 /api/ 路径');
    try {
      const result = await hub.hubRequest(base, method, apiPath, payload.body);
      return sendJSON(res, 200, { ok: true, status: result.status, data: result.data });
    } catch (err) {
      return sendError(res, 502, `hub 调用失败: ${err.message}`);
    }
  }
}

module.exports = { LocalServer };
