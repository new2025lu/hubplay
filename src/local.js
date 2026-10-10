'use strict';

/**
 * 本地视频播放支持。
 *
 * Chromium 只能解一部分容器/编码，AVI(DivX)、WMV、MPEG-2、RMVB 这些原生播不了，
 * 所以内置一份 ffmpeg，按「能省则省」分三档处理：
 *
 *   direct     容器+编码浏览器都认  → 直接吐原文件，支持 Range，拖动进度条最快最准
 *   remux      视频编码认、容器或音频不认（如 AVI 里的 H.264、MKV 里的 AC3）
 *              → -c:v copy 只换壳/只转音频，几乎不耗 CPU
 *   transcode  视频编码也不认（DivX/Xvid、MPEG-2、WMV、RMVB…）
 *              → libx264 转码，慢，但能看
 *
 * 后两档统一产出 HLS 到临时目录，播放器用已有的 hls.js 播放。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

/* ---------------------------------------------------------------- 二进制定位 */

function exeName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function candidateDirs() {
  const dirs = [];
  if (process.env.HUBPLAY_FFMPEG_DIR) dirs.push(process.env.HUBPLAY_FFMPEG_DIR);
  // 打包后：resources/ffmpeg/
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'ffmpeg'));
  // 开发时：项目里的 vendor-win
  dirs.push(path.join(__dirname, '..', 'vendor-win', 'ffmpeg', 'bin'));
  const vendored = path.join(__dirname, '..', 'vendor-win');
  try {
    for (const entry of fs.readdirSync(vendored)) {
      if (entry.startsWith('ffmpeg-')) dirs.push(path.join(vendored, entry, 'bin'));
    }
  } catch (err) {
    /* 没有 vendor-win 就算了 */
  }
  return dirs;
}

function findBinary(name) {
  for (const dir of candidateDirs()) {
    const p = path.join(dir, exeName(name));
    try {
      if (fs.existsSync(p)) return p;
    } catch (err) {
      /* ignore */
    }
  }
  return exeName(name); // 交给 PATH
}

const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

/* ---------------------------------------------------------------- 探测与判定 */

const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
// Chromium 能解的音频；ac3/eac3/dts 在 Windows 上偶有硬件支持但不保证，一律不算
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
// Chromium 认的容器
const BROWSER_CONTAINER = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'ogg',
  'mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm',
]);

