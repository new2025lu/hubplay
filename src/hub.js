'use strict';

/**
 * iptv-hub 客户端。
 *
 * 关键设计：iptv-hub 的两套出口各有短板，必须合并使用——
 *   /iptv (M3U)  : 有防盗链 Referer / User-Agent、有多线路，但没有台标和测速
 *   /api/channels: 有 channel_key、台标、测速、线路数，但没有 Referer / UA
 * 所以先用 M3U 拿到「能播的地址」，再用 API 补齐「元信息」。
 */

const { fetchText, fetchJSON } = require('./stream');
const { parsePlaylist, streamKind, stripOrderPrefix } = require('./playlist');

const API_PAGE_SIZE = 100;
/**
 * iptv-hub 的 /api/channels 要对两万多行做 ORDER BY，SQLite 会把中间结果写进临时目录。
 * 它原先的容器 /tmp 只有 64MB tmpfs，并发一高就 "database or disk is full" 返回 500；
 * 现已改为 SQLITE_TMPDIR=/data/.sqlite-tmp + /tmp 256m，实测并发 10 仍全部成功。
 * 这里取 6 留出余量，并保留重试——万一临时空间配置被回退，也只是变慢而不会失败。
 */
const API_CONCURRENCY = 6;
const API_RETRIES = 3;

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function normalizeBase(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    return u.origin;
  } catch (err) {
    return null;
  }
}

/** 探测该地址是否为 iptv-hub（靠 /api/meta 的 name+version 特征）。 */
async function detectHub(input) {
  const base = normalizeBase(input);
  if (!base) return null;
  try {
    const { data } = await fetchJSON(`${base}/api/meta`);
    if (data && typeof data === 'object' && typeof data.name === 'string' && typeof data.version === 'string') {
      return base;
    }
  } catch (err) {
    /* 不是 hub */
  }
  return null;
}

/**
 * 拉取 hub 概览信息。
 *
 * 必须串行：/api/stats 和 /api/groups 都要扫大表，四个请求并发会再次
 * 撑爆 iptv-hub 那 64MB 的 /tmp，触发 500 和重试，导入反而从 4 秒变成 30 秒。
 * 每个请求都单独兜底，任何一个失败都不影响导入。
 */
async function loadHubMeta(base) {
  const safe = async (path, fallback) => {
    try {
      const { data } = await fetchJSON(`${base}${path}`, {}, 2);
      return data;
    } catch (err) {
      return fallback;
    }
  };
  const meta = await safe('/api/meta', null);
  const sources = await safe('/api/sources', []);
  const stats = await safe('/api/stats', null);
  const groups = await safe('/api/groups', []);
  return {
    meta,
    stats,
    groups: Array.isArray(groups) ? groups : [],
    sources: Array.isArray(sources) ? sources : [],
  };
}

/** 拉取 M3U，按「频道 → 多条线路」聚合，保留防盗链信息。 */
async function loadHubPlaylist(base, opts = {}) {
  const mode = opts.mode || 'multi';
  const top = opts.top || 5;
  const url = `${base}/iptv?mode=${encodeURIComponent(mode)}&top=${top}`;
  const { text } = await fetchText(url);
  const { format, items } = parsePlaylist(text);

  const byName = new Map();
  for (const item of items) {
    const group = item.group || '未分组';
    const name = stripOrderPrefix(item.name) || item.name;
    const key = `${group}::${name}`;
    if (!byName.has(key)) {
      byName.set(key, {
        favKey: key,
        name,
        group,
        logo: item.logo || '',
        lines: [],
      });
    }
    const entry = byName.get(key);
    if (item.logo && !entry.logo) entry.logo = item.logo;
    entry.lines.push({
      url: item.url,
      ref: item.ref || '',
      ua: item.ua || '',
      kind: streamKind(item.url),
      speed: null,
      source: '',
    });
  }
  return { format, channels: Array.from(byName.values()) };
}

/** 从任意 M3U / TXT 链接导入。 */
async function loadExternalPlaylist(url) {
  const { text, finalUrl } = await fetchText(url, {}, 64 * 1024 * 1024);
  const { format, items } = parsePlaylist(text);
  const byName = new Map();
  let index = 0;
  for (const item of items) {
    const group = item.group || '未分组';
    const name = stripOrderPrefix(item.name) || item.name;
    const key = `${group}::${name}`;
    if (!byName.has(key)) {
      byName.set(key, { favKey: key, name, group, logo: item.logo || '', lines: [] });
    }
    const entry = byName.get(key);
    if (item.logo && !entry.logo) entry.logo = item.logo;
    entry.lines.push({
      url: item.url,
      ref: item.ref || '',
      ua: item.ua || '',
      kind: streamKind(item.url),
      speed: null,
      source: '',
    });
    index += 1;
  }
  return { format, finalUrl, channels: Array.from(byName.values()) };
}

