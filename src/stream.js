'use strict';

/**
 * 上游抓取与 HLS 播放列表改写。
 *
 * 为什么需要它：
 *  1. 浏览器里 hls.js 通过 XHR 拉流，绝大多数 IPTV 源站不返回 CORS 头，直连必然被拦。
 *  2. 分片地址多为相对路径，且带防盗链 Referer / User-Agent，必须在服务端补上。
 *  所以这里把上游流「本地反代 + 重写」，播放器只跟 127.0.0.1 打交道。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_REDIRECTS = 6;
/**
 * WHATWG URL 对 IPv6 字面量的 hostname 是**带方括号**的（"[2408:...]"），
 * 直接丢给 http.request 会被当成域名去做 DNS，报 getaddrinfo ENOTFOUND。
 * 部分直播 CDN（实测虎牙 al.flv.huya.com）重定向的 Location 就是
 * http://[IPv6]/原主机名/原路径 这种形式，不处理的话整条线路必挂。
 */
function hostOf(target) {
  const h = target.hostname || '';
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

const CONNECT_TIMEOUT_MS = 15000;
const PLAYLIST_MAX_BYTES = 8 * 1024 * 1024;

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });

function agentFor(protocol) {
  return protocol === 'https:' ? keepAliveHttps : keepAliveHttp;
}

function buildHeaders(target, ctx) {
  const headers = {
    'User-Agent': ctx.ua || DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
  };
  // 防盗链：显式指定优先；否则伪装成「直接打开该地址」，兼容性最好
  headers.Referer = ctx.ref || `${target.origin}/`;
  if (ctx.range) headers.Range = ctx.range;
  if (ctx.cookie) headers.Cookie = ctx.cookie;
  return headers;
}

/** 发起一次请求，自动跟随重定向。 */
function requestOnce(urlStr, ctx) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch (err) {
      reject(new Error(`地址不合法: ${urlStr}`));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error(`不支持的协议: ${target.protocol}`));
      return;
    }

    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: hostOf(target),
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: ctx.method || 'GET',
        headers: buildHeaders(target, ctx),
        agent: agentFor(target.protocol),
        rejectUnauthorized: false,
      },
      (res) => {
        req.setTimeout(0);
        resolve({ res, url: target });
      }
    );

    req.setTimeout(CONNECT_TIMEOUT_MS, () => {
      req.destroy(new Error('连接上游超时'));
    });
    req.on('error', reject);
    if (ctx.body) req.write(ctx.body);
    req.end();
  });
}

async function openUpstream(urlStr, ctx = {}) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { res, url } = await requestOnce(current, ctx);
    const code = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, url).href;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error('重定向次数过多');
}

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (err) {
    /* 解码失败就按原样返回 */
  }
  return buf;
}

/**
 * 把播放列表里的所有 URI（分片、子列表、AES key、init map）换成走本地代理。
 * 相对路径按 baseUrl 解析，防盗链参数继续往下一层传。
 */
function rewritePlaylist(text, baseUrl, proxyBase, ctx = {}) {
  const wrap = (raw) => {
    if (!raw) return raw;
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch (err) {
      return raw;
    }
    const q = new URLSearchParams();
    q.set('u', abs);
    if (ctx.ref) q.set('r', ctx.ref);
    if (ctx.ua) q.set('ua', ctx.ua);
    return `${proxyBase}/p?${q.toString()}`;
  };

  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      out.push(trimmed.replace(/URI="([^"]*)"/gi, (whole, uri) => (uri ? `URI="${wrap(uri)}"` : whole)));
    } else {
      out.push(wrap(trimmed));
    }
  }
  return out.join('\n');
}