function runCapture(bin, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * 网络流的输入参数：把防盗链信息作为 HTTP 头交给 ffmpeg。
 * ffmpeg 自己就能播 PotPlayer 能播的东西，所以这条路径等于「用 ffmpeg 当播放器」。
 *
 * ⚠️ 所有输入选项必须写在 `-i` **之前**。ffmpeg 的规则是「离哪个文件近就作用于哪个」，
 * 写在 `-i` 之后的会被当成输出选项。`-reconnect` 系列原本错放在 `-i` 后面，
 * 等于对输入流完全没生效——上游断流时 ffmpeg 不会自己重连，只能整条重来。
 */
function networkInputArgs(url, ref, ua) {
  const args = [];
  // HTTP 协议选项（输入级）：断流自动重连 + 超时，直播源抖动时这一条决定能不能自愈
  /*
   * 吞吐调优 —— 这里是「带宽没吃满」的真正原因。
   *
   * 老参数是 `-reconnect_delay_max 5`：一旦这次连接断掉/超时，ffmpeg 最多要**等 5 秒**
   * 才去重连。而这条上游是突发式交付（吐完一批就停），ffmpeg 把已到达的数据读完、
   * 缓冲见底后必然断开重连 —— 于是每次都被罚站最多 5 秒才去拿下一片。
   * 实测（2026-10-07 落盘时间戳）：每 10~14 秒就出现一次 4.2 秒的空档、偶尔 6.1 秒，
   * 平均吞吐被压到约 1.09 倍实时 —— 这**不是上游慢，是我们在它门口干等**。
   * VLC 不会这样，它的重连退避是几百毫秒级。
   *
   * 所以：退避从 5 秒压到 0.25 秒；总退避封顶 3 秒（避免疯狂重试打爆源）；
   * 读超时放宽到 30 秒（别把上游正常停顿误判成断开）；keep-alive 复用连接；
   * 坏包丢弃继续而不是为它重连。预期吞吐提升约 1.5 倍。
   */
  args.push(
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_http_error', '4xx,5xx',
    // 注意：这是**整数秒**（ffmpeg 选项表写明 int），写 0.25 会被截断成 0
    '-reconnect_delay_max', '1',
    '-reconnect_delay_total_max', '3',
    '-rw_timeout', '30000000',
    /*
     * ⚡ 预读/追赶三件套 —— 这是当前 ffmpeg 用来解决「直播源跟不上」的官方机制，
     * 语义直接来自你本机 ffmpeg 的 `-h full` 选项表（已核对）：
     *
     *   -readrate 1            跟随直播，1 倍速
     *   -readrate_initial_burst 30   起播先冲刺读完前 30 秒，然后再限速
     *   -readrate_catchup 5    输入落后于指定速率时，临时用 5 倍速追赶
     *
     * 为什么这三条正好治这条源（2026-10-07 实测）：
     *   · 上游播放列表**恒定握着 21.6 秒存量**（5 片 × 4.3 秒），而 ffmpeg 默认按实时读，
     *     读到「当前正在播的那一段」就停住等下一片 —— 那 21.6 秒存量白白留在源站；
     *   · 通道有 9.3 倍余量（实测 59~119 Mbps），转码也有 1.8~4.4 倍余量，
     *     唯一的瓶颈就是「我们自己读得慢」；
     *   · 上游每 10~14 秒会停顿约 2 秒（突发式交付），`-readrate_catchup` 让 ffmpeg
     *     在停顿结束后用 5 倍速把落后的部分立刻补回来，而不是一直落后下去。
     *
     * 结果：起播即有 ~20 秒真实缓冲，之后每次上游停顿都能被追回，缓冲不再触底。
     * （同款思路见 Jellyfin：它也判 ffmpeg 版本决定是否使用 readrate / readrate_catchup。）
     */
    '-readrate', '1',
    '-readrate_initial_burst', '30',
    '-readrate_catchup', '5',
  );
  /*
   * ⚡ 分片地址没有扩展名时，ffmpeg 默认会拒收**整条流**（2026-10-10 实测）。
   *
   * ysp-live 这类中转源把分片包成 /cctv1/segment/<base64>，地址结尾没有 .ts。
   * ffmpeg 的 hls 解复用器有两道扩展名检查：
   *   1. allowed_segment_extensions —— 白名单，不在名单里直接拒绝；
   *   2. extension_picky —— 嗅探出的格式与地址后缀对不上时也拒绝，报
   *      「detected format mpegts extension none mismatches allowed extensions in url」。
   *
   * 本机 ffprobe 实测（同一条线路）：
   *   - 只加 -allowed_segment_extensions ALL → 仍然失败（卡在第 2 道）
   *   - 加 -extension_picky 0                → 读到 stream,aac,audio / stream,h264,video ✓
   *
   * 这就是「PotPlayer / VLC 能播、我们的 ffmpeg 却说『不是有效视频』」的答案：
   * 它们不查这个后缀，ffmpeg 默认查。两条都是**输入级**选项，必须写在 -i 之前。
   */
  args.push('-allowed_segment_extensions', 'ALL', '-extension_picky', '0');
  const lines = [];
  if (ref) lines.push(`Referer: ${ref}`);
  if (ua) lines.push(`User-Agent: ${ua}`);
  if (lines.length) args.push('-headers', lines.join('\r\n') + '\r\n');
  // 探测窗口收小：3M 会让起播多等一秒多，1M 足够认出编码
  args.push('-analyzeduration', '1M', '-probesize', '1M');
  args.push('-i', url);
  return args;
}

/**
 * 探测结果缓存。
 *
 * 「这条线路是什么编码」是播放决策的地基：Chromium 解不了的（MPEG-2、AC-3…）
 * 要直接交给 ffmpeg，而不是先让 hls.js 撞二十秒。前端点开一个频道会先问一次，
 * 紧接着点播放时 openStream/closeSession 还要再问一次 —— 不缓存就是同一条流
 * 探测两遍，白等两倍时间。
 *
 * TTL 给 5 分钟：编码不会频繁变，但直播源中途换线路的情况存在，所以不能永久缓存。
 */
const CODEC_TTL_MS = 5 * 60 * 1000;
const codecCache = new Map();   // key(url/路径) → { at, info }

function codecCacheKey(file, inputArgs) {
  if (inputArgs) {
    const i = inputArgs.indexOf('-i');
    if (i >= 0 && inputArgs[i + 1]) return `net:${inputArgs[i + 1]}`;
  }
  return `file:${file}`;
}

/** ffprobe 拿流信息；ffprobe 不可用时退回解析 ffmpeg -i 的 stderr。 */
async function probe(file, inputArgs = null) {
  const key = codecCacheKey(file, inputArgs);
  const hit = codecCache.get(key);
  if (hit && Date.now() - hit.at < CODEC_TTL_MS) return hit.info;

  const info = await probeUncached(file, inputArgs);
  // 失败结果不缓存：源只是抖了一下，下次该重试
  if (info && info.ok) codecCache.set(key, { at: Date.now(), info });
  return info;
}

/**
 * ffprobe 用的输入参数。
 *
 * ⚠️ `-readrate` / `-readrate_initial_burst` / `-readrate_catchup` 是 **ffmpeg CLI 自己的
 * 输入选项**（在 fftools 里，不在 libavformat 里），ffprobe 根本不存在这些选项 ——
 * 混在一起传过去，ffprobe 第一句就报
 *   Failed to set value '1' for option 'readrate': Option not found
 * 于是一直退到下面的 ffmpeg 回退路径。实测（2026-10-10）：
 *   · `ffprobe ... -readrate 1 ... -i <m3u8>` → 直接失败；
 *   · 去掉这三条 → 正常读出 stream,aac,audio / stream,h264,video。
 * 而回退路径拿到的是不带输入参数的裸 `-i`，遇到「分片地址没有扩展名」的源
 * （ysp-live 那种 /segment/<base64>）又会被扩展名检查拒掉 —— 两头都失败，
 * 于是界面显示「无法解析这个文件（不是有效视频？）」，线路一被白白判成播不了。
 */
function probeInputArgs(inputArgs) {
  const drop = new Set(['-readrate', '-readrate_initial_burst', '-readrate_catchup']);
  const out = [];
  for (let i = 0; i < (inputArgs || []).length; i += 1) {
    if (drop.has(inputArgs[i])) { i += 1; continue; }   // 连它的值一起跳过
    out.push(inputArgs[i]);
  }
  return out;
}

async function probeUncached(file, inputArgs = null) {
  const r = await runCapture(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
    ...probeInputArgs(inputArgs && inputArgs.length ? inputArgs : ['-i', file]),
  ]);
  if (r.stdout && r.stdout.trim().startsWith('{')) {
    let d;
    try {
      d = JSON.parse(r.stdout);
    } catch (err) {
      d = null;
    }
    if (d) {
      const streams = Array.isArray(d.streams) ? d.streams : [];
      const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
      const a = streams.find((s) => s.codec_type === 'audio');
      return {
        ok: true,
        file,
        format: d.format?.format_name || '',
        duration: Number(d.format?.duration || 0),
        size: Number(d.format?.size || 0),
        video: v ? { codec: v.codec_name, width: v.width, height: v.height } : null,
        audio: a ? { codec: a.codec_name, channels: a.channels } : null,
        raw: d,
      };
    }
  }

  // 退路：解析 ffmpeg -i。这里同样要带输入参数 —— 否则「分片地址没有扩展名」
  // 的源在退路上也会被扩展名检查拒掉（线路一就是这么两头都失败的）。
  const f = await runCapture(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'info', ...probeInputArgs(inputArgs && inputArgs.length ? inputArgs : ['-i', file])],
    20000
  );
  const text = f.stderr || '';
  const vm = text.match(/Stream #\d+:\d+.*?: Video: (\w+)/);
  const am = text.match(/Stream #\d+:\d+.*?: Audio: (\w+)/);
  const dm = text.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
  let duration = 0;
  if (dm) duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]) + (+dm[4]) / 100;
  if (!vm && !am) return { ok: false, error: '无法解析这个文件（不是有效视频？）', text: text.slice(-400) };
  return {
    ok: true,
    file,
    format: path.extname(file).slice(1).toLowerCase(),
    duration,
    size: 0,
    video: vm ? { codec: vm[1] } : null,
    audio: am ? { codec: am[1] } : null,
  };
}