/** 分页并行拉取 /api/channels 全量（并发压到 6，失败重试）。 */
async function loadHubChannelIndex(base, onProgress) {
  const first = await fetchJSON(`${base}/api/channels?page=1&page_size=${API_PAGE_SIZE}&sort=default`);
  const total = Number(first.data.total || 0);
  const items = Array.isArray(first.data.items) ? first.data.items.slice() : [];
  const pages = Math.max(1, Math.ceil(total / API_PAGE_SIZE));
  const rest = [];
  for (let p = 2; p <= pages; p += 1) rest.push(p);

  let done = 1;
  let failed = 0;
  let attempts = 0;
  if (onProgress) onProgress(done, pages);

  const fetchPage = async (page) => {
    let lastError = null;
    for (let attempt = 1; attempt <= API_RETRIES; attempt += 1) {
      attempts += 1;
      try {
        const { data } = await fetchJSON(`${base}/api/channels?page=${page}&page_size=${API_PAGE_SIZE}&sort=default`);
        return Array.isArray(data.items) ? data.items : [];
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    failed += 1;
    throw lastError || new Error('分页拉取失败');
  };

  const pageResults = await pool(rest, API_CONCURRENCY, async (page) => {
    try {
      const chunk = await fetchPage(page);
      done += 1;
      if (onProgress) onProgress(done, pages);
      return chunk;
    } catch (err) {
      done += 1;
      if (onProgress) onProgress(done, pages);
      return null;
    }
  });

  for (const chunk of pageResults) {
    if (Array.isArray(chunk)) items.push(...chunk);
  }
  return { total, items, pages, failed, attempts };
}

/** 取名字最有参考价值的一条（优先有台标、有测速）。 */
function betterCandidate(a, b) {
  if (!b) return a;
  const score = (x) => (x.logo ? 2 : 0) + (typeof x.best_speed === 'number' ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

/**
 * 把 API 索引合并进 M3U 得到的频道表。
 *
 * 只做「全等」匹配（去掉排序编号 + 忽略大小写）。归一化匹配会把
 * `CCTV+ 1` 和 `CCTV-1` 认成同一个频道，补出错误的台标和测速，
 * 所以宁可少补 4%，也不补错。
 */
function mergeHubIndex(channels, apiItems) {
  const byName = new Map();
  for (const item of apiItems) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    byName.set(key, betterCandidate(item, byName.get(key)));
  }

  let matched = 0;
  for (const channel of channels) {
    const hit = byName.get(channel.name.toLowerCase());
    if (!hit) continue;
    matched += 1;
    channel.key = hit.channel_key;
    channel.region = hit.region || '';
    channel.country = hit.country || '';
    channel.logo = channel.logo || hit.logo || '';
    channel.streamCount = hit.stream_count || channel.lines.length;
    channel.sources = hit.sources || '';
    channel.speed = typeof hit.best_speed === 'number' ? hit.best_speed : null;
    channel.favorite = !!hit.favorite;
    // 分组以 M3U 的模板分组（央视/地方台/其他）为准，保证界面上分组稳定
    if (hit.url) {
      const primary = channel.lines.find((l) => l.url === hit.url);
      if (primary) {
        primary.speed = channel.speed;
        primary.source = hit.source_name || '';
        primary.recommended = true;
      }
    }
  }
  for (const channel of channels) {
    channel.lines.sort((a, b) => (b.speed || 0) - (a.speed || 0));
    if (channel.lines.length && !channel.lines.some((l) => l.recommended)) channel.lines[0].recommended = true;
  }
  return { matched, indexed: byName.size };
}

/** 频道详情：拿到该频道的全部线路（含实测速度）。 */
async function loadChannelDetail(base, channelKey) {
  const { data } = await fetchJSON(`${base}/api/channels/${encodeURIComponent(channelKey)}`);
  return data;
}

/** 通用 hub 调用（收藏、触发同步等写操作）。 */
function hostOf(target) {
  const h = target.hostname || '';
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

async function hubRequest(base, method, apiPath, body) {
  const url = `${base}${apiPath}`;
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: hostOf(target),
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = JSON.parse(text);
          } catch (err) {
            data = text;
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('hub 请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  normalizeBase,
  detectHub,
  loadHubMeta,
  loadHubPlaylist,
  loadExternalPlaylist,
  loadHubChannelIndex,
  mergeHubIndex,
  loadChannelDetail,
  hubRequest,
};