/** 读走第一个数据块再塞回去，用来判断上游到底是播放列表还是裸流。 */
function peekFirstChunk(stream, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      resolve(buf && buf.length ? buf : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onReadable = () => finish(stream.read());
    const onEnd = () => finish(null);
    const onError = () => finish(null);
    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * 判断上游到底是什么容器。
 *
 * 必要性：源里大量地址是无扩展名的（/vip.../34904、/915512915、/huya/23865142），
 * 光看 URL 猜不出来。实测抽样 60 条这类地址：33% 其实是 FLV、18% 是 HLS、
 * 48% 是死链——也就是说有三分之一的线路被错当成 HLS 送进 hls.js，必然失败。
 * 这里读开头几个字节就能定性，比让播放器撞 20 秒超时再换引擎快得多。
 */
function detectContainer(buf, contentType, pathname) {
  const ct = String(contentType || '').toLowerCase();
  const path = String(pathname || '').toLowerCase();

  if (buf && buf.length >= 3) {
    const head = buf.subarray(0, 640);

    // FLV: 文件头就是 "FLV\x01"
    if (head.subarray(0, 3).toString('latin1') === 'FLV') return 'flv';

    // HLS: 播放列表以 #EXTM3U 开头
    const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^#EXTM3U/i.test(text)) return 'hls';

    // MPEG-TS: 同步字节 0x47，每 188 字节出现一次。
    // 不假定从包边界开始，前 188 字节内任一偏移连续命中三次即认定。
    for (let off = 0; off < 188 && off + 376 < head.length; off += 1) {
      if (head[off] === 0x47 && head[off + 188] === 0x47 && head[off + 376] === 0x47) return 'rawts';
    }
  }

  if (/mpegurl/i.test(ct) || /\.m3u8?$/.test(path)) return 'hls';
  if (/mp2t/i.test(ct) || /\.ts$/.test(path)) return 'rawts';
  if (/flv/i.test(ct) || /\.flv$/.test(path)) return 'flv';
  if (/^video\//.test(ct) || /\.(mp4|m4v|webm|mov)$/.test(path)) return 'file';
  return 'unknown';
}

function looksLikePlaylist(head) {
  if (!head) return false;
  const text = head.toString('utf8').replace(/^\uFEFF/, '');
  return /^\s*#EXTM3U/i.test(text) || /^\s*#EXTINF/i.test(text) || /#genre#/.test(text.slice(0, 512));
}

/**
 * 读完整段响应体（带上限保护）。
 *
 * initial：peekFirstChunk 已经读走的那一块。
 *
 * ⚠️ 千万不要再走「unshift 塞回去再读/再 pipe」那条路：
 * peekFirstChunk 把首块读走时，小文件的 'end' 往往已经触发过了，
 * 而 unshift 之后 Node 不会重发 'end' —— 结果是 readAll 永远不 resolve、
 * pipe 也永远不 end，整个请求挂死。首块必须显式传进来。
 */
function readAll(stream, limit = PLAYLIST_MAX_BYTES, initial = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    if (initial && initial.length) {
      chunks.push(initial);
      size += initial.length;
    }
    stream.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // 不静默截断：超限直接报错，让上层重试或明确失败，避免产出残缺的播放列表
        stream.destroy();
        fail(new Error(`响应体超过上限 ${(limit / 1024 / 1024).toFixed(0)}MB，已中断读取`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', finish);
    stream.on('error', fail);

    // 流在 peek 阶段就已经结束的话，'end' 不会再来了，主动收尾
    if (stream.readableEnded || stream.destroyed) finish();
  });
}

/**
 * 把上游数据透传给客户端，支持「首块已经在 peek 阶段读走」的情况。
 * 同样不能用 unshift：见 readAll 的说明。
 */
function pipeThrough(upstream, res, initial = null) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { res.end(); } catch (err) { /* ignore */ }
  };
  if (initial && initial.length) res.write(initial);
  upstream.on('data', (chunk) => {
    if (done) return;
    if (!res.write(chunk)) {
      upstream.pause();
      res.once('drain', () => upstream.resume());
    }
  });
  upstream.on('end', finish);
  upstream.on('error', () => { done = true; res.destroy(); });
  if (upstream.readableEnded || upstream.destroyed) finish();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 抓取文本。
 *
 * 必须带重试：iptv-hub 的 SQLite 临时空间只有 64MB，查询一并发就
 * "database or disk is full" 返回 500，而且 /iptv 导出同样会间歇性 500。
 * 这里对 5xx / 408 / 429 / 网络错误重试，4xx 直接放弃。
 */
async function fetchText(urlStr, ctx = {}, limit = PLAYLIST_MAX_BYTES, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { res, finalUrl } = await openUpstream(urlStr, ctx);
      const status = res.statusCode || 0;
      if (status >= 400) {
        res.resume();
        const err = new Error(`上游返回 HTTP ${status}`);
        err.statusCode = status;
        if (status < 500 && status !== 408 && status !== 429) err.noRetry = true;
        throw err;
      }
      const buf = await readAll(res, limit);
      const decoded = decodeBody(buf, res.headers['content-encoding']);
      return { text: decoded.toString('utf8'), finalUrl, headers: res.headers, statusCode: status };
    } catch (err) {
      lastError = err;
      if (err.noRetry || attempt === attempts) break;
      await sleep(400 * attempt);
    }
  }
  throw lastError || new Error('未知错误');
}

async function fetchJSON(urlStr, ctx = {}, attempts = 3) {
  const { text, finalUrl } = await fetchText(urlStr, ctx, 64 * 1024 * 1024, attempts);
  return { data: JSON.parse(text), finalUrl };
}

module.exports = {
  DEFAULT_UA,
  openUpstream,
  decodeBody,
  rewritePlaylist,
  peekFirstChunk,
  looksLikePlaylist,
  detectContainer,
  hostOf,
  readAll,
  pipeThrough,
  fetchText,
  fetchJSON,
  PLAYLIST_MAX_BYTES,
};