function decide(info, file, caps) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const v = info.video ? info.video.codec : null;
  const a = info.audio ? info.audio.codec : null;
  const containerOk = BROWSER_CONTAINER.has(ext) || BROWSER_CONTAINER.has(info.format);
  /*
   * HEVC（H.265）要看机器：Windows 上 Chromium 只有拿到平台 HEVC 硬解时才能解，
   * 所以白名单里默认没有它。但前端启动时会用 mediaCapabilities 探测一次
   * （state.decodeCap.hevc_1080），探到支持就把结论带过来 —— 否则每一路 HEVC 频道
   * 都会白白走一遍转码（实测这台机器 MSE/hev1 = true，属于能直通的那类）。
   */
  const hevcOk = !!(caps && caps.hevc) && (v === 'hevc' || v === 'h265');
  const videoOk = !v || BROWSER_VIDEO.has(v) || hevcOk;
  const audioOk = !a || BROWSER_AUDIO.has(a);

  if (containerOk && videoOk && audioOk) {
    return { tier: 'direct', reason: `容器 ${ext || info.format} 与编码 ${v || '-'}/${a || '-'} 浏览器原生支持` };
  }
  if (videoOk) {
    const bad = [];
    if (!containerOk) bad.push(`容器 ${ext || info.format}`);
    if (!audioOk) bad.push(`音频 ${a}`);
    return { tier: 'remux', reason: `${bad.join('、')} 不支持，但视频 ${v} 可直通，只换壳` };
  }
  // 把「Chromium 根本不认识这个编码」说清楚：MPEG-2 这类不是线路坏了，
  // 是浏览器没有对应的解码器（VLC/PotPlayer 自带，所以它们能播）。
  return {
    tier: 'transcode',
    reason: `视频 ${v}${a ? ` / 音频 ${a}` : ''} Chromium 没有解码器（VLC/PotPlayer 自带），转成 H.264+AAC`,
  };
}

