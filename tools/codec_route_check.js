'use strict';

/**
 * 编码路由验证（纯 Node，不需要浏览器）。
 *
 * 验的是这一条链：**点开频道 → 问清编码 → Chromium 解不了的直接交给 ffmpeg**。
 * 背景：源里大量线路是 MPEG-2 视频 + MP2 音频，Chromium 从根上没有这些解码器
 * （VLC / PotPlayer 自带，所以它们能播）。老流程只能等 hls.js 撞二十秒超时，
 * 现在应该「探测 → 判定 → 直连 ffmpeg」，秒级出画。
 *
 * 覆盖：
 *   1. /api/codec 对真实线路给出正确编码与判定
 *   2. 判定逻辑本身（MPEG-2/MP2 → ffmpeg；H.264/AAC → 直解）
 *   3. 结论缓存在服务端生效（第二次必须几乎不花时间）
 *   4. /api/remux 起得来，且产出的分片真的是 H.264 + AAC
 *   5. 参数校验
 *
 * 用法：
 *   node tools/codec_route_check.js
 *   SOURCE=http://127.0.0.1:18787  node tools/codec_route_check.js
 *   URL=http://110.72.78.112:808/hls/106/index.m3u8 node tools/codec_route_check.js
 *
 * 注意：默认那几条 MPEG-2 测试线路是**外部源**，网络不通时会跳过而不是判失败。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 找到能直接 require 的源码目录（含 src/ 与 renderer/）。
 *
 * 关键坑：**打包后的 HubPlay 里源码在 `resources\app.asar` 里，而标准 Node
 * 不能 require asar**（asar 是 Electron 自己打的补丁，`node` 不认）。
 * 所以从解压目录跑这个脚本时，必须先把 asar 里的 src/ renderer/ 摊出来。
 *
 * 查找顺序：
 *   1. HUBPLAY_DIR 环境变量指向的源码目录
 *   2. 脚本所在目录的上一级（正常放在 <HubPlay>/tools/ 下）
 *   3. 当前工作目录
 *   4. 以上位置里的 resources/app.asar → 自动提取到 <dir>/tools/.hubplay-src
 */
function findSourceDir() {
  const cands = [
    process.env.HUBPLAY_DIR,
    path.join(__dirname, '..'),
    process.cwd(),
  ].filter(Boolean);

  for (const root of cands) {
    if (fs.existsSync(path.join(root, 'src', 'server.js'))) return root;
  }

  // 打包形态：源码在 resources/app.asar
  for (const root of cands) {
    const asarPath = path.join(root, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) continue;
    const out = path.join(root, 'tools', '.hubplay-src');
    console.log(`[i] 源码在 app.asar 里（Node 不能直接 require），正在提取到 ${out} …`);
    try {
      extractAsarSources(asarPath, out);
      if (fs.existsSync(path.join(out, 'src', 'server.js'))) {
        console.log('[i] 提取完成。');
        return out;
      }
    } catch (err) {
      console.error(`[!] 从 app.asar 提取失败：${err.message}`);
    }
  }

  console.error('找不到 HubPlay 源码（要有 src/server.js 与 renderer/app.js）。');
  console.error('请把本脚本放在解压目录下再跑，例如：');
  console.error('  D:\\HubPlay\\codec_route_check.js');
  console.error('或显式指定：set HUBPLAY_DIR=D:\\HubPlay&& node codec_route_check.js');
  process.exit(2);
}

/**
 * 用 @electron/asar 提取源码。asar 模块不一定在（HubPlay 生产包不带 node_modules），
 * 所以退回**自己读 asar 格式**：它就是个带 JSON 头的归档，文件内容原样拼接在后面。
 * 只需要 src/ 与 renderer/ 两个目录，足够拉起本地服务与读 app.js。
 */
