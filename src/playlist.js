'use strict';

/**
 * 播放列表解析：M3U / M3U8 与 iptv-hub 的 TXT 格式。
 *
 * 重点：iptv-hub 导出的 M3U 会带防盗链信息，必须原样保留，否则播放必然失败：
 *   #EXTINF:-1 tvg-id="001 CCTV1" tvg-name="001 CCTV1" group-title="央视",001 CCTV1
 *   #EXTVLCOPT:http-referrer=http://example.com/
 *   #EXTVLCOPT:http-user-agent=Mozilla/5.0 ...
 *   http://1.2.3.4/live.m3u8
 */

/** 去掉 M3U 频道名前面的排序编号（"001 CCTV1" -> "CCTV1"）。 */
function stripOrderPrefix(name) {
  return String(name || '').replace(/^\s*\d{2,5}[\s._-]+/, '').trim() || String(name || '').trim();
}

function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || '').trim()) || /^(rtmp|rtsp):\/\//i.test(String(u || '').trim());
}

/** 解析 M3U / M3U8 文本。 */
function parseM3U(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  let pending = null;
  let lastGroup = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = parseAttributes(line);
      const comma = line.lastIndexOf(',');
      const title = comma >= 0 ? line.slice(comma + 1).trim() : '';
      pending = {
        name: title || attrs['tvg-name'] || attrs['tvg-id'] || '未命名频道',
        group: attrs['group-title'] || lastGroup || '未分组',
        tvgId: attrs['tvg-id'] || '',
        logo: attrs['tvg-logo'] || attrs['logo'] || '',
        ref: '',
        ua: '',
      };
      lastGroup = pending.group;
      continue;
    }

    if (line.startsWith('#EXTVLCOPT') || line.startsWith('#KODIPROP')) {
      if (pending) {
        const ref = /http-referrer\s*=\s*(.+)$/i.exec(line);
        if (ref) pending.ref = ref[1].trim();
        const ua = /http-user-agent\s*=\s*(.+)$/i.exec(line);
        if (ua) pending.ua = ua[1].trim();
        const opt = /^#EXTVLCOPT:(.+)$/i.exec(line);
        if (opt && !ref && !ua) {
          const kv = /^([a-z0-9_-]+)\s*=\s*(.+)$/i.exec(opt[1]);
          if (kv && /referrer|referer/i.test(kv[1])) pending.ref = kv[2].trim();
        }
      }
      continue;
    }

    if (line.startsWith('#EXTGRP')) {
      const g = line.slice(line.indexOf(':') + 1).trim();
      if (pending && g) pending.group = g;
      lastGroup = g || lastGroup;
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      if (isHttpUrl(line)) {
        out.push({
          name: pending.name,
          cleanName: stripOrderPrefix(pending.name),
          group: pending.group,
          logo: pending.logo,
          tvgId: pending.tvgId,
          url: line,
          ref: pending.ref,
          ua: pending.ua,
        });
      }
      pending = null;
    } else if (isHttpUrl(line)) {
      out.push({
        name: line,
        cleanName: line,
        group: lastGroup || '未分组',
        logo: '',
        tvgId: '',
        url: line,
        ref: '',
        ua: '',
      });
    }
  }
  return out;
}

/** 解析 iptv-hub 的 TXT 格式：`分组,#genre#` 后跟 `频道名,地址`。 */
function parseTXT(text) {
  const out = [];
  let group = '未分组';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith(',#genre#')) {
      group = line.slice(0, -',#genre#'.length).trim() || '未分组';
      continue;
    }
    const idx = line.indexOf(',');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const url = line.slice(idx + 1).trim();
    if (!isHttpUrl(url)) continue;
    out.push({
      name,
      cleanName: stripOrderPrefix(name),
      group,
      logo: '',
      tvgId: '',
      url,
      ref: '',
      ua: '',
    });
  }
  return out;
}

/** 自动识别格式并解析。 */
function parsePlaylist(text) {
  const head = String(text || '').slice(0, 4096);
  if (/#EXTM3U/i.test(head) || /#EXTINF/i.test(head)) return { format: 'm3u', items: parseM3U(text) };
  if (/#genre#/.test(head)) return { format: 'txt', items: parseTXT(text) };
  // 兜底：两种都试试，谁解析出的多就用谁
  const m3u = parseM3U(text);
  const txt = parseTXT(text);
  return m3u.length >= txt.length
    ? { format: 'm3u', items: m3u }
    : { format: 'txt', items: txt };
}

/**
 * 判断一个地址能否被 Chromium 直接播放。
 *
 * 注意 rawts（UDPXY 的 /rtp/）**是可以播的**：mpegts.js 会把 MPEG-TS 解复用后
 * 重新封装成 fMP4 喂给 MSE。实测 h264+aac / h264+mp2 / h264+ac3 都能出画，
 * 只有 hevc（4K）会在 addSourceBuffer 阶段失败。
 */
function streamKind(url) {
  const u = String(url || '');
  const path = u.split('?')[0].split('#')[0];
  if (/^rtsp:\/\//i.test(u)) return 'rtsp';
  if (/^rtmp:\/\//i.test(u)) return 'rtmp';
  if (/\/rtp\//i.test(path) || /\/udp\//i.test(path)) return 'rawts';
  if (/\.m3u8?$/i.test(path)) return 'hls';
  if (/\.flv$/i.test(path)) return 'flv';
  if (/\.(mp4|m4v|webm|mov)$/i.test(path)) return 'file';
  if (/\.mp3$/i.test(path)) return 'audio';
  // 裸 .ts 直接链：mpegts.js 能解复用 MPEG-TS，交给 rawts 分支尝试播放，而不是被一棍打死
  if (/\.ts$/i.test(path)) return 'rawts';
  if (/\.(mkv|avi|rmvb|wmv)$/i.test(path)) return 'unsupported';
  if (/\/tsfile\/|\/hls\/|\/live\/|\/relay\/|\/hlsr\//i.test(path)) return 'hls';
  return 'unknown';
}

/** 播放优先级：越小越先试。HLS 最稳，裸 TS 有音频/HEVC 风险，所以排在后面。 */
const KIND_RANK = { hls: 0, file: 0, audio: 0, flv: 1, unknown: 2, rawts: 3 };

const PLAYABLE = new Set(['hls', 'flv', 'file', 'audio', 'unknown', 'rawts']);

function isPlayable(url) {
  return PLAYABLE.has(streamKind(url));
}

function kindRank(kind) {
  return KIND_RANK[kind] ?? 9;
}

module.exports = { parsePlaylist, parseM3U, parseTXT, streamKind, isPlayable, kindRank, stripOrderPrefix };