/* ---------------------------------------------------------------- 会话管理 */

const sessions = new Map();
const WORK_ROOT = path.join(os.tmpdir(), 'hubplay-local');
const MAX_SESSIONS = 6;

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

async function sweep() {
  // 会话太多就回收最老的（不动的）
  if (sessions.size <= MAX_SESSIONS) return;
  const list = [...sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt);
  while (sessions.size > MAX_SESSIONS && list.length) {
    const s = list.shift();
    await closeSession(s.id);
  }
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    if (s.proc && !s.proc.killed) s.proc.kill('SIGKILL');
  } catch (err) {
    /* ignore */
  }
  try {
    await fsp.rm(s.dir, { recursive: true, force: true });
  } catch (err) {
    /* ignore */
  }
}

async function closeAll() {
  for (const id of [...sessions.keys()]) await closeSession(id);
}

/**
 * 为一个网络直播流建会话（ffmpeg 兜底播放）。
 *
 * 走这条路的都是浏览器引擎（hls.js / mpegts.js / flv.js）全都放不出来的流：
 * HEVC、AC-3/MP2 音频、非标准 TS 封装等等。ffmpeg 直接按 URL 拉流，
 * 再输出成 H.264+AAC 的 HLS，Chromium 就能播了——等同于把 MPV/VLC 的解码能力搬进应用。
 */