function extractAsarSources(asarPath, outDir) {
  let asar = null;
  try { asar = require('@electron/asar'); } catch (err) { asar = null; }

  fs.mkdirSync(outDir, { recursive: true });

  if (asar && typeof asar.extractAll === 'function') {
    // 全量提取最简单，代价是 app.asar 里的 vendor 库也一起摊出来（几 MB）
    asar.extractAll(asarPath, outDir);
    return;
  }

  // ---- 手写兜底解析 ----
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(4);            // [0..3]=4, [4..7]=header size
  const headerJsonSize = buf.readUInt32LE(12);       // 头部 JSON 长度
  const header = JSON.parse(buf.slice(16, 16 + headerJsonSize).toString('utf8'));
  const dataStart = 8 + headerSize;

  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = `${prefix}/${name}`;
      if (entry.files) { walk(entry, rel); continue; }
      if (!/^\/(src|renderer)\//.test(rel)) continue;
      const dest = path.join(outDir, rel.replace(/^\//, ''));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf.slice(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + Number(entry.size)));
    }
  };
  walk(header, '');
}

const ROOT = findSourceDir();
const RENDERER_DIR = path.join(ROOT, 'renderer');
const { LocalServer } = require(path.join(ROOT, 'src', 'server.js'));

/** 从 app.asar 提取出来的临时源码目录：跑完删掉，别在用户目录里留垃圾。 */
function cleanupExtracted() {
  if (!/\.hubplay-src$/.test(ROOT)) return;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (err) { /* 删不掉就算了 */ }
}

const results = [];
const record = (name, ok, note) => {
  results.push({ name, ok, note });
  console.log(`${ok ? '✅' : '❌'} ${name}${note ? ` — ${note}` : ''}`);
};

/** 默认测试线路：第一条确认是 MPEG-2/MP2，第二条是 H.264/AAC。 */
const DEFAULT_LINES = {
  mpeg2: process.env.URL_MPEG2 || 'http://110.72.78.112:808/hls/106/index.m3u8',
  h264: process.env.URL_H264 || 'http://example.com/live/h264.m3u8',
};

/**
 * 从真实源码里抽出判定函数来跑，而不是复制一份实现 ——
 * 否则测试通过只能证明复制品是对的。见 tools/gpu_decode_check.js 的同类做法。
 */
function loadCodecLogic() {
  const src = fs.readFileSync(path.join(RENDERER_DIR, 'app.js'), 'utf8');
  const grabFn = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`renderer/app.js 里找不到 function ${name}`);
    let depth = 0;
    for (let k = src.indexOf('{', i); k < src.length; k += 1) {
      if (src[k] === '{') depth += 1;
      else if (src[k] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(i, k + 1);
      }
    }
    throw new Error(`无法截取 ${name}`);
  };
  const i = src.indexOf('const CODEC_LABEL = {');
  const j = src.indexOf('\n};', i);
  const code = [
    src.slice(i, j + 3),
    grabFn('codecText'),
    grabFn('describeCodec'),
    grabFn('chromiumCanDecode'),
    grabFn('codecVerdict'),
  ].join('\n');

  // 模拟一台「Chromium 只认 H.264 / AV1 / AAC / MP3」的机器
  const supported = new Set([
    'video/mp4; codecs="avc1.42E01E"',
    'video/mp4; codecs="av01.0.04M.08"',
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/mp4; codecs="mp4a.40.34"',
  ]);
  const win = { MediaSource: { isTypeSupported: (t) => supported.has(t) } };
  const state = { decodeMode: 'auto' };
  const run = new Function('window', 'MediaSource', 'state',
    `${code}\nreturn { codecText, describeCodec, chromiumCanDecode, codecVerdict };`);
  return { api: run(win, win.MediaSource, state), state };
}