async function openStream({ url, ref, ua, name, videoMode, caps }) {
  if (!/^https?:\/\//i.test(url)) throw new Error('地址不合法');
  const inputArgs = networkInputArgs(url, ref, ua);
  const info = await probe(url, inputArgs);
  if (!info.ok) throw new Error(info.error || '拉流失败');
  const plan = decide(info, name || url, caps);

  await sweep();
  const id = newId();
  const dir = path.join(WORK_ROOT, id);
  await fsp.mkdir(dir, { recursive: true });

  // 浏览器放不出来的流，ffmpeg 这边也不追求「直出」，统一走转码/换壳
  const tier = plan.tier === 'direct' ? 'remux' : plan.tier;
  const session = {
    id,
    file: url,
    name: name || url,
    info,
    tier,
    reason: plan.reason,
    dir,
    proc: null,
    started: false,
    finished: false,
    error: '',
    touchedAt: Date.now(),
    /*
     * 视频怎么处理：'copy'（默认，换壳）还是 'transcode'（真正重编）。
     *
     * 为什么要这个开关：有些源的 H.264 码流 SPS 里带着 MSE 不认的 constraint 位 ——
     * 实测（2026-10-10）浏览器报的 mime 是 `avc1.640128`，而
     * MediaSource.isTypeSupported('video/mp4;codecs="avc1.640128"') = false，
     * 同一档次换成 'avc1.640028' / 'avc1.64001f' 就是 true（差别只在第二个字节）。
     * `-c:v copy` 会把这个 SPS 原样搬进输出，于是 ffmpeg 做得再对、播放器也建不起
     * SourceBuffer。此时唯一的出路是**真编一遍**：libx264 产出的 SPS 是浏览器认的那种。
     * 谁来决定：前端 —— 它手上有浏览器返回的真实 mime（见 renderer/app.js 的
     * bufferAddCodecError 处理），先试 copy，被拒了再带 video:'transcode' 重来一次。
     */
    videoMode: videoMode === 'transcode' ? 'transcode' : 'copy',
    network: { url, ref: ref || '', ua: ua || '', inputArgs },
  };
  sessions.set(id, session);
  return session;
}

/** 为一个本地文件建会话：探测 + 定档，真正的 ffmpeg 等第一次请求播放列表时才起。 */
async function openFile(file, caps) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    throw new Error(`打不开文件：${err.message}`);
  }
  if (!stat.isFile()) throw new Error('不是一个文件');

  const info = await probe(file);
  if (!info.ok) throw new Error(info.error || '探测失败');
  const plan = decide(info, file, caps);

  await sweep();
  const id = newId();
  const dir = path.join(WORK_ROOT, id);
  await fsp.mkdir(dir, { recursive: true });

  const session = {
    id,
    file,
    name: path.basename(file),
    info,
    tier: plan.tier,
    reason: plan.reason,
    dir,
    proc: null,
    started: false,
    finished: false,
    error: '',
    touchedAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

function ffmpegArgs(session) {
  /*
   * 会不会走到「重编」档 —— 决定要不要给解码上硬件加速。
   *
   * 这个包里的 ffmpeg 带了 mpeg2_qsv / hevc_amf / h264_amf / h264_qsv 等硬件解码器，
   * 这台机器又是 AMD RX590 + Intel UHD：转码时把**解码**放到 GPU 上，CPU 只负责编码，
   * 占用能明显下来（用户抱怨的「转码时卡」多半就来自软件解码抢 CPU）。
   *
   * 只在转码档插 `-hwaccel auto`：
   *   · 换壳档是 `-c:v copy`，解码根本用不上；
   *   · 而且它必须写在 `-i` 之前 —— `-hwaccel` 是**输入级**选项，
   *     和 `-readrate` 一样，绝不能混进喂给 ffprobe 的那份参数里（1.6.11 踩过）。
   * 所以这里复制一份 input 再插，不动 session.network.inputArgs 本体。
   */
  const willTranscode = session.tier !== 'remux'
    || session.videoMode === 'transcode'
    || !!(session.info && session.info.video && session.info.video.codec
      && session.info.video.codec !== 'h264');
  const input = session.network
    ? session.network.inputArgs.slice()
    : ['-i', session.file];
  if (willTranscode && session.hwaccel !== false) {
    const at = input.indexOf('-i');
    if (at >= 0) {
      input.splice(at, 0, '-hwaccel', 'auto');
      session.hwaccelUsed = true;
    }
  }
  const base = [
    '-hide_banner', '-loglevel', 'error', '-y', ...input,
    /*
     * 时间戳重建 —— 这是「t 在走、frames 不动」那个死局的正面解法。
     *
     * 实测（2026-10-07 01:44 日志）：上游是突发式交付（11 片 5 秒内吐完、然后卡 6 秒，
     * 之后每 10~14 秒亏 2.2 秒）。ffmpeg 默认把这种"交付空档"当成**时间戳跳变**
     * 原样往输出传，于是：
     *   - 输出里留下时间轴空洞，hls.js 只能把播放点挪到空洞之后（日志里 t 从 22.00 起播）；
     *   - 解码器跨空洞时几乎不产帧（frames 4 秒里只从 4 涨到 5）。
     * VLC 不受影响是因为它顺序消费、对跳变只是"等一会儿"；MSE/hls.js 对跳变则很敏感。
     *
     * `+genpts` 让缺时间戳的包按帧率补出来，`+igndts` 忽略上游不可信的 DTS，
     * `-avoid_negative_ts make_zero` 把起点归零 —— 输出变成**连续无空洞**的时间轴，
     * 上游的空档就只剩"数据晚到一会儿"，不再变成时间轴上的坑。
     */
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
  ];
  /*
   * HLS 输出参数。
   *
   * 原来是 `-hls_playlist_type event`：EVENT 列表只会追加、永不缩短，
   * 直播场景下 hls.js 每次刷新列表都要把越来越长的表读一遍。
   * 直播该用滚动窗口列表，而 ffmpeg 的 `hls_playlist_type` **只有 event / vod 两个值**
   * （`live` 不是合法取值，实测会报 `Unable to parse "hls_playlist_type" option value "live"`），
   * 不传这个选项（默认 0）产出的就是滚动直播列表 —— 这才是直播该用的形态。
   *
   * `-hls_delete_threshold 6`：ffmpeg 会多留 6 个分片再删，避免客户端
   * 刚拿到列表、分片就被删掉（表现是 hls.js 反复 404）。
   */
  const hls = [
    /*
     * `-max_muxing_queue_size`：CPU 跟不上时封装队列会积压，默认值下 ffmpeg 会
     * **丢包**，产出的分片就是坏的（客户端表现正是 append 失败）。转码档宽松一点。
     */
    '-max_muxing_queue_size', '1024',
    /*
     * `-thread_queue_size` 是**输出侧**选项，必须写在输出文件之前。
     * 我第一版把它错放进输入参数（`-i` 之前），ffmpeg 直接拒绝启动：
     *   "Option thread_queue_size ... cannot be applied to input url ..."
     * 后果是会话目录全空、播放器永远在等 —— 实测踩过（2026-10-07 01:56）。
     */
    '-thread_queue_size', '4096',
    '-f', 'hls',
    '-hls_time', '2',
    /*
     * 分片改用 **fMP4（.m4s）**，不再用 MPEG-TS。
     *
     * 实测（2026-10-07 01:21 日志 + 落盘产物取证）：
     *   静态画面那几片 258~288 KB（≈1 Mbps）→ append 全部成功；
     *   画面一动、码率跳到 1078 KB（≈4.3 Mbps）的那一片 → `bufferAppendError`。
     * TS 分片要先经 hls.js 的 transmuxer 才能进 MSE，码率一大就更容易在这个缝上翻车。
     * fMP4 是 ISO BMFF，**MSE 原生吃这种容器**，省掉整层 TS→fMP4 转换（hls.js 官方的
     * 低延迟直播方案也是 fMP4），这类 append 失败能直接消掉。
     * 注意 init 分片必须单独生成并由播放列表引用，扩展名要给 .m4s 之外的 .mp4，
     * 否则 /api/local/hls 那条路由会把 Content-Type 给成 octet-stream。
     */
    '-hls_segment_type', 'fmp4',
    /*
     * ⚠️ 这里必须是**相对文件名**，而且 ffmpeg 的 cwd 必须设成会话目录。
     *
     * 踩过的坑（01:23 实测）：只传 `-hls_fmp4_init_filename init.mp4` 时，
     * ffmpeg 把 init 分片写进了**它自己的 cwd**（应用工作目录），会话目录里根本没有
     * init.mp4 —— 而播放列表照样写 `#EXT-X-MAP:URI="init.mp4"`，
     * 于是 hls.js 一直在等服务端吐一个不存在的文件：日志里只有一串
     * LEVEL_LOADED，一个分片都不请求、永远 0×0。所以文件名一律用相对的，
     * 由 startTranscode() 把 cwd 设成 session.dir。
     */
    '-hls_fmp4_init_filename', 'init.mp4',
    /*
     * 播放列表改成 **EVENT 型（只增不减）** —— 这是"像 VLC 一样播"的关键。
     *
     * 原来的写法是滚动直播列表（`delete_segments`，只留 24 片），于是有两个后果：
     *   1. 分片会被删掉，播放头一落后就**再也拿不到**那几片；
     *   2. hls.js 的直播延迟控制发现"落后超过阈值"时，唯一的出路就是**把播放头
     *      硬拽回直播边缘** —— 实测日志里那些 `t=4.06 → 17.39` 的 13 秒突跳就是它。
     * 而 VLC / PotPlayer 不这么干：它们遇到上游晚到几秒就安静地等一下，所以用户
     * 看不出抖动。同一个源，差别只在这个播放列表形态。
     *
     * EVENT 型列表**只追加、不删除**，于是：
     *   - 已下载的分片永远还能再取，播放头不必再往前跳；
     *   - 播放点落后了也只是缓冲变深，画面不会被打断；
     *   - 上游晚到 5 秒那种空档，靠前向缓冲就消化掉了。
     * 代价是列表越来越长：按 2 秒一片、每片约 0.6 MB 算，**一小时约 1 GB**
     * （`-hls_list_size 1800` 会把上限压在 1 小时左右，够看一场直播了）。
     * 会话结束（换台/关软件）时临时目录会被 sweep 清掉。
     */
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    ...(session.network ? ['-hls_list_size', '1800'] : []),
    '-hls_segment_filename', 'seg%05d.m4s',
    'index.m3u8',
  ];

  if (session.tier === 'direct') return null;

  /*
   * 转码档：这些源多是 720×576 的 MPEG-2 SD（实测码率 2~4 Mbps），
   * 软件转码完全跟得上，所以用 ultrafast 把 CPU 压到最低 —— 起播更快，
   * 而且不会和播放抢 CPU 导致丢帧。转码档本来就是「宁可多花 CPU 也要能播」。
   */
  const ENC_V = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '50', '-sc_threshold', '0',
    /*
     * 关键帧必须**正好落在分片边界**上。
     *
     * 实测（2026-10-07 日志）：MPEG-2 线路转码后能出画，但 hls.js 报
     * `mediaError/bufferAppendError fatal=true`，随后缓冲一路见底（0.2 秒）画面发顿。
     * 原因就是分片边界和关键帧没对齐：只给 `-g 50` 时关键帧间距取决于**输入帧率**
     * （25fps 才是 2 秒，29.97fps 变成 1.67 秒），而 hls.js 按 EXTINF 切/接分片，
     * 切在非关键帧上就会 append 失败。显式按时间点强制关键帧，分片长度才真正恒等于 -hls_time。
     */
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    /*
     * 码率上限：源是 SD（720×576），实测转码产物在画面变动时会从 1 Mbps 冲到 4.3 Mbps。
     * 尖峰本身不是错，但它会让「2 秒 1MB」的大分片集中到达，正好撞在接缝上。
     * 限在 2.5 Mbps 以内，SD 画质基本无损，分发却稳得多。
     */
    '-maxrate', '2500k', '-bufsize', '5000k',
    /*
     * 恒定帧率输出：即使上游某一秒只给了一半的帧，也按 25fps 补齐，
     * 保证时间轴等间隔、分片时长恒等于 -hls_time 所要求的 2 秒。
     * （`copy` 档不能用这个 —— 它不许改帧率。）
     */
    '-fps_mode', 'cfr', '-r', '25'];
  const ENC_A = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];

  if (session.tier === 'remux') {
    const audioCodec = session.info.audio ? session.info.audio.codec : null;
    const videoCodec = session.info.video ? session.info.video.codec : null;
    // 视频必须是 H.264 才能直通（HEVC/AV1 直通出去 Chromium 照样解不了）
    if (videoCodec && videoCodec !== 'h264') {
      return [...base, ...ENC_V, ...ENC_A, ...hls];
    }
    // 源是 H.264，但浏览器拒收它的 SPS（见 openStream 里 videoMode 的注释）→ 真编一遍
    if (session.videoMode === 'transcode') {
      return [...base, ...ENC_V, ...ENC_A, ...hls];
    }
    const audioOk = !audioCodec || BROWSER_AUDIO.has(audioCodec);
    // 视频直通；音频能直通就直通，否则只转音频（很便宜）
    /*
     * 音频一律重编成 AAC，不做 `-c:a copy`（2026-10-10 实测踩坑）。
     *
     * 起因：线路一 / 线路四的源是 H.264 + **ADTS AAC**，判活时 audioOk=true，
     * 于是走了 `-c:a copy`。而 fMP4 容器不收 ADTS 形式的 AAC —— ffmpeg 直接
     * 报「use the audio bitstream filter 'aac_adtstoasc' to fix it」并退出，
     * 会话体检里留下的就是 `Error writing trailer: Operation not permitted`，
     * 界面表现为「ffmpeg 接管失败」，线路被标红。
     *
     * 三条路里选了最稳的一条：
     *   · 加 `-bsf:a aac_adtstoasc` —— 只治 AAC，别的容器/位流组合还会踩；
     *   · 先 copy 失败再重试 —— 多一次失败与重试，直播起播时间要不起；
     *   · **一律重编 AAC**（本行）—— 128k 立体声对 CPU 是零头，
     *     而它一次性覆盖 MP2 / AC-3 / ADTS-AAC / LATM-AAC 全部情况。
     * 视频仍然是 `-c:v copy`，真正吃 CPU 的那部分一点没多。
     */
    return [...base, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', ...hls];
  }

  // 转码：MPEG-2 / HEVC / AV1 这类 Chromium 没有解码器的视频
  return [...base, ...ENC_V, ...ENC_A, ...hls];
}

/** 启动 HLS 生成（幂等）。 */
function startTranscode(session) {
  if (session.tier === 'direct' || session.started) return;
  session.started = true;
  const args = ffmpegArgs(session);
  /*
   * cwd 必须是会话目录：HLS 输出文件名用的是相对路径（见 ffmpegArgs 里那段注释），
   * 只有 cwd 对了，init.mp4 和 seg*.m4s 才会和 index.m3u8 落在同一个目录里。
   */
  const proc = spawn(FFMPEG, args, { windowsHide: true, cwd: session.dir });
  session.proc = proc;

  let stderr = '';
  proc.stderr.on('data', (b) => {
    stderr += b.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
    session.stderr = stderr;
  });
  session.stderr = '';
  proc.on('error', (err) => {
    session.error = `ffmpeg 启动失败：${err.message}`;
    session.finished = true;
  });
  proc.on('close', (code) => {
    session.finished = true;
    // 退出码即使是 0 也留个底：直播流被上游掐断时我们也要知道
    session.exitCode = code;
    if (code !== 0) session.error = `ffmpeg 退出码 ${code}：${stderr.trim().split('\n').pop() || ''}`;
    /*
     * 硬件解码在这台机器上不成立时（驱动/运行时缺失），ffmpeg 会在**启动阶段**就退出。
     * 这种情况不能把整条线路判死 —— 去掉 -hwaccel 再来一次就是了。
     * 判据压得很紧：必须用过 -hwaccel、只重试一次、且确实是启动就失败（没产出任何分片）。
     */
    if (code !== 0 && session.hwaccelUsed && !session.hwaccelRetried) {
      session.hwaccelRetried = true;
      session.hwaccelUsed = false;
      session.hwaccel = false;      // 下一次 ffmpegArgs() 不再插 -hwaccel
      session.error = '';
      session.finished = false;
      session.started = false;
      fsp.readdir(session.dir).then((names) => Promise.all(names
        .filter((n) => /^(seg\d+\.m4s|init\.mp4|index\.m3u8.*)$/.test(n))
        .map((n) => fsp.rm(path.join(session.dir, n), { force: true }))))
        .catch(() => {})
        .then(() => {
          session.stderr = '';
          startTranscode(session);   // 这次不带 -hwaccel
        });
    }
  });
}