async function main() {
  console.log('=== 一、判定逻辑（直接跑 renderer/app.js 里的真实实现）===\n');
  const { api, state } = loadCodecLogic();
  const V = (v, a) => api.codecVerdict({
    video: v ? { codec: v, width: 720, height: 576 } : null,
    audio: a ? { codec: a } : null,
  });

  record('H.264 + AAC 判定为「直解」', api.chromiumCanDecode('h264', 'aac') === true);
  record('MPEG-2 + MP2 判定为「没有解码器」', api.chromiumCanDecode('mpeg2video', 'mp2') === false);
  record('H.264 + MP2 音频也判定为不支持', api.chromiumCanDecode('h264', 'mp2') === false);
  record('MPEG-2 线路 → tier=ffmpeg', V('mpeg2video', 'mp2').tier === 'ffmpeg',
    V('mpeg2video', 'mp2').reason);
  record('H.264/AAC 线路 → tier=direct', V('h264', 'aac').tier === 'direct');
  record('HEVC 线路 → tier=ffmpeg', V('hevc', 'aac').tier === 'ffmpeg');
  record('探测不出结论时返回 null（照老流程试）', api.codecVerdict(null) === null,
    '不能把探测失败当成播不了');
  state.decodeMode = 'software';
  record('手动选「软件解码」时不走直解', V('h264', 'aac').tier === 'ffmpeg');
  state.decodeMode = 'auto';
  const describeMpeg2 = api.describeCodec({
    video: { codec: 'mpeg2video', width: 720, height: 576 }, audio: { codec: 'mp2' },
  });
  record('编码文案可读', describeMpeg2 === 'MPEG-2 720×576 / MP2', describeMpeg2);

  console.log('\n=== 二、本地服务端点 ===\n');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubplay-codec-'));
  const server = new LocalServer({
    rendererDir: RENDERER_DIR,
    dataDir,
    port: Number(process.env.PORT || 17915),
  });
  const origin = await server.start();
  console.log(`本地服务: ${origin}\n`);

  let firstUrl = null;
  for (const [name, url] of Object.entries(DEFAULT_LINES)) {
    const q = new URLSearchParams({ u: url });
    const t0 = Date.now();
    let d;
    try {
      d = await (await fetch(`${origin}/api/codec?${q}`)).json();
    } catch (err) {
      record(`/api/codec ${name} 可访问`, false, err.message);
      continue;
    }
    const ms = Date.now() - t0;
    if (!d.ok) {
      // 外部源不通不算失败：这台机器可能访问不到那台 CDN
      record(`/api/codec ${name} 探测成功`, false, `跳过（源不可达：${d.error}）`);
      continue;
    }
    const codecStr = `${d.video ? d.video.codec : '-'}/${d.audio ? d.audio.codec : '-'}`;
    record(`/api/codec ${name} 返回编码`, !!d.video || !!d.audio, `${codecStr} tier=${d.tier}（${ms} ms）`);

    if (name === 'mpeg2' && d.video && d.video.codec === 'mpeg2video') {
      record('MPEG-2 线路判定为需要转码', d.tier === 'transcode', d.reason);
      firstUrl = url;
    }
    if (name === 'h264' && d.video && d.video.codec === 'h264') {
      record('H.264 线路判定为可直接播放', d.tier === 'direct', d.reason);
    }

    // 缓存必须生效，否则点开频道要多花几百毫秒
    const t1 = Date.now();
    await fetch(`${origin}/api/codec?${q}`);
    const ms2 = Date.now() - t1;
    record(`/api/codec ${name} 走缓存`, ms2 < 120, `第二次 ${ms2} ms（首次 ${ms} ms）`);
  }

  const r400 = await fetch(`${origin}/api/codec`);
  record('缺 u 参数返回 400', r400.status === 400);
  const rBad = await fetch(`${origin}/api/codec?u=ftp://x/y`);
  record('非 http(s) 地址返回 400', rBad.status === 400);

  if (firstUrl) {
    console.log('\n=== 三、ffmpeg 接管链路（真实的 MPEG-2 线路）===\n');
    const t0 = Date.now();
    const d = await (await fetch(`${origin}/api/remux`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: firstUrl, name: 'codec-route-check' }),
    })).json();
    record('/api/remux 建立会话', !!d.ok, d.ok ? `${Date.now() - t0} ms（探测已缓存）` : d.error);

    if (d.ok) {
      const pr = await fetch(`${origin}/api/local/hls/${d.id}/index.m3u8`);
      const text = await pr.text();
      record('产出 HLS 播放列表', pr.status === 200 && /#EXTM3U/.test(text),
        `HTTP ${pr.status}，${text.split('\n').filter((l) => /\.ts$/.test(l)).length} 个分片`);
      record('列表是滚动直播窗口（不是 EVENT 只增不减）', !/EXT-X-PLAYLIST-TYPE:EVENT/.test(text));

      const seg = (text.match(/^[^\n#].*\.ts$/m) || [])[0];
      if (seg) {
        const sr = await fetch(`${origin}/api/local/hls/${d.id}/${seg}`);
        const buf = Buffer.from(await sr.arrayBuffer());
        const { execFile } = require('child_process');
        const local = require(path.join(ROOT, 'src', 'local.js'));
        const probeSeg = () => new Promise((resolve) => {
          execFile(local.FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name',
            '-of', 'csv=p=0', path.join(require('os').tmpdir(), 'hubplay-codec-check.ts')],
          (err, stdout) => resolve(err ? '' : String(stdout).trim()));
        });
        const tmpSeg = path.join(os.tmpdir(), 'hubplay-codec-check.ts');
        fs.writeFileSync(tmpSeg, buf);
        const codecs = await probeSeg();
        fs.rmSync(tmpSeg, { force: true });
        record('转码产物分片可下载', sr.status === 200 && buf.length > 10000, `${buf.length} 字节`);
        record('转码产物是 H.264 + AAC（Chromium 一定能播）',
          /h264/.test(codecs) && /aac/.test(codecs), codecs.replace(/\n/g, ' + '));
      } else {
        record('播放列表里有分片地址', false);
      }

      // 会话体检接口：界面靠它把「转圈转到死」变成能看懂的错误
      const st = await (await fetch(`${origin}/api/remux/status?id=${d.id}`)).json();
      const s = st.session || {};
      console.log(`  会话体检: started=${s.started} finished=${s.finished} exitCode=${s.exitCode} ` +
        `segments=${s.segments} error="${s.error || ''}"`);
      record('/api/remux/status 可用', st.ok === true && !!st.session);
      record('转码会话有分片且没报错', s.segments > 0 && !s.error,
        `segments=${s.segments} error=${s.error || '无'}`);

      const all = await (await fetch(`${origin}/api/remux/status`)).json();
      record('不带 id 时能列出全部会话', all.ok === true && Array.isArray(all.sessions),
        `${(all.sessions || []).length} 个会话`);
    }
  } else {
    console.log('\n（跳过 ffmpeg 链路：没探到可用的 MPEG-2 线路）\n');
  }

  await server.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  cleanupExtracted();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${passed}/${results.length}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  ❌ ${f.name} — ${f.note || ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('运行失败：', err);
  process.exit(1);
});