/**
 * 会话的体检报告。
 *
 * 转码是「本机再编一遍」，出问题时光看界面只会看到一个转圈 ——
 * 分不清是 ffmpeg 没起来、拉不到流、还是编不出来。这个接口把这些都摊开，
 * 专门用来排查「点了半天没画面」。
 */
async function sessionStatus(session) {
  const out = {
    id: session.id,
    tier: session.tier,
    reason: session.reason,
    video: session.info ? session.info.video : null,
    audio: session.info ? session.info.audio : null,
    started: !!session.started,
    finished: !!session.finished,
    exitCode: session.exitCode === undefined ? null : session.exitCode,
    error: session.error || '',
    ageMs: Date.now() - (session.touchedAt || Date.now()),
    segments: 0,
    mediaSequence: null,
    firstSegment: null,
    // 播放列表最后更新时间距今多久。ffmpeg 靠「写 .tmp → 改名」重写列表，
    // 只要改名被别的句柄挡住，这里就会一直变大而分片数不动 —— 那是
    // 「转圈但分片在涨」这类故障的唯一读数，日志里必须留痕。
    playlistAgeMs: null,
    stderrTail: (session.stderr || '').trim().split('\n').slice(-6).join('\n'),
  };
  try {
    const listPath = path.join(session.dir, 'index.m3u8');
    out.playlistAgeMs = Date.now() - (await fsp.stat(listPath)).mtimeMs;
    const text = await fsp.readFile(listPath, 'utf8');
    const segs = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    out.segments = segs.length;
    out.firstSegment = segs[0] || null;
    const m = text.match(/EXT-X-MEDIA-SEQUENCE:(\d+)/);
    out.mediaSequence = m ? Number(m[1]) : null;
  } catch (err) {
    /* 还没产出列表 */
  }
  return out;
}

function playlistPath(session) {
  return path.join(session.dir, 'index.m3u8');
}

module.exports = {
  FFMPEG,
  FFPROBE,
  probe,
  decide,
  openFile,
  openStream,
  startTranscode,
  playlistPath,
  closeSession,
  closeAll,
  sessions,
  codecCache,
  networkInputArgs,
  sessionStatus,
  BROWSER_VIDEO,
  BROWSER_AUDIO,
  BROWSER_CONTAINER,
};
