'use strict';

/**
 * HubPlay 渲染进程。
 * 所有网络请求都打到本机 127.0.0.1 上的本地服务（见 src/server.js），
 * 因此不存在跨域问题：界面、接口、流三者同源。
 */

const $ = (id) => document.getElementById(id);

const video = $('video');

/*
 * 记住「哪些源地址必须重编视频」。
 *
 * 起因（2026-10-10 22:18，CCTV13 线路一）：那条源的 H.264 SPS 带了 MSE 不认的
 * constraint 位，`-c:v copy` 出来的分片浏览器建不了 SourceBuffer，必须先换壳试一次、
 * 被拒了再改成重编 —— 而「被拒」这个信号偶尔收不到（旧实例事件被丢弃 / hls.js 没抛错），
 * 于是一路转圈。这里把结论按 URL 记下来：**同一条源以后第一次就直接用重编档**，
 * 不再依赖那次失败能被及时发现。
 */
const TRANSCODE_URLS = new Set();

const state = {
  channels: [],
  groups: [],
  hub: null,
  kind: '',
  sourceUrl: '',
  group: '全部',
  favOnly: false,
  query: '',
  favorites: new Set(),
  currentId: -1,
  lines: [],
  currentLine: -1,
  candidates: [],
  failures: new Set(),
  failReasons: new Map(),   // 线路下标 → 失败原因（显示在面板上，别只给最后一条）
  playToken: 0,
  hls: null,
  mpegts: null,
  flv: null,
  watchdog: null,
  attemptHandlers: [],
  enriched: false,
  busy: false,
  loading: false,
  visible: [],
  renderedRange: null,
  autoHide: true,
  sidebarRevealed: true,
  chromeTimer: null,
  osdBase: '',
  lastChannelFavKey: '',
  pendingRestoreKey: '',
  rawtsHintShown: false,
  bufferPreset: 'balanced',
  decodeMode: 'auto',    // 视频解码方式（auto/独显/核显/软解）
  gpuInfo: null,         // 主进程报告的显卡与硬解状态
  decodeCap: null,       // 当前流的硬解能力探测结果（mediaCapabilities）
  locals: [],            // 本地视频条目
  mode: 'stream',        // stream=网络频道, file=本地文件
  seeking: false,
  stallTimer: null,
  activeAttempt: null,
  userPaused: false,
  livePlan: null,        // 当前线路量到的直播窗口方案（livewin.js）
  liveWindow: null,      // 量到的原始窗口数据（换档位时用它重算方案）
  holeJumps: 0,          // 本次播放跳过缓冲空洞的次数
  edgeSeeks: 0,          // 本次播放往直播边缘回跳的次数
  thinSince: null,       // 前向缓冲开始「填不满」的时刻（判「喂不满码率」用）
  starveSwitches: 0,     // 本次播放因带宽不足换线路的次数
  wantFfmpeg: false,     // 本次播放已判定「Chromium 解不了」，直接走 ffmpeg 转码
  ffmpegTried: false,    // ffmpeg 兜底是否已尝试过（避免反复起进程）
  ffmpegFallback: false, // 当前是否正由 ffmpeg 接管
  ffmpegVideoMode: 'copy', // ffmpeg 侧视频处理方式：copy（换壳）/ transcode（重编，源 SPS 浏览器不认时用）
  ffmpegHandoffAt: 0,       // 上次把播放交给 ffmpeg 的时刻 —— 只用来给「迟到报错」做限时防抖
  transcodeRetryAt: 0,      // 「换壳档未出画 → 改重编」只做一次的时间戳
  lastTriedUrl: '',         // 最后尝试过的线路地址（交给外部播放器用）
  hlsSeq: 0,                // hls.js 实例序号：销毁/新建都自增，用来丢弃**旧实例**排队里的迟到事件
  lastFailReason: '',    // 最后一次失败原因（兜底时提示用）
  healthTimer: null,     // 转码期间的会话体检轮询
  remuxSid: null,        // 当前 ffmpeg 接管会话 id（换线路/换台时先关掉它，别让旧 ffmpeg 挂着跑）
  parseFails: 0,         // 同一线路连续解析失败次数（用来识别「编码不支持」）
  ffmpegTools: null,     // 启动自检结果：ffmpeg / ffprobe 是否就位
  decodeTimer: null,     // 解码看门狗（「有数据但不出帧」专用）
  loaderRescues: 0,      // 缓冲见底时救活 hls.js 加载器的次数（诊断用）
  lastFrame: null,       // 最近一次「帧进度」读数（解码器到底出没出帧）
  pictureAt: null,       // 第一次真正出画的时刻（时间轴在推进 且 有分辨率）
  pictureSince: null,    // 「有数据但解不出帧」是从什么时候开始的（解码卡死判据）
};

/* ---------------------------------------------------------------- 工具 */

let toastTimer = null;
function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 5000 : 2600);
}

/**
 * 限流版 toast。
 * 直播源抖起来时 hls.js 一秒能报好几次同类错误，直接 toast 会把屏幕刷花，
 * 也会盖掉真正重要的提示（比如「已跳回直播边缘」）。
 */
const toastSeen = new Map();
function toastThrottled(message, gapMs = 8000, isError) {
  const now = Date.now();
  const last = toastSeen.get(message) || 0;
  if (now - last < gapMs) return;
  toastSeen.set(message, now);
  toast(message, isError);
}

/* ------------------------------------------------------------ 诊断日志 */
/*
 * 为什么要做在应用里：
 *
 * 「点了频道只有转圈、没有画面」这类问题，光看界面拿不到任何线索 ——
 * 而 hls.js 到底走到哪一步（列表解析了没 / 分片拉到没 / append 到 MSE 没 /
 * video 元素有没有报错）只有它自己知道。靠用户口述「放不了」，只能互相猜。
 *
 * 所以这里把 hls.js 事件、video 元素事件、线路失败判定、ffmpeg 会话状态
 * 全部记进一个环形缓冲，按 L 打开面板、点「复制」就能整段发回来。
 * 只记事件名与关键字段，不记分片内容，开销可以忽略（上限 400 条）。
 */
const DIAG_MAX = 600;
const diagLog = [];          // 事件流水 { t, tag, msg, level }
const diagSamples = [];      // 每秒采样单独放：否则 1 秒一条会把事件流水挤光
const DIAG_SAMPLE_MAX = 150;

function diagPush(tag, msg, level) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const ms = String(t.getMilliseconds()).padStart(3, '0');
  diagLog.push({ t: `${hh}:${mm}:${ss}.${ms}`, tag, msg: String(msg), level: level || '' });
  if (diagLog.length > DIAG_MAX) diagLog.shift();
  // 面板开着就实时刷新
  const p = document.getElementById('diagPanel');
  if (p && !p.classList.contains('hidden')) renderDiag();
}

/** 每秒采样走单独的环形缓冲，不参与事件流水的淘汰。 */
function samplePush(msg) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  diagSamples.push({ t: `${hh}:${mm}:${ss}`, msg: String(msg) });
  if (diagSamples.length > DIAG_SAMPLE_MAX) diagSamples.shift();
  const p = document.getElementById('diagPanel');
  if (p && !p.classList.contains('hidden')) renderDiag();
}

/**
 * 帧进度读数 —— 「到底出没出画」的唯一权威判据。
 *
 * ⚠️ 这里踩过一个足以让整个播放器「永远转圈」的坑：
 * **MSE 只要有数据 append 进缓冲，video.readyState 就会是 2/3，哪怕解码器
 * 一帧都没解出来**（典型就是硬件解码链路挂掉：分片 append 成功、readyState>=2，
 * 但 currentTime 永远停在 0、videoWidth/videoHeight 是 0）。
 *
 * 所以判活**不能看 readyState，只能看「时间轴在推进」或「已经有了分辨率」**。
 * 老代码两处都写成 `readyState >= 2` 就算「已经出画」：
 *   1. 起播看门狗 → 直接收工，spinner 再也不清，界面永远转圈；
 *   2. 卡顿看门狗 → 认为画面出过了，之后时间轴不动只当普通卡顿处理。
 * 合起来正好是用户报的那句「转圈、不报错、不换线路」。
 */
function frameReport() {
  const v = video;
  const b = v.buffered;
  const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  return {
    at: Date.now(),
    rs: v.readyState,
    t: v.currentTime,
    w: v.videoWidth,
    h: v.videoHeight,
    paused: v.paused,
    buffered: b.length ? Math.max(0, b.end(b.length - 1) - v.currentTime) : 0,
    frames: q ? q.totalVideoFrames : null,
    dropped: q ? q.droppedVideoFrames : null,
  };
}

/** 有分辨率、时间轴在推进 = 真的出画了。 */
function pictureSeen(r) {
  const x = r || state.lastFrame;
  if (!x) return false;
  return x.w > 0 && x.h > 0 && x.t > 0.05;
}

/** 人读的帧读数，例如 `rs=3 t=0.00 0x0 buf=8.0s frames=0`。 */
function frameText(r) {
  const x = r || frameReport();
  return `rs=${x.rs} t=${x.t.toFixed(2)} ${x.w}x${x.h} buf=${x.buffered.toFixed(1)}s` +
    (x.frames == null ? '' : ` frames=${x.frames} dropped=${x.dropped}`);
}

/**
 * 给工具脚本用的内部句柄。
 *
 * 存在的理由很具体：**「分片 append 成功但解码器不出帧」这个死局，在无头浏览器里
 * 没法可靠复现**（容器里软解一切正常，偏偏在用户那台机器上不出帧）。
 * 所以把判据和看门狗暴露出来，让 tools/frame_progress_check.js 能直接构造
 * 「readyState≥2 且缓冲在涨、currentTime 恒为 0」的状态，验证看门狗真的会报错、
 * 而不是继续转圈。只读 + 手动调用，不参与正常播放路径。
 */
const DIAG_DEBUG = { frameReport: null, pictureSeen: null, recordFrame: null, frameText: null, armDecodeWatchdog: null, stopDecodeWatchdog: null };

/** 采样一次帧进度。出画以前每次都更新，出画之后只记第一次，免得刷屏。 */
function recordFrame() {
  const r = frameReport();
  state.lastFrame = r;
  if (pictureSeen(r) && !state.pictureAt) {
    state.pictureAt = r.at;
    diagPush('play', `出画：${frameText(r)}`, 'ok');
  }
  return r;
}

function diagText() {
  const cv = state.currentLine >= 0 ? state.lines[state.currentLine] : null;
  const cvInfo = cv ? codecCache.get(cv.url) : null;
  const b = video.buffered;
  const buf = b.length ? `${b.start(0).toFixed(1)}~${b.end(b.length - 1).toFixed(1)}` : '-';
  const head = [
    `HubPlay 诊断日志  ${new Date().toLocaleString()}`,
    `平台 ${navigator.platform}`,
    `hls.js ${window.Hls ? window.Hls.version : '无'}  MSE ${window.MediaSource ? '可用' : '不可用'}  解码方式 ${state.decodeMode}`,
    `频道 ${$('osdTitle').textContent || '-'}  线路 ${state.currentLine + 1}/${state.lines.length}  ffmpeg 兜底 ${state.ffmpegFallback ? '是' : '否'}`,
    `当前线路编码 ${cvInfo ? describeCodec(cvInfo) : '(未探测)'}  判定 ${cvInfo ? (codecVerdict(cvInfo) || {}).tier : '-'}`,
    `内置 ffmpeg ${state.ffmpegTools ? (state.ffmpegTools.ffmpegVersion || '不可用') : '(未自检)'}`,
    `硬解状态 ${(state.gpuInfo && state.gpuInfo.featureStatus && state.gpuInfo.featureStatus.video_decode) || '(未取到)'}  显卡 ${activeGpuName() || '(未知)'}`,
    `硬解能力 ${JSON.stringify(state.decodeCap || {})}`,
    `video readyState=${video.readyState} t=${video.currentTime.toFixed(2)} ${video.videoWidth}x${video.videoHeight} paused=${video.paused} buffered=${buf}`,
    `帧进度 ${frameText()}`,
    `出画判定 ${pictureSeen() ? '已出画（时间轴在推进）' : (video.readyState >= 2 ? '⚠ readyState≥2 但解码器没出帧（时间轴没动 / 分辨率为 0）' : '尚未拿到数据')}`,
    `当前线路 ${cv ? cv.url : '-'}`,
  ].join('\n');
  const body = diagLog.map((r) => `${r.t} [${r.tag}] ${r.msg}`).join('\n');
  const samples = diagSamples.map((r) => `${r.t} ${r.msg}`).join('\n');
  // 失败线路一览：日志是环形缓冲，最关键的那几条（谁被判死、什么原因）可能已被挤掉
  const failLines = state.lines.length
    ? state.lines.map((l, i) => (state.failures.has(i)
        ? `  ${lineLabel(i + 1)} FAIL ${state.failReasons.get(i) || '-'}  ${l.url}`
        : null)).filter(Boolean).join('\n') || '  （本次没有线路被判失败）'
    : '  （还没取到线路）';
  return `${head}\n` +
    `--- 线路失败一览（${state.failures.size}/${state.lines.length}）---\n${failLines}\n` +
    `--- 事件流水 ---\n${body}\n--- 每秒采样（最近 ${diagSamples.length} 条）---\n${samples}\n`;
}

function renderDiag() {
  const el = document.getElementById('diagLog');
  if (!el) return;
  const ev = diagLog.map((r) => {
    const esc = escapeHtml(`${r.t} [${r.tag}] ${r.msg}`);
    const cls = r.level === 'err' ? 'd-err' : r.level === 'warn' ? 'd-warn' : r.level === 'ok' ? 'd-ok' : '';
    return cls ? `<span class="${cls}">${esc}</span>` : esc;
  }).join('\n');
  const sm = diagSamples.length
    ? `\n<span class="d-ok">--- 每秒采样（${diagSamples.length} 条）---</span>\n` +
      diagSamples.map((r) => escapeHtml(`${r.t} ${r.msg}`)).join('\n')
    : '';
  el.innerHTML = ev + sm;
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, kind) {
  $('statusText').textContent = text;
  $('statusDot').className = `dot ${kind || ''}`.trim();
  $('status').title = text;
}

function setBadge(text, kind) {
  const el = $('syncBadge');
  el.textContent = text;
  el.className = `badge badge-${kind || 'idle'}`;
}

function setSpinner(on, text) {
  $('spinner').classList.toggle('hidden', !on);
  if (text) $('spinnerText').textContent = text;
  // 注意括号：写成 !!state.currentId >= 0 会因为 !!(x) >= 0 恒为 true 而永远隐藏占位图
  $('placeholder').classList.toggle('hidden', on || state.currentId >= 0);
}

/*
 * 错误面板。
 *
 * ⚡ 第三参数 retryable：给出「重试」按钮。
 * 踩过的坑（2026-10-07 用户截图）：面板上写着「换一个频道，或在 iptv-hub 里重新测速后再试」，
 * 可是**界面上根本没有任何地方能重试** —— state.failures 一旦把线路全标记完，
 * 同一个频道再点也没用，只能换个频道再点回来。用户的原话就是「无法播放」。
 * 现在错误面板直接给按钮，点一下等于重新走一遍 playChannel
 * （会清空 failures、重跑预检、重新测速）。
 */
function showError(title, body, retryable) {
  $('errorTitle').textContent = title;
  /*
   * 「用外部播放器打开」——Chromium 的 MSE 有一批它就是不收的流（MP2 / MPEG-2 没解码器、
   * 源的 H.264 SPS 带了它不认的 constraint 位、分片地址没有扩展名…）。
   * 内置 ffmpeg 兜底能解决绝大多数，但遇到它也放不出来的时候，本机装的
   * PotPlayer / VLC / mpv 自带 libavcodec，同一路流它们直接就能播 —— 一键交出去。
   */
  const url = state.currentLine >= 0 && state.lines[state.currentLine]
    ? state.lines[state.currentLine].url
    : (state.lastTriedUrl || '');
  const actions = [];
  if (retryable) actions.push('<button id="btnRetryLine" class="btn btn-primary">重试这个频道</button>');
  if (url) actions.push('<button id="btnExternalPlayer" class="btn">用外部播放器打开</button>');
  const btn = actions.length ? `<div class="error-actions">${actions.join('')}</div>` : '';
  $('errorBody').innerHTML = body + btn;
  $('errorBox').classList.remove('hidden');
  const rb = $('btnRetryLine');
  if (rb) {
    rb.addEventListener('click', () => {
      if (state.currentId >= 0) playChannel(state.currentId);
    });
  }
  const eb = $('btnExternalPlayer');
  if (eb) {
    eb.addEventListener('click', async () => {
      const api = window.hubplay || {};
      if (typeof api.playExternal !== 'function') { toast('这个构建没有外挂播放器通道', true); return; }
      const line0 = state.currentLine >= 0 ? state.lines[state.currentLine] : null;
      const r = await api.playExternal({
        url: (line0 && line0.url) || state.lastTriedUrl || '',
        ref: (line0 && line0.ref) || '',
        ua: (line0 && line0.ua) || '',
      });
      if (r && r.ok) {
        let msg = '已交给 ' + String(r.player || '').split('\\').pop();
        if (r.headersForwarded) msg += '（带上了防盗链请求头）';
        else if (!r.canForwardHeaders) msg += '（该播放器不支持自定义 UA/Referer，防盗链源可能打不开）';
        toast(msg);
      } else {
        toast('外部播放器打不开：' + ((r && r.reason) || '未知原因'), true);
      }
    });
  }
}

function hideError() {
  $('errorBox').classList.add('hidden');
}

function fmtSpeed(kbps) {
  if (typeof kbps !== 'number' || !isFinite(kbps) || kbps <= 0) return '';
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${Math.round(kbps)} KB/s`;
}

function speedTagClass(kbps) {
  if (kbps >= 800) return 'fast';
  if (kbps >= 200) return '';
  return 'slow';
}

function starFor(favKey) {
  return state.favorites.has(favKey);
}

/* ---------------------------------------------------------------- 配置 */

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const data = await r.json();
    const cfg = data.config || {};
    state.favorites = new Set(cfg.favorites || []);
    video.volume = typeof cfg.volume === 'number' ? cfg.volume : 1;
    $('volume').value = String(video.volume);
    video.muted = !!cfg.mute;
    updateMuteIcon();

    // 关键：loadConfig 是异步的，回来时用户可能已经在输入框里打字了。
    // 直接 value = 会把已输入内容覆盖并续写，拼出
    // "http://a:18787http://a:18787" 这种垃圾地址。只在输入框为空时才回填。
    if (cfg.sourceUrl && !$('srcInput').value.trim()) {
      $('srcInput').value = cfg.sourceUrl;
    }
    // 启动时先展开侧边栏方便选频道，点了频道之后才会自动收起
    state.bufferPreset = BUFFER_PRESETS[cfg.bufferPreset] ? cfg.bufferPreset : 'balanced';
    state.decodeMode = DECODE_MODES.some((m) => m.value === cfg.decodeMode) ? cfg.decodeMode : 'auto';
    $('bufferSel').value = state.bufferPreset;
    $('decodeSel').value = state.decodeMode;
    state.autoHide = cfg.autoHide !== false;
    state.sidebarRevealed = true;
    applySidebar();
    state.lastChannelFavKey = cfg.lastChannel || '';
    return cfg;
  } catch (err) {
    return {};
  }
}

/**
 * 侧边栏 / 顶栏的自动隐藏。
 *
 * 关键：**只有正在播放时才进入沉浸模式**。
 * 没播放之前侧边栏照常占位，否则鼠标一划过窗口右侧就会把列表收走，
 * 用户根本点不到频道（这个坑在测试里立刻被抓出来了）。
 *
 * 沉浸模式下：侧边栏脱离文档流、覆盖在画面上滑出（不挤压画面，
 * 否则鼠标每扫过一次左边缘视频都要重新排版）；顶栏也整体收起，
 * 鼠标一动滑下来，静止 2.5 秒收回。
 */
function isImmersive() {
  return state.autoHide && state.currentId >= 0;
}

function applySidebar() {
  const app = document.querySelector('.app');
  const immersive = isImmersive();
  app.classList.toggle('autohide', immersive);
  app.classList.toggle('immersive', immersive);
  app.classList.toggle('reveal', immersive && state.sidebarRevealed);
  if (!immersive) {
    app.classList.remove('show-chrome');
    clearTimeout(state.chromeTimer);
  }
  const btn = $('btnSidebar');
  btn.classList.toggle('off', state.autoHide);
  btn.title = state.autoHide
    ? '自动隐藏已开启：播放时侧边栏和顶栏让位给画面，鼠标移到左边缘/动一下唤出。点此改为常驻 (B)'
    : '自动隐藏已关闭（常驻显示）。点此开启 (B)';
}

function showChrome() {
  const app = document.querySelector('.app');
  if (!isImmersive()) return;
  app.classList.add('show-chrome');
  clearTimeout(state.chromeTimer);
  state.chromeTimer = setTimeout(() => app.classList.remove('show-chrome'), 2500);
}

function hideChrome() {
  clearTimeout(state.chromeTimer);
  const app = document.querySelector('.app');
  if (isImmersive()) app.classList.remove('show-chrome');
}

/** 把顶栏高度写进 CSS 变量，侧边栏滑出时才知道要往下让多少 */
function syncTopbarHeight() {
  const h = document.querySelector('.topbar').offsetHeight;
  document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}

async function setAutoHide(on, persist = true) {
  state.autoHide = !!on;
  // 进入沉浸模式时先收起，需要时再靠鼠标唤出
  state.sidebarRevealed = !isImmersive();
  applySidebar();
  if (persist) await saveConfig({ autoHide: state.autoHide });
  toast(
    state.autoHide
      ? '已开启自动隐藏：播放时侧边栏和顶栏会自动让位，鼠标移到左边缘或动一下唤出'
      : '已关闭自动隐藏：侧边栏和顶栏常驻显示'
  );
}

function revealSidebar(reveal) {
  if (!isImmersive() || state.sidebarRevealed === reveal) return;
  state.sidebarRevealed = reveal;
  applySidebar();
}

/** 点击频道开始播放后让位给画面 */
function collapseSidebarForPlayback() {
  state.sidebarRevealed = false;
  applySidebar();
}

function toggleSidebar() {
  setAutoHide(!state.autoHide);
}

/** 左边缘滑出侧边栏，移开收起；任意移动唤出顶栏 */
function bindSidebarHover() {
  const sidebar = document.querySelector('.sidebar');
  let hideTimer = null;

  document.addEventListener('mousemove', (e) => {
    if (!isImmersive()) return;
    showChrome();

    if (!state.sidebarRevealed) {
      if (e.clientX <= 14) revealSidebar(true);
      return;
    }
    const width = sidebar.offsetWidth || 320;
    if (e.clientX > width + 24) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => revealSidebar(false), 220);
    } else {
      clearTimeout(hideTimer);
    }
  });

  // 鼠标离开窗口：顶栏和侧边栏都收起
  document.addEventListener('mouseleave', () => {
    if (!state.autoHide) return;
    revealSidebar(false);
    hideChrome();
  });

  window.addEventListener('resize', syncTopbarHeight);
}

async function saveConfig(patch) {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: patch }),
    });
  } catch (err) {
    /* 忽略 */
  }
}

/** 源地址预处理：去空白、去重复协议前缀，避免把拼坏的地址发给后端。 */
function normalizeSourceInput(raw) {
  let url = String(raw || '').trim();
  if (!url) return { error: '请先粘贴源地址' };
  // 形如 http://a:18787http://a:18787 —— 输入框被覆盖续写时会出现
  const dup = url.match(/^(https?:\/\/[^\s]*?)(https?:\/\/.+)$/i);
  if (dup) url = dup[2];
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w.-]+(:\d+)?(\/|$)/.test(url)) url = `http://${url}`;
    else return { error: `源地址格式不对：${url}` };
  }
  if (/\s/.test(url)) return { error: '源地址里不能有空格' };
  return { url };
}

/* ---------------------------------------------------------------- 导入 */

async function doImport(autoplay, opts = {}) {
  const parsed = normalizeSourceInput($('srcInput').value);
  if (parsed.error) {
    if (!opts.silent) {
      toast(parsed.error, true);
      $('srcInput').focus();
    }
    return;
  }
  const url = parsed.url;
  if ($('srcInput').value.trim() !== url) $('srcInput').value = url;

  if (state.busy) return;
  state.busy = true;
  state.loading = true;
  if (!state.channels.length) renderChannels();
  $('btnImport').disabled = true;
  $('btnPlay').disabled = true;
  setStatus(opts.silent ? '正在恢复上次的频道…' : '正在读取源…', 'busy');
  setBadge('读取中…', 'busy');
  try {
    const r = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || '导入失败');

    state.kind = data.kind;
    state.sourceUrl = data.url;
    state.hub = data.hub;
    state.groups = data.groups || [];
    state.enriched = !!data.enriched;

    // 恢复上次播放的频道：先定好 currentId，再渲染，行才能带上选中态
    const restore = state.pendingRestoreKey
      ? (data.channels || []).find((c) => c.favKey === state.pendingRestoreKey)
      : null;
    if (restore) state.currentId = restore.id;
    state.pendingRestoreKey = '';

    applyChannels(data.channels || []);
    if (restore) {
      highlightRow(restore.id);
      $('nowPlaying').textContent = restore.name;
    }

    $('srcInput').value = data.url;
    const hubName = data.hub && data.hub.meta ? `${data.hub.meta.name} v${data.hub.meta.version}` : 'M3U 源';
    $('hubLabel').textContent = hubName;

    setStatus(`${data.total} 频道 · ${data.playable} 可播`, 'ok');
    setBadge(`已加载 ${data.total}`, 'ok');
    toast(`导入成功：${data.total} 个频道（${data.playable} 个可播），耗时 ${data.elapsedMs} ms`);

    if (autoplay) {
      const first = state.channels.find((c) => c.playableCount > 0);
      if (first) playChannel(first.id);
      else showError('没有可播放的频道', '该源里没有浏览器能直接解码的线路。');
    }

    if (data.canEnrich && !state.enriched) enrichInBackground();
  } catch (err) {
    setStatus('导入失败', 'err');
    setBadge('导入失败', 'busy');
    showError('导入失败', escapeHtml(String(err.message || err)));
    toast(`导入失败：${err.message}`, true);
  } finally {
    state.busy = false;
    state.loading = false;
    $('btnImport').disabled = false;
    $('btnPlay').disabled = false;
    if (!state.channels.length) renderChannels();
  }
}

/**
 * 后台补全元信息（台标 / 测速 / 线路数）。
 * iptv-hub 的 /api/channels 很慢（两万多行排序），并发只能压到 2，
 * 全量大约 40 秒，所以绝不能阻塞界面。
 */
async function enrichInBackground() {
  setBadge('补全元信息…', 'busy');
  try {
    const r = await fetch('/api/enrich', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || '补全失败');
    const info = data.enrich || {};
    state.enriched = !!data.enriched;
    applyChannels(data.channels || [], true);
    const withLogo = state.channels.filter((c) => c.logo).length;
    const withSpeed = state.channels.filter((c) => typeof c.speed === 'number').length;
    setBadge(`元信息 ${withLogo} 台标 / ${withSpeed} 测速`, 'ok');
    toast(`元信息补全完成：匹配 ${info.matched || 0} 个频道，用时 ${Math.round((info.elapsedMs || 0) / 1000)} 秒`);
  } catch (err) {
    setBadge(state.channels.length ? `已加载 ${state.channels.length}` : '未加载', 'ok');
    toast(`元信息补全失败（不影响播放）：${err.message}`, true);
  }
}

/** 用新的频道数组刷新界面，尽量保持滚动位置与当前选中。 */
function applyChannels(channels, keepScroll) {
  const list = $('channelList');
  const scrollTop = keepScroll ? list.scrollTop : 0;
  state.channels = channels;
  state.renderedRange = null;   // 数据换了，虚拟窗口必须重算
  // 修正收藏标记
  for (const c of channels) c.favorite = starFor(c.favKey);
  renderGroups();
  list.scrollTop = scrollTop;
  renderChannels();
}

/* ---------------------------------------------------------------- 渲染 */

function renderGroups() {
  const wrap = $('groupChips');
  const counts = new Map();
  for (const c of allChannels()) counts.set(c.group, (counts.get(c.group) || 0) + 1);
  const favCount = state.channels.filter((c) => c.favorite).length;

  const parts = [];
  const total = allChannels().length;
  parts.push(`<div class="chip ${state.group === '全部' ? 'on' : ''}" data-group="全部">全部<span class="n">${total}</span></div>`);
  if (state.locals.length) {
    const localOn = state.group === LOCAL_GROUP;
    parts.push(`<div class="chip ${localOn ? 'on' : ''}" data-group="${LOCAL_GROUP}">📂 ${LOCAL_GROUP}<span class="n">${state.locals.length}</span></div>`);
  }
  parts.push(`<div class="chip ${state.group === '__fav__' ? 'on' : ''}" data-group="__fav__">★ 收藏<span class="n">${favCount}</span></div>`);
  for (const g of state.groups) {
    if (!counts.has(g.name) && g.count < 1) continue;
    const n = counts.get(g.name) || 0;
    if (n === 0) continue;
    parts.push(
      `<div class="chip ${state.group === g.name ? 'on' : ''}" data-group="${escapeAttr(g.name)}">${escapeHtml(g.name)}<span class="n">${n}</span></div>`
    );
  }
  wrap.innerHTML = parts.join('');
}

const LOCAL_GROUP = '本地视频';

/** 本地文件与网络频道合成一个列表；本地条目永远排在最前。 */
function allChannels() {
  return state.locals.length ? state.locals.concat(state.channels) : state.channels;
}

/**
 * 打开本地视频文件（来自文件对话框或拖拽）。
 * 后端用 ffprobe 探测后定档：direct 直出 / remux 换壳 / transcode 转码。
 */
async function openLocalPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  setStatus('正在分析本地文件…', 'busy');
  try {
    const r = await fetch('/api/local/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: list, caps: capsForServer() }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || '打开失败');

    for (const o of d.opened || []) {
      if (state.locals.some((x) => x.localId === o.id)) continue;
      state.locals.push(localEntryFrom(o));
    }
    renderGroups();
    invalidateList();

    const tierText = { direct: '直接播放', remux: '只需换壳', transcode: '需要转码' };
    if (d.opened && d.opened.length) {
      setStatus(`本地文件 ${state.locals.length} 个`, 'ok');
      toast(`已加入 ${d.opened.length} 个文件（${tierText[d.opened[0].tier] || d.opened[0].tier}）` +
            (d.opened.length === 1 ? `：${d.opened[0].reason}` : ''));
    }
    for (const f of d.failed || []) {
      toast(`打不开 ${String(f.path).split(/[\\/]/).pop()}：${f.error}`, true);
    }

    // 拖进来/选中就直接开播第一个，符合「拖进去就播」的预期
    // （之前要求「当前没在播」才自动播，导致正在看频道时拖文件进去毫无反应）
    if (d.opened && d.opened.length) {
      const first = state.locals.find((x) => x.localId === d.opened[0].id);
      if (first) playChannel(first.id);
    }
  } catch (err) {
    setStatus('打开本地文件失败', 'err');
    showError('打开本地文件失败', escapeHtml(String(err.message || err)));
  }
}

function localEntryFrom(o) {
  const TIER = { direct: '直接播放', remux: '换壳', transcode: '转码' };
  const v = o.video && o.video.width
    ? `${o.video.width}×${o.video.height} ${String(o.video.codec || '').toUpperCase()}`
    : '';
  const bits = ['本地', TIER[o.tier] || o.tier];
  if (v) bits.push(v);
  if (o.duration > 0) bits.push(fmtTime(o.duration));
  return {
    id: `local:${o.id}`,
    localId: o.id,
    local: true,
    direct: !!o.direct,
    tier: o.tier,
    path: o.path,
    name: o.name,
    group: LOCAL_GROUP,
    logo: '',
    speed: null,
    streamCount: 1,
    lineCount: 1,
    playableCount: 1,
    kind: 'local',
    sources: '',
    favorite: false,
    favKey: `localfile::${o.id}`,
    subText: bits.filter(Boolean).join(' · '),
  };
}

/** 秒 → mm:ss / h:mm:ss */
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

/**
 * 筛选条件或数据变了，虚拟窗口必须失效，否则会跳过重绘显示陈旧列表。
 * resetScroll：搜索/切分组要回到顶部；仅改收藏状态时不动滚动位置。
 */
function invalidateList(resetScroll = true) {
  if (resetScroll) {
    const list = $('channelList');
    list.scrollTop = 0;
  }
  state.renderedRange = null;
  renderChannels();
}

function visibleChannels() {
  const q = state.query.trim().toLowerCase();
  return allChannels().filter((c) => {
    if (state.group === '__fav__') {
      if (!c.favorite) return false;
    } else if (state.group !== '全部' && c.group !== state.group) {
      return false;
    }
    if (q && !c.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** 单行频道的 HTML。 */
function channelRowHtml(c) {
  const dead = c.playableCount === 0;
  const speed = fmtSpeed(c.speed);
  const parts = [];
  parts.push(`<div class="ch ${c.id === state.currentId ? 'on' : ''} ${dead ? 'dead' : ''}" data-id="${c.id}">`);
  if (c.logo) {
    parts.push(`<img class="ch-logo" loading="lazy" alt="" src="${escapeAttr(c.logo)}">`);
  } else {
    parts.push('<div class="ch-logo-fallback">TV</div>');
  }
  parts.push('<div class="ch-main">');
  parts.push(`<div class="ch-name">${c.local ? '🎬 ' : ''}${escapeHtml(c.name)}</div>`);
  let sub;
  if (c.subText) {
    sub = c.subText;
  } else {
    const arr = [c.group];
    if (c.lineCount > 1) arr.push(`${c.lineCount} 线路`);
    if (c.sources) arr.push(String(c.sources).split(',').length + ' 源');
    sub = arr.join(' · ');
  }
  parts.push(`<div class="ch-sub">${escapeHtml(sub)}</div>`);
  parts.push('</div>');
  parts.push('<div class="ch-side">');
  if (!c.local) {
    parts.push(`<span class="star ${c.favorite ? 'on' : ''}" data-fav="${c.id}" title="收藏">${c.favorite ? '★' : '☆'}</span>`);
  }
  if (c.local) {
    const cls = c.tier === 'direct' ? 'fast' : c.tier === 'remux' ? '' : 'slow';
    parts.push(`<span class="tag ${cls}">${c.tier === 'direct' ? '直出' : c.tier === 'remux' ? '换壳' : '转码'}</span>`);
  } else if (dead) parts.push('<span class="tag bad">不支持</span>');
  else if (speed) parts.push(`<span class="tag ${speedTagClass(c.speed)}">${speed}</span>`);
  else if (c.streamCount > 1) parts.push(`<span class="tag">${c.streamCount} 线</span>`);
  parts.push('</div>');
  parts.push('</div>');
  return parts.join('');
}

/**
 * 虚拟滚动。
 *
 * 两千多个频道一次性塞进 DOM 会产生 500ms 量级的主线程长任务（实测 547ms），
 * 界面就是在这段时间里「卡住」的。这里只渲染视口内的几十行，
 * 上下用等高空 div 撑住滚动条高度，滚动时按 rAF 重算窗口。
 */
const ROW_H = 48;      // 必须和 style.css 里 .ch 的高度一致
const OVERSCAN = 6;    // 视口上下各多渲染几行，滚动时不留白

function renderChannels() {
  const list = $('channelList');
  const items = visibleChannels();
  state.visible = items;

  if (!items.length) {
    state.renderedRange = null;
    // 空列表分两种情况：正在加载 / 真的没匹配。
    // 都写「没有匹配的频道」的话，启动自动恢复那几秒看起来就像卡死了。
    list.innerHTML = state.loading
      ? '<div class="list-hint"><div class="ring ring-sm"></div><span>正在读取频道列表…</span></div>'
      : '<div class="list-hint"><span>没有匹配的频道</span></div>';
    $('countLabel').textContent = `${items.length} / ${allChannels().length} 个条目`;
    return;
  }

  const viewH = list.clientHeight || 640;
  // 关键：列表被过滤变短后，原来的滚动位置可能已经超出内容高度。
  // 不收敛的话 start 会大于 items.length，循环一次都不执行，
  // 结果只画出一个巨大的占位块、一行频道都没有（实测踩到过）。
  const maxScroll = Math.max(0, items.length * ROW_H - viewH);
  let scrollTop = list.scrollTop;
  if (scrollTop > maxScroll) {
    scrollTop = maxScroll;
    list.scrollTop = scrollTop;
  }
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  // 窗口没变就不用重画（滚动时避免无意义的重复渲染）
  const range = `${start}:${end}`;
  if (state.renderedRange === range && list.childElementCount) {
    $('countLabel').textContent = `${items.length} / ${allChannels().length} 个条目`;
    return;
  }
  state.renderedRange = range;

  const html = [];
  if (start > 0) html.push(`<div class="vpad" style="height:${start * ROW_H}px"></div>`);
  for (let k = start; k < end; k += 1) html.push(channelRowHtml(items[k]));
  if (end < items.length) html.push(`<div class="vpad" style="height:${(items.length - end) * ROW_H}px"></div>`);

  list.innerHTML = html.join('');
  list.scrollTop = scrollTop;   // 撑高后重新定位，避免跳回顶部
  $('countLabel').textContent = `${items.length} / ${allChannels().length} 个条目`;
}

/** 把某一行滚进视野并高亮（虚拟滚动下行可能还没被渲染出来）。 */
function scrollRowIntoView(id) {
  const list = $('channelList');
  const list2 = state.visible || [];
  // 1.4.1 起 id 允许是字符串（本地视频是 "local:xxx"、点列表行传的是 dataset.id），
  // 这里还留着严格 === 会让 string 与 number 永不相等，导致点完频道列表不自动定位到该行。
  const idx = list2.findIndex((c) => String(c.id) === String(id));
  if (idx < 0) return;
  const top = idx * ROW_H;
  const viewH = list.clientHeight || 640;
  if (top < list.scrollTop || top + ROW_H > list.scrollTop + viewH) {
    list.scrollTop = Math.max(0, top - viewH / 2 + ROW_H / 2);
    state.renderedRange = null;
    renderChannels();
  }
}

function highlightRow(id) {
  scrollRowIntoView(id);
  for (const el of document.querySelectorAll('.ch.on')) el.classList.remove('on');
  const el = document.querySelector(`.ch[data-id="${id}"]`);
  if (el) {
    el.classList.add('on');
    el.scrollIntoView({ block: 'nearest' });
  }
}

/** 线路格式的可读名称。 */
const KIND_LABEL = {
  hls: 'HLS',
  rawts: '裸TS',
  flv: 'FLV',
  file: '文件',
  audio: '音频',
  rtsp: 'RTSP',
  rtmp: 'RTMP',
  unsupported: '不支持',
  unknown: '未知',
};

/** 线路的中文序号：线路一 … 线路十，之后用数字。 */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function lineLabel(n) {
  return n <= 10 ? `线路${CN_NUM[n]}` : `线路${n}`;
}

function renderLinePanel() {
  const panel = $('linePanel');
  if (!state.lines.length) {
    panel.classList.add('hidden');
    return;
  }
  const rows = state.lines.map((l, i) => {
    const dead = !l.playable;
    const failed = state.failures.has(i);
    const current = i === state.currentLine;
    const speed = fmtSpeed(l.speed);
    const meta = [KIND_LABEL[l.kind] || l.kind.toUpperCase()];
    if (speed) meta.push(speed);
    // 顺手把「这个流需要多少带宽」和「够不够」摆出来：
    // 1080p 常见 8~13 Mbps，比实测吞吐还高的话这条线路怎么调缓冲都没用。
    const br = lineBitrateCache.get(l.url) || 0;
    if (br) meta.push(`${(br / 1e6).toFixed(1)} Mbps`);
    if (l.speed && br && l.speed * 1024 * 8 < br * 1.15) meta.push('⚠️ 带宽不够');

    /*
     * 编码也标出来 —— 这是「为什么这条线路播不了」最直接的答案。
     * 探到是 MPEG-2 这类 Chromium 没有解码器的，就在行上直接写明「需转码」，
     * 用户一眼能看出不是网络问题、也不是线路坏了。
     */
    const cv = codecCache.get(l.url);
    if (cv) {
      meta.push(describeCodec(cv));
      const verdict = codecVerdict(cv);
      if (verdict && verdict.tier === 'ffmpeg') meta.push('需转码');
      else if (cv.tier === 'remux') meta.push('换壳');
      else if (cv.tier === 'direct') meta.push('直出');
    }

    // 失败原因也显示出来 —— 否则用户只看到「已失败」，不知道是编码不支持、
    // 还是连不上、还是带宽不够，没法判断该换线路还是换源。
    const why = failed ? state.failReasons.get(i) : '';
    const status = dead ? '不支持' : failed ? (why ? `已失败：${why}` : '已失败') : current ? '播放中' : '';
    const cls = ['line-item'];
    if (current && !dead && !failed) cls.push('on');
    if (dead || failed) cls.push('dead');

    // 地址不铺在界面上（太长太乱），需要排查时鼠标悬停就能看到
    return (
      `<div class="${cls.join(' ')}" data-line="${i}" title="${escapeAttr(l.url)}">` +
      `<span class="line-idx">${i + 1}</span>` +
      `<span class="line-name">${lineLabel(i + 1)}</span>` +
      `<span class="line-meta">${escapeHtml(meta.join(' · '))}</span>` +
      (l.source ? `<span class="line-src">${escapeHtml(l.source)}</span>` : '<span class="line-src"></span>') +
      (status ? `<span class="line-status ${dead || failed ? 'bad' : 'live'}">${status}</span>` : '') +
      `</div>`
    );
  });
  panel.innerHTML = rows.join('');
}

/* ------------------------------------------------- 编码判定（能不能直解） */

/**
 * 这一整块只解决一件事：**Chromium 从根上没有这个解码器**。
 *
 * 源里大量线路是 MPEG-2 视频 + MP2 音频（实测 CCTV13：`110.72.x.x:808/hls/106`
 * 是 mpeg2video 720×576 / mp2）。Chromium 不带 MPEG-2 解码器，hls.js 连分片
 * 都解不出来 —— 但它们是**能连上**的，所以既不会进「已失败」，也就永远触发不了
 * ffmpeg 兜底，界面上只能一直转圈。
 *
 * 手机端的 ok影视 / 飞牛影视、PC 端的 VLC / PotPlayer 能播，正是因为它们的解码器
 * 来自 libav/系统，自带 MPEG-2。我们的答案不是再写一个解码器，而是把这件事
 * **在播放之前就问清楚**，能直解就直解，不能就让内置 ffmpeg（同一个 libav）接管。
 */
const codecCache = new Map();   // url → { video, audio, tier, reason } | null

/** 问本地服务：这条线路的真实编码是什么（ffprobe，实测 0.46 秒）。 */
async function probeLineCodec(line, timeoutMs = 12000) {
  if (!line || !line.url) return null;
  if (codecCache.has(line.url)) return codecCache.get(line.url);

  const q = new URLSearchParams({ u: line.url });
  if (line.ref) q.set('r', line.ref);
  if (line.ua) q.set('ua', line.ua);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let verdict = null;
  try {
    const r = await fetch(`/api/codec?${q.toString()}`, { signal: controller.signal });
    const d = await r.json();
    if (d && d.ok) {
      verdict = { video: d.video, audio: d.audio, tier: d.tier, reason: d.reason };
    }
  } catch (err) {
    /* 探测失败不能当成「播不了」：让它照常走 hls.js，试不出来再兜底 */
  } finally {
    clearTimeout(timer);
  }
  // 探测失败不写缓存，下次还有机会重问；成功结果按 URL 存下来
  if (verdict) codecCache.set(line.url, verdict);
  return verdict;
}

const CODEC_LABEL = {
  mpeg2video: 'MPEG-2', h264: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1',
  vp8: 'VP8', vp9: 'VP9', vc1: 'VC-1', mpeg4: 'MPEG-4', flv1: 'H.263',
  aac: 'AAC', mp2: 'MP2', mp3: 'MP3', ac3: 'AC-3', eac3: 'E-AC-3',
  dts: 'DTS', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', pcm_s16le: 'PCM',
};

function codecText(c) {
  if (!c) return '';
  return CODEC_LABEL[String(c).toLowerCase()] || String(c).toUpperCase();
}

/** 人读的编码串，例如 "MPEG-2 720×576 / MP2"。 */
function describeCodec(cv) {
  if (!cv) return '';
  const v = cv.video
    ? `${codecText(cv.video.codec)}${cv.video.width ? ` ${cv.video.width}×${cv.video.height}` : ''}`
    : '无视频';
  const a = cv.audio ? codecText(cv.audio.codec) : '无音频';
  return `${v} / ${a}`;
}

/**
 * 问 Chromium 自己：这个编码你解得了吗？
 *
 * `MediaSource.isTypeSupported()` 是权威判据 —— MSE 不认的编码，
 * hls.js/mpegts.js 全都白搭，没有任何「换个引擎再试试」的余地。
 * 直接问它比让播放器撞 20 秒超时再失败快得多，也不会把能播的线路误判成坏线路。
 */
function chromiumCanDecode(videoCodec, audioCodec) {
  const v = String(videoCodec || '').toLowerCase();
  const a = String(audioCodec || '').toLowerCase();
  const VCODES = { h264: 'avc1.42E01E', hevc: 'hvc1.1.6.L93.B0', av1: 'av01.0.04M.08' };
  const ACODES = { aac: 'mp4a.40.2', mp3: 'mp4a.40.34', opus: 'opus', flac: 'flac' };

  if (v) {
    if (!VCODES[v]) return false;               // mpeg2video / vc1 / mpeg4 … 没有解码器
    if (!window.MediaSource || !MediaSource.isTypeSupported(`video/mp4; codecs="${VCODES[v]}"`)) {
      return false;
    }
  }
  if (a) {
    if (!ACODES[a]) return false;               // mp2 / ac3 / dts … 没有解码器
    if (!window.MediaSource || !MediaSource.isTypeSupported(`audio/mp4; codecs="${ACODES[a]}"`)) {
      return false;
    }
  }
  return true;
}

/**
 * 这条线路该走哪条路。返回 null 表示「探测不出结论，按老流程试」。
 *
 *   direct    视频/音频 Chromium 都认识 → hls.js 直解（最省 CPU，优先）
 *   ffmpeg    有编码 Chromium 没有解码器 → 直接交给内置 ffmpeg 转码，别浪费 20 秒
 *
 * 用户把解码方式手动切成「软件解码」时不走 direct：那时 Chromium 连 H.264
 * 都故意关了硬解，直解档一样放不出来，转码交给 ffmpeg 才是他想要的效果。
 */
function codecVerdict(cv) {
  if (!cv) return null;
  const v = cv.video && cv.video.codec;
  const a = cv.audio && cv.audio.codec;
  if (state.decodeMode === 'software') {
    return { tier: 'ffmpeg', reason: '解码方式已设为软件解码，交给 ffmpeg 转码' };
  }
  if (chromiumCanDecode(v, a)) return { tier: 'direct', reason: '' };
  const missing = [];
  if (v && !chromiumCanDecode(v, null)) missing.push(`视频 ${codecText(v)}`);
  if (a && !chromiumCanDecode(null, a)) missing.push(`音频 ${codecText(a)}`);
  return {
    tier: 'ffmpeg',
    reason: `Chromium 没有${missing.join('、')}解码器（VLC/PotPlayer 自带）`,
  };
}

/**
 * 给候选线路批量探测编码。
 *
 * 只探前几条：播放真正会用的就是排序后的前几名，没必要为几十条线路各花半秒。
 * 并发 4，既有速度又不至于把 ffprobe 开成一片。
 */
async function probeLineCodecs(indices) {
  const want = indices.filter((i) => {
    const l = state.lines[i];
    return l && l.playable && l.url && !codecCache.has(l.url);
  }).slice(0, 5);
  if (!want.length) return;
  const CONC = 4;
  for (let i = 0; i < want.length; i += CONC) {
    await Promise.all(want.slice(i, i + CONC).map((i2) => probeLineCodec(state.lines[i2])));
  }
}

/**
 * 启动自检：内置的 ffmpeg / ffprobe 在不在、能不能跑。
 *
 * 这一步是必需的，不是保险：**MPEG-2 这类线路全靠内置 ffmpeg 转码才能播**。
 * 而随包的是共享库版 ffmpeg（一堆 dll），在个别机器上会被杀软或组策略拦掉。
 * 一旦它起不来，用户看到的就是「点什么都播不了、界面还不说话」——
 * 最坏的那种故障。所以启动就把结论摆出来。
 */
async function checkFfmpegTools() {
  try {
    const d = await (await fetch('/api/local/tools')).json();
    state.ffmpegTools = d;
    diagPush('env', `内置 ffmpeg=${d.ffmpegVersion || '不可用'} ffprobe=${d.ffprobeVersion || '不可用'}`,
      d.ffmpegVersion && d.ffprobeVersion ? 'ok' : 'err');
    if (!d.ffmpegVersion || !d.ffprobeVersion) {
      const missing = [
        d.ffmpegVersion ? null : 'ffmpeg',
        d.ffprobeVersion ? null : 'ffprobe',
      ].filter(Boolean).join(' / ');
      toast(
        `内置 ${missing} 不可用，MPEG-2 这类需要转码的线路将无法播放。` +
        '可能是杀毒软件拦截了随包的 ffmpeg，把 HubPlay 目录加入白名单后重启试试。',
        true
      );
    }
    return d;
  } catch (err) {
    /* 本地服务还没起来时不该阻塞界面 */
    return null;
  }
}

/* ---------------------------------------------------------------- 播放 */

/**
 * 无扩展名的地址光看 URL 猜不出协议（源里 645 条，实测约三分之一是 FLV、
 * 五分之一是 HLS）。播放前问一下本地服务的 /api/sniff，只读开头一小段就能定性，
 * 比让 hls.js 撞 20 秒超时再换引擎快得多。结果按地址缓存，重播不再探测。
 */
const sniffCache = new Map();

async function sniffLine(line, { preflight = false, timeoutMs = 8000 } = {}) {
  const key = (preflight ? 'pf:' : 'k:') + line.url;
  if (sniffCache.has(key)) return sniffCache.get(key);

  const q = new URLSearchParams({ u: line.url });
  if (line.ref) q.set('r', line.ref);
  if (line.ua) q.set('ua', line.ua);
  if (preflight) q.set('preflight', '1');

  /*
   * 探测失败要区分「源抖了一下」和「这条线路真的是死的」。
   * 前者重试一次，后者必须**记住结论并带上原因** —— 老写法把 dead 直接吞成
   * 'unknown' 且不写缓存，于是同一条死线会被反复探测，面板上还只留一个
   * 和真实原因无关的报错（用户截图里就是「未知 / FLV 解码失败」）。
   */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(`/api/sniff?${q.toString()}`, { signal: controller.signal });
      const d = await r.json();
      const kind = d && d.ok && d.kind ? d.kind : 'unknown';
      if (kind === 'dead') {
        const res = { kind: 'dead', reason: (d && d.reason) || '源不可用' };
        sniffCache.set(key, res);
        return res;
      }
      if (kind !== 'unknown') {
        const res = { kind, reason: '' };
        sniffCache.set(key, res);
        return res;
      }
    } catch (err) {
      /* 超时/网络问题，再试一次 */
    } finally {
      clearTimeout(timer);
    }
  }
  return { kind: 'unknown', reason: '' };
}

async function refineLineKind(line, timeoutMs = 8000) {
  if (line.kind !== 'unknown') return line.kind;
  const hit = await sniffLine(line, { timeoutMs });
  return hit.kind === 'dead' ? 'unknown' : hit.kind;
}

/**
 * 量一条 HLS 线路的直播窗口。
 *
 * 这是整个播放策略的地基：窗口有多长，决定我们能在直播边缘后面站多远、
 * 前向缓冲能有多深。详见 livewin.js 顶部说明。
 *
 * 播放列表本身很小（实测 597 字节），走的是和播放同一个 /p 代理，
 * 所以量的就是「播放时真正会拿到的那个列表」。
 * 窗口长度对同一条线路基本不变（上游配置决定分片数），因此缓存 10 分钟。
 */
const liveWindowCache = new Map();   // url -> { at, win }
const LIVE_WINDOW_TTL = 10 * 60 * 1000;

async function measureLiveWindow(line, timeoutMs = 8000) {
  if (!line || line.kind !== 'hls') return null;
  const hit = liveWindowCache.get(line.url);
  if (hit && Date.now() - hit.at < LIVE_WINDOW_TTL) return hit.win;

  const q = new URLSearchParams({ u: line.url });
  if (line.ref) q.set('r', line.ref);
  if (line.ua) q.set('ua', line.ua);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`/p?${q.toString()}`, { signal: controller.signal });
    if (!r.ok) return null;
    const text = await r.text();
    const win = LiveWin.parseLiveWindow(text);
    if (!win.ok) return null;
    liveWindowCache.set(line.url, { at: Date.now(), win });
    return win;
  } catch (err) {
    return null;   // 量不到就回退到静态档位，不影响播放
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ffmpeg 自产 HLS 的直播方案。
 *
 * 这条路的窗口是**我们自己定的**：`-hls_time 2` + `-hls_list_size 24` = 48 秒。
 * 但实测发现它在 makeHlsConfig 里走的是"不传 plan → 点播宽松档"那条分支，
 * 于是 hls.js 拿着「maxBufferLength 几百秒」的配置去播一个 48 秒窗口的直播，
 * 等于没限制：播放头敢站在离直播边缘很远的地方，而那片区域 ffmpeg 还没编出来，
 * 表现就是缓冲长期只剩 1~3 秒、每隔几秒顿一下（01:25 日志里的 buf 曲线）。
 *
 * 所以这里显式给一个窗口：分片数取「列表里真实存在的」和 12 的较大值
 * （ffmpeg 刚起步时列表只有几片，取 12 才不至于把预算算得太小）。
 */
const FFMPEG_HLS_SEGMENT_SECONDS = 2;
/** 与 src/local.js 的 -hls_list_size 保持一致（48 秒窗口）。 */
const FFMPEG_HLS_LIST_SIZE = 24;
function ffmpegPlan() {
  /*
   * ⚠️ 这里**故意不看**列表里现有几片。
   *
   * 实测（01:29 日志）：ffmpeg 刚起时列表只有 6 片（=12 秒），把它当窗口算出来的方案是
   * 「退 2s / 前向 8.8s」—— 播放头很快就顶到窗口边缘，缓冲掉到 0.1 秒、连着两次
   * bufferStalledError。而列表随后会长到 24 片（48 秒），方案却已经定死。
   * 所以窗口用**我们自己定的 -hls_list_size**，这才是稳态真值。
   */
  const segments = FFMPEG_HLS_LIST_SIZE;
  const win = {
    ok: true, live: true, master: false, endList: false,
    targetDuration: FFMPEG_HLS_SEGMENT_SECONDS,
    segments,
    windowSeconds: segments * FFMPEG_HLS_SEGMENT_SECONDS,
  };
  /*
   * 把"退多远"放宽一倍（latencyShare 0.1 → 0.2，48 秒窗口 → 目标延迟 9.6 秒）。
   *
   * 实测（01:31 日志）：方案是「退 4s / 前向 39.2s」，按说缓冲足够；可播放头会突然
   * 往前跳（t=5.49 → 19.89），把刚缓起来的十几秒一次性吃掉，于是 buf 掉到 0.5 秒、
   * 报 bufferStalledError。这是 hls.js 的**直播边缘纠偏**在动作：
   *   目标延迟 4 秒、`maxLiveSyncPlaybackRate` 只有 1.08（8%），而转码吞吐实测只有
   *   1.79× 实时、播放端又在抢 CPU —— 8% 追不回来，于是它每几十秒就"跳"一次。
   * 转码档本来就是「宁可延迟大一点，也别顿」，所以让步给延迟：目标 9.6 秒，
   * 纠偏阈值也随之放宽，播放头不再被反复拽走。
   */
  const profile = Object.assign({}, bufferPreset(), { latencyShare: 0.2 });
  return LiveWin.planFromWindow(win, profile) || LiveWin.fallbackPlan(profile, { generous: true });
}

/** 按当前档位 + 量到的窗口算出这局要用的 hls.js 参数。 */
function livePlanFor(win) {
  const b = bufferPreset();
  // 带 ENDLIST 的是点播列表：不受直播窗口限制，可以放心多缓
  if (win && win.ok && win.endList) return LiveWin.fallbackPlan(b, { generous: true });
  return LiveWin.planFromWindow(win, b) || LiveWin.fallbackPlan(b);
}

/**
 * 按「源窗口」推算当前播放的实际参数，并把结论写进 state.livePlan。
 * 失败一律静默回退 —— 量窗口只是优化，不能让播放依赖它。
 */
async function prepareLivePlan(line, token) {
  if (!line || line.kind !== 'hls') {
    state.livePlan = null;
    state.liveWindow = null;
    return null;
  }
  const win = await measureLiveWindow(line);
  if (state.playToken !== token) return null;
  state.liveWindow = win;
  const plan = livePlanFor(win);
  state.livePlan = plan;
  return plan;
}

/**
 * 缓冲档位。
 *
 * **重要教训（2026-10 实测）**：直播里「调大缓冲」= 「把播放点往回挪」。
 * 这些源的分片列表只有 3~5 个分片（15~50 秒），播放点一旦落到窗口以外，
 * 要的分片就已经被上游删了。所以真正该做的是**把整个窗口切成
 * 「退多远 + 前向缓多深」两份预算**，而不是各自写死秒数：
 *   budgetShare  = 敢用掉多少窗口（留余量，绝不越界）
 *   latencyShare = 其中多少用来「离直播边缘远一点」，剩下的**全部**给前向缓冲
 *
 * 前向缓冲才是抗抖动的那部分，而缓冲 = 预算 − 延迟，所以 latencyShare 很小：
 * 默认只退 1 个分片，档位之间拉开的差距主要是 budgetShare（敢用多少窗口）。
 *
 * 下面的 seconds / liveSeconds 只在量不到窗口时兜底（主列表、探测失败）。
 * stash 的单位是**字节**（名字有误导）：mpegts.js 默认 65536、flv.js 默认 393216。
 */
const BUFFER_PRESETS = {
  low: {
    label: '追直播',
    hint: '最贴近直播边缘，源窗口很窄时最稳',
    budgetShare: 0.6, latencyShare: 0.08,
    liveSeconds: 12, liveSync: 1,
    seconds: 60, maxSeconds: 180, sizeMB: 150,
    stash: 262144,
  },
  balanced: {
    label: '平衡',
    hint: '默认：按源实际窗口自动分配缓冲',
    budgetShare: 0.9, latencyShare: 0.1,
    liveSeconds: 16, liveSync: 2,
    seconds: 60, maxSeconds: 180, sizeMB: 150,
    stash: 1048576,
  },
  stable: {
    label: '抗抖动',
    hint: '用满整个源窗口来换缓冲',
    budgetShare: 0.98, latencyShare: 0.12,
    liveSeconds: 24, liveSync: 2,
    seconds: 120, maxSeconds: 360, sizeMB: 400,
    stash: 3145728,
  },
};

function bufferPreset() {
  return BUFFER_PRESETS[state.bufferPreset] || BUFFER_PRESETS.balanced;
}

/**
 * 统一的 hls.js 配置，直播和本地转码共用。
 *
 * @param extra 额外/覆盖项
 * @param plan  livewin.js 算出的直播窗口方案；点播场景传 null，走静态档位值
 */
function makeHlsConfig(extra, plan) {
  const b = bufferPreset();
  // 不传 plan 的场景只有「本地转码 / ffmpeg 产出的 HLS」——那是点播性质，
  // 不受源窗口限制，所以默认走宽松值。直播路径一定会传 plan。
  const p = plan || LiveWin.fallbackPlan(b, { generous: true });
  return Object.assign({
    enableWorker: true,
    /*
     * 必须为 true —— 这不是「低延迟模式」开关，而是**追直播的开关**。
     *
     * hls.js 里 maxLiveSyncPlaybackRate 的生效条件是：
     *     if (config.lowLatencyMode && maxLiveSyncPlaybackRate !== 1 && details.live)
     * 也就是说 lowLatencyMode = false 时，我们设的 1.08 是**死配置，永远不会执行**。
     * 实测后果：播放点只会一路落后（稳的线路也以约 5 秒/分钟的速度漂远），
     * 十几分钟就能漂到 48 秒 —— 正是之前「前向缓冲 48.8 秒却一直卡」的来源。
     *
     * 对非 LL-HLS 的普通播放列表是安全的：hls.js 自己的默认值就是 true，
     * 所有 LL 专有分支（canBlockReload / partList）在没有分片级信息时都会跳过，
     * partEnd 也会回退到 fragmentEnd（已在 hls.js 源码里确认）。
     * 而且我们显式设了 liveSyncDurationCount，targetLatency 计算不受它影响。
     */
    lowLatencyMode: true,
    maxBufferLength: p.maxBufferLength,
    maxMaxBufferLength: p.maxMaxBufferLength,
    maxBufferSize: p.maxBufferSize,
    backBufferLength: p.backBufferLength,
    liveSyncDurationCount: p.liveSyncDurationCount,
    liveMaxLatencyDurationCount: p.liveMaxLatencyDurationCount,
    // 漂远了就温和提速追直播（最多 8%），而不是一路漂到几十秒外
    maxLiveSyncPlaybackRate: p.maxLiveSyncPlaybackRate,
    // 容忍时间空洞，避免为了补一个 0.1 秒的空隙反复 seek 造成卡顿
    maxBufferHole: 0.5,
    // hls.js 默认「缓冲空了」只 nudge 3 次（约 6 秒）就升级成 fatal 错误。
    // 对国内这些时快时慢的源来说太短了 —— 一升级就被上层当成「线路坏了」拉黑。
    nudgeMaxRetry: 12,
    nudgeOffset: 0.2,
    // 分片 404 是「这个分片已经被上游删了」，重试 6 次纯属浪费时间、
    // 而且这期间播放点还在继续落后。压到 2 次，尽快跳到下一个可用分片。
    fragLoadingMaxRetry: 2,
    fragLoadingRetryDelay: 400,
  }, extra || {});
}

/** 每种容器类型用哪个播放引擎；探测不出来的按可靠性依次试。 */
const ENGINE_CHAIN = {
  hls: ['hls'],
  rawts: ['mpegts'],
  flv: ['flv'],
  file: ['native'],
  audio: ['native'],
  unknown: ['hls', 'mpegts', 'flv'],
};
const ENGINE_LABEL = { hls: 'HLS', mpegts: '裸TS解码', flv: 'FLV解码', native: '原生播放' };

function enginesFor(kind) {
  return (ENGINE_CHAIN[kind] || ['hls']).slice();
}

function proxyUrl(line) {
  const p = new URLSearchParams();
  p.set('u', line.url);
  if (line.ref) p.set('r', line.ref);
  if (line.ua) p.set('ua', line.ua);
  return `${location.origin}/p?${p.toString()}`;
}

/**
 * 播放本地文件。
 * 直出档直接塞给 <video>（原生播放，进度条最准）；
 * 换壳/转码档走 HLS，用已有的 hls.js。
 */
async function playLocalEntry(entry) {
  const token = ++state.playToken;
  state.currentId = entry.id;
  state.mode = 'file';
  state.userPaused = false;
  state.lines = [];
  state.currentLine = -1;
  highlightRow(entry.id);
  hideError();
  applySidebar();
  saveConfig({ lastChannel: entry.favKey });

  $('nowPlaying').textContent = entry.name;
  $('controls').classList.remove('hidden');
  $('linePanel').classList.add('hidden');
  $('liveTag').classList.add('hidden');   // 本地文件不是直播
  $('osdTitle').textContent = entry.name;
  state.osdBase = entry.subText || '本地文件';
  $('osdSub').textContent = state.osdBase;
  $('osd').classList.remove('hidden');
  $('placeholder').classList.add('hidden');
  renderLinePanel();

  const hint = entry.tier === 'direct' ? '正在打开…'
    : entry.tier === 'remux' ? '正在换封装（视频直通，很快）…'
      : '正在转码成 H.264，长片要等一会儿…';
  setSpinner(true, hint);

  destroyPlayer();
  stopStallWatchdog();   // 本地文件不需要卡顿换线路

  if (entry.direct) {
    video.src = `/api/local/raw/${entry.localId}`;
    video.addEventListener('loadedmetadata', () => {
      if (state.playToken !== token) return;
      setSpinner(false);
      updateSeekBar();
    }, { once: true });
    video.addEventListener('error', () => {
      if (state.playToken !== token) return;
      setSpinner(false);
      showError('这个文件没能直接播放',
        '容器/编码判定可能不准。可以再拖一次试试，或换一个文件。<br>' +
        `文件：${escapeHtml(entry.name)}`);
    }, { once: true });
    video.play().catch(() => {});
    return;
  }

  const url = `/api/local/hls/${entry.localId}/index.m3u8`;
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls(makeHlsConfig({
      // 转码是一边转一边播，首次拿播放列表可能要等十几秒
      manifestLoadingTimeOut: 40000,
      manifestLoadingMaxRetry: 30,
      manifestLoadingRetryDelay: 800,
      levelLoadingTimeOut: 40000,
      levelLoadingMaxRetry: 20,
      fragLoadingTimeOut: 60000,
      fragLoadingMaxRetry: 20,
      fragLoadingRetryDelay: 1000,
    }));
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (state.playToken !== token || !data.fatal) return;
      // 转码还没产出，hls.js 会自己重试，别急着报错
      if (data.details === 'manifestLoadError' || data.details === 'levelLoadError') return;
      setSpinner(false);
      showError('本地转码播放失败', `${escapeHtml(data.details || data.type)}<br>文件：${escapeHtml(entry.name)}`);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.loadSource(url);
    hls.attachMedia(video);
    state.hls = hls;
    return;
  }

  video.src = url;
  video.play().catch(() => {});
}

/* -------------------------------------------------- ffmpeg 兜底播放 */

/**
 * 用 hls.js 播一条由本机 ffmpeg 产出的 HLS（本地转码 / 网络流兜底共用）。
 * kindLabel 用于界面提示。
 */
async function attachHlsHls(url, { token, name, kindLabel }) {
  /*
   * 接自己的 HLS 之前，先把 video 元素彻底清干净。
   *
   * 实测（2026-10-07 日志）：直解线路刚出画，紧接着切到 ffmpeg 转码档时，
   * hls.js 报 `mediaError/bufferAppendError fatal=true` —— 因为同一个
   * MediaSource 上还留着上一个 hls.js 的 SourceBuffer，新的 append 撞上去就失败。
   * destroyPlayer() 会 destroy 掉旧实例并 removeAttribute('src') + load()，
   * 把 MediaSource 真正释放掉。销毁当前实例是**安全**的：
   * 调用方（tryFfmpegFallback）拿到的是新会话，旧播放本来就要丢弃。
   */
  destroyPlayer();
  /*
   * 用自己的直播方案（窗口 = -hls_time × -hls_list_size），
   * 不再落进「不传 plan → 点播宽松档」那条分支。见 ffmpegPlan() 注释。
   *
   * ⚠️ 必须**先**拿到播放列表再 new Hls()：hls.js 的 config 是实例化时快照的，
   * 事后改 config 对象对已经建好的实例无效。所以这里主动读一次列表，
   * 把真实分片数喂给 ffmpegPlan()，一次就把参数配对。
   * 读不到也没关系（列表可能还没写出来）——ffmpegPlan(null) 会按 12 片保守起步。
   */
  /*
   * 目标延迟就是缓冲分配器 —— hls.js 只会加载到「比目标延迟稍多一点」的位置。
   * 所以想要 20 秒以上的前向缓冲，正解是直接把目标延迟设到 15 个分片（30 秒），
   * 而不是在播放器外面等列表变长。见 ffmpegPlan() 与下面的 ffmpegLatencySegments。
   */
  const readPlaylist = async (timeoutMs) => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), timeoutMs);
      const r = await fetch(url, { signal: c.signal, cache: 'no-store' });
      const n = r.ok ? ((await r.text()).match(/#EXTINF/g) || []).length : 0;
      clearTimeout(t);
      return n;
    } catch (err) { return 0; }
  };
  let listSegs = await readPlaylist(3000);
  if (state.playToken !== token) return;
  /*
   * 起播门槛很低：列表攒到 6 片（12 秒）就开播，最多等 6 秒。
   * 因为目标延迟只有 8 秒，hls.js 起播后会自动把缓冲往前填到 120 秒上限；
   * 源端产出约 1.35× 实时（实测），所以缓冲会持续上涨、越看越稳。
   */
  {
    /*
     * 起播门槛：列表攒到 10 片（20 秒内容）再开播。
     *
     * 为什么从 6 片提到 10：目标延迟是 8 秒，6 片时前向缓冲只剩 2~4 秒 ——
     * 实测起播后必然在 t≈8 处塌一次（02:18/02:21 日志都是这个形态），
     * 得靠重建 MediaSource 才恢复。有了预取缓存和 readrate 冲刺之后，
     * ffmpeg 几秒就能产出 20 秒内容，多等 2~4 秒就能一开播就带 10 秒以上缓冲，
     * 那次塌陷根本不会发生。
     */
    /*
     * 起播门槛：**3 片（6 秒）就开播，最多等 8 秒**（2026-10-10 深夜从 10 片/12 秒降下来）。
     *
     * 旧值是为「源比实时快（1.35×）」那类源调的；可有些 MP2 频道的源实测只有
     * **0.76× 实时**（2 秒内容要 2.6 秒才吐出来）——对它来说，等满 10 片（20 秒）
     * 等于先干等 20~30 秒，开播时手里又只有 8 秒余量，于是每几十秒就见底一次。
     * 用户的原话就是「需要转码的都播放不了」。
     *
     * 现在改成「手里有一点就开播」，剩下的缓冲让它在播放中自然长起来。
     */
    const need = 3;
    const deadline = Date.now() + 8000;
    let lastLogged = -1;
    while (listSegs < need && Date.now() < deadline) {
      if (state.playToken !== token) return;
      const secs = listSegs * FFMPEG_HLS_SEGMENT_SECONDS;
      setSpinner(true, `正在起播（已就绪 ${secs} / ${need * FFMPEG_HLS_SEGMENT_SECONDS} 秒，最多等 12 秒）…`);
      if (secs !== lastLogged) {
        lastLogged = secs;
        diagPush('hls-ffmpeg', `起播等待：列表已就绪 ${secs} 秒（目标 ${need * FFMPEG_HLS_SEGMENT_SECONDS} 秒）`);
      }
      await new Promise((res) => setTimeout(res, 400));
      if (state.playToken !== token) return;
      listSegs = await readPlaylist(2000);
    }
    const secs = listSegs * FFMPEG_HLS_SEGMENT_SECONDS;
    diagPush('hls-ffmpeg', `起播就绪：${secs} 秒内容（目标延迟 8 秒，缓冲上限 120 秒，` +
      `${listSegs >= need ? '达标即开播' : '超时按现有开播'}）`, 'ok');
    if (state.playToken !== token) return;
  }
  const plan = ffmpegPlan();
  /*
   * 三个量和目标延迟一起对齐（hls.js 里它们互相咬合）：
   *   liveSyncDurationCount     —— 起播时站在离边缘多少个分片（= 目标延迟）
   *   liveMaxLatencyDurationCount —— 超过它就纠偏拉回边缘；太紧会变成"每几十秒跳一次"
   *   maxLiveSyncPlaybackRate   —— 靠提速追直播的能力；8% 追不回 1.79× 实时那种压力
   */
  /*
   * 目标延迟 = 15 个分片 = 30 秒。这是「把前向缓冲攒起来」的唯一正确旋钮：
   * hls.js 只加载到比目标延迟稍多一点的位置，所以要 20 秒以上缓冲，就得把目标延迟调大。
   *
   * 实测的上游节奏是「每 10~14 秒稳定亏 2.2 秒、偶尔一次亏 6 秒」，
   * 所以算上 30 秒延迟 + 40 秒缓冲，才能连续吃掉好几次空档而不见底。
   * 代价：画面比直播晚约 30 秒（VLC 播这种源实际也是几十秒延迟）。
   */
  /*
   * ⚠️ 目标延迟要**小**、缓冲上限要**大** —— 这一条是拿实测数据推出来的。
   *
   * 实测上游（2026-10-07 连续 45 秒观察）：每 4.8 秒发布一个新分片，
   * 而每片是 4~7.6 秒内容 → **源端产出 ≈ 1.35× 实时**，比播放快。
   * 既然如此，缓冲本来就该越攒越多。之所以没有，是因为 hls.js 的加载上限是
   *     加载上限 = 直播边缘 − 目标延迟 + maxBufferLength
   * 上一版是 边缘 − 30 + 33 = 边缘 + 3 秒 —— 等于把源端多出来的余量全部丢掉，
   * 缓冲永远停在 30 多秒，所以每遇到一次上游停顿就见底。
   *
   * 现在反着来：目标延迟 8 秒（起播快、贴近直播），缓冲上限 120 秒，
   * 加载上限就变成 边缘 + 112 秒 —— 源端只要还在 1.35× 生产，缓冲就一路涨，
   * 攒出来的余量足以吃掉后面所有停顿，而且越看越稳。
   */
  /*
   * ⚡ 起播位置 = **手里已有的最早那一片**（2026-10-10 深夜翻过来）。
   *
   * 旧策略是「站在离直播边缘 4 片（8 秒）处起播」——那适合"源比实时快"的源。
   * 但对 0.76× 实时的慢源，它等于把唯一的余量扔掉：开播瞬间前向缓冲只有 8 秒，
   * 而源每 2.6 秒才吐 2 秒内容，几十秒后必然见底。
   *
   * PotPlayer / mpv 遇到这种源的做法简单得多：**立刻从手里已有的最早一片开播**，
   * 落后就落后，绝不往前跳。这样开播时前向缓冲 = 已发布的整个窗口（十几到几十秒），
   * 源慢只是慢慢把这笔余量吃回去，观感上就是"一直在播"。
   */
  const startBehindSegs = Math.max(2, Math.min(listSegs || 2, 60));
  plan.liveSyncDurationCount = startBehindSegs;
  plan.targetLatency = startBehindSegs * FFMPEG_HLS_SEGMENT_SECONDS;
  plan.maxBufferLength = 120;         // 让缓冲有地方涨
  plan.maxMaxBufferLength = 120;
  plan.backBufferLength = 60;         // 落后时也别把已播的丢掉（回看/重挂要能取回）
  /*
   * 关键：**不再"追直播"**。
   *
   * 配合 local.js 把播放列表改成 EVENT 型（只增不减），分片永远还能取回来，
   * 于是"落后了"根本不需要靠往前跳来解决 —— 安静等待即可，这正是 VLC /
   * PotPlayer 遇到上游晚到几秒时的行为。
   *
   * 做法是把 hls.js 的纠偏阈值放到无穷大（它内部就是拿这个值跟延迟比，
   * 但 hls.js 对 Infinity 是安全比较，不会真的去 seek），只留下 5% 的温和提速，
   * 万一长时间轻微落后也能慢慢追回来，而不会出现肉眼可见的 13 秒突跳。
   */
  /*
   * 纠偏阈值给得很大（20 片 = 40 秒）而不是 Infinity：
   * 既不会因为它频繁把播放头拽回边缘，也不会把 hls.js 内部的缓冲算术撑爆
   * （Infinity 会让 maxLatency 变成 NaN，hls.js 会退化成「只缓 2 秒」）。
   */
  /*
   * 纠偏阈值给**很大**、追速给 1 —— 慢源上"落后"是常态，不是错误。
   * 以前是 20 片（40 秒）+ 1.05 倍速：落后超过 40 秒就把播放头往前拽，
   * 而慢源必然落后，于是被反复拽回边缘、反复见底（这正是"转码档老卡"的来源之一）。
   */
  plan.liveMaxLatencyDurationCount = 3600;
  plan.maxLiveSyncPlaybackRate = 1;
  const mySeq = ++state.hlsSeq;
  diagPush('hls-ffmpeg', `直播方案：退 ${plan.targetLatency}s / 前向 ${plan.maxBufferLength}s ` +
    `（按已知窗口 ${plan.windowSeconds}s = ${FFMPEG_HLS_LIST_SIZE} 片 × ${FFMPEG_HLS_SEGMENT_SECONDS}s 算；` +
    `当前列表 ${listSegs === null ? '未取到' : listSegs + ' 片'}）`, 'ok');
  const hls = new window.Hls(makeHlsConfig({
    manifestLoadingTimeOut: 40000,
    manifestLoadingMaxRetry: 30,
    manifestLoadingRetryDelay: 800,
    levelLoadingTimeOut: 40000,
    levelLoadingMaxRetry: 20,
    fragLoadingTimeOut: 60000,
    fragLoadingMaxRetry: 20,
    fragLoadingRetryDelay: 1000,
  }, plan));
  hls.on(window.Hls.Events.ERROR, (_evt, data) => {
    // 旧实例（已被 destroyPlayer 换掉）的迟到事件一律忽略
    if (state.hlsSeq !== mySeq) return;
    diagPush('hls-ffmpeg', `ERROR ${data.type || ''}/${data.details || ''} fatal=${!!data.fatal}` +
      `${data.response ? ' status=' + data.response.code : ''}${data.reason ? ' reason=' + data.reason : ''}`,
    data.fatal ? 'err' : 'warn');
    if (state.playToken !== token || !data.fatal) return;
    if (data.details === 'manifestLoadError' || data.details === 'levelLoadError') return;

    /*
     * 我们自己产的 fMP4 也可能被浏览器拒收 —— 那**不是**转码失败，而是
     * 源的 H.264 码流带着 MSE 不认的 profile/constraint 位。
     *
     * 实测（2026-10-10 22:08）：线路一那种源，SPS 的 constraint 字节是 0x01，
     * 浏览器报的 mime 是 `video/mp4;codecs=mp4a.40.2,avc1.640128`，而
     *   MediaSource.isTypeSupported('video/mp4;codecs="avc1.640128"')  === false
     *   MediaSource.isTypeSupported('video/mp4;codecs="avc1.640028"')  === true
     * 差别只在第二个字节。`-c:v copy` 会把这个 SPS 原样搬出来，于是 ffmpeg
     * 做得再对，addSourceBuffer 照样抛 NotSupportedError。
     * 而 VLC / PotPlayer 不用 MSE，自然没这回事 —— 这就是同一个源「它们能播、
     * 我们播不了」的最后一道差别。
     *
     * 出路：让 ffmpeg 真编一遍（libx264 产出的 SPS 是浏览器认的那种），重试一次。
     */
    if (/bufferAddCodecError|bufferIncompatibleCodecsError/i.test(String(data.details || ''))) {
      if (state.ffmpegVideoMode !== 'transcode' && state.playToken === token) {
        state.ffmpegVideoMode = 'transcode';
        // 记到全局：同一条源以后第一次就直接重编，不再等这次失败被发现
        try {
          const curLine = state.lines[state.currentLine];
          if (curLine && curLine.url) TRANSCODE_URLS.add(curLine.url);
        } catch (err) { /* ignore */ }
        diagPush('hls-ffmpeg', `浏览器拒收这条码流（${data.details}${data.mimeType ? ' ' + data.mimeType : ''}）：` +
          '源的 H.264 参数 MSE 不认，改成重编视频再试', 'warn');
        toastThrottled('这条源的 H.264 参数浏览器不认，正在重编视频（多花一点 CPU）…');
        // 它其实能播（只是要换重编档）：把「已失败」标记清掉，别让面板一直红着
        if (state.currentLine >= 0) {
          state.failures.delete(state.currentLine);
          state.failReasons.delete(state.currentLine);
          renderLinePanel();
        }
        const prefer = state.currentLine >= 0 ? state.currentLine : undefined;
        tryFfmpegFallback('浏览器不认源的 H.264 参数（需重编视频）', prefer, { video: 'transcode' })
          .catch(() => {});
        return;
      }
    }

    /*
     * append / 缓冲类致命错误**先自愈，别急着报「播放失败」**。
     *
     * 实测 `bufferAppendError fatal=true` 之后画面其实还在走（日志里紧接着
     * canplay → playing → 出画成功），只是缓冲被重置、看得见地顿一下。
     * hls.js 自己的自愈动作是 `startLoad()`；这里帮它一把并记录次数，
     * 连续 3 次都救不回来才认定真的播不了 —— 否则用户会看到一个并没有
     * 真正致命的红色错误框。
     */
    if (/bufferAppend|bufferStalled|bufferSeekOverHole|bufferFull/i.test(String(data.details || ''))) {
      appendFails += 1;
      /*
       * 关键：append 失败**不能**用 startLoad() 自愈。
       *
       * startLoad() 只是「重新去拉分片」，可 SourceBuffer 已经废了，
       * 拉回来照样 append 失败 —— 实测（01:19:43 日志）连试 4 次全失败后，
       * hls.js 干脆放弃并**直接跳到直播边缘**，于是播放头落在缓冲之外
       * （buf=2.0~10.0 而 t=18.02），时间轴彻底不动、永不恢复。
       * 正确动作是 hls.js 官方的 recoverMediaError()：它会重建 MediaSource
       * 并重新 append 已下载的分片，这样才能真正从 append 错误里爬出来。
       */
      if (appendFails <= 3) {
        diagPush('hls-ffmpeg', `append 失败第 ${appendFails} 次，重建 MediaSource（recoverMediaError）`, 'warn');
        toastThrottled(`转码分片接入失败，正在重建解码缓冲（第 ${appendFails} 次）…`);
        try { hls.recoverMediaError(); } catch (err) { /* ignore */ }
        return;
      }
      diagPush('hls-ffmpeg', `append 连续失败 ${appendFails} 次，放弃自愈`, 'err');
      /*
       * 换壳档的分片被浏览器拒收（实测 2026-10-10 22:42，CCTV1 线路一：
       * `CHUNK_DEMUXER_ERROR_APPEND_FAILED: Failed to prepare video sample for decode`）——
       * 因为分片里**还内嵌着那个非法 SPS**（reserved_zero_2bits=1）。
       * init 片段里的 avcC 我们能在服务端修（1.6.24），分片里内嵌的参数集修不了，
       * 所以这条源在换壳档下永远播不了：唯一出路是**真编一遍**（libx264 的 SPS 规范），
       * 并把结论记进 TRANSCODE_URLS —— 下次直接上重编档，不再白试一轮。
       */
      if (state.ffmpegVideoMode !== 'transcode') {
        state.ffmpegVideoMode = 'transcode';
        const curLine = state.lines[state.currentLine];
        if (curLine && curLine.url) TRANSCODE_URLS.add(curLine.url);
        diagPush('hls-ffmpeg', '换壳分片被浏览器拒收：改走视频重编重试（这条源以后直接用重编档）', 'warn');
        toastThrottled('这条源的分片浏览器解不了，正在改成重编（多花一点 CPU）…');
        // 它其实能播（只是要换重编档）：把「已失败」标记清掉，别让面板一直红着
        if (state.currentLine >= 0) {
          state.failures.delete(state.currentLine);
          state.failReasons.delete(state.currentLine);
          renderLinePanel();
        }
        tryFfmpegFallback('换壳分片被拒收（需重编视频）',
          state.currentLine >= 0 ? state.currentLine : undefined, { video: 'transcode' }).catch(() => {});
        return;
      }
    }

    setSpinner(false);
    showError(`${kindLabel}播放失败`,
      `${escapeHtml(data.details || data.type)}<br>${escapeHtml(name || '')}`);
  });
  // 记关键节点，出问题时能看出「卡在哪一段」
  let appendFails = 0;
  const mark = (label) => (evt, data) => {
    const d = data || {};
    diagPush('hls-ffmpeg', `${label}` +
      `${d.frag ? ' frag=' + String(d.frag.url || '').split('/').pop() : ''}` +
      `${d.level ? ' sn=' + d.level.sn : ''}` +
      `${d.stats ? ' bytes=' + d.stats.total : ''}`);
  };
  hls.on(window.Hls.Events.MANIFEST_LOADED, mark('MANIFEST_LOADED'));
  hls.on(window.Hls.Events.MANIFEST_PARSED, mark('MANIFEST_PARSED'));
  hls.on(window.Hls.Events.LEVEL_LOADED, mark('LEVEL_LOADED'));
  hls.on(window.Hls.Events.FRAG_LOADED, mark('FRAG_LOADED'));
  hls.on(window.Hls.Events.FRAG_BUFFERED, mark('FRAG_BUFFERED'));
  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    if (state.playToken !== token) return;
    video.play().catch(() => {});
  });

  /*
   * 先 attachMedia 再 loadSource（官方推荐顺序）。
   * 反过来写时，播放列表可能在 MediaSource 还没建好的时候就下载完，
   * 第一个分片会撞上「还没有 SourceBuffer」——那正是 bufferAppendError 的来源之一。
   */
  hls.attachMedia(video);
  hls.loadSource(url);
  state.hls = hls;
  diagPush('play', `接上 ffmpeg HLS：${url.split('/').slice(-2).join('/')}`, 'ok');
}

/**
 * ffmpeg 兜底。
 *
 * 浏览器引擎（hls.js / mpegts.js / flv.js）全都放不出来的流走这里：
 * HEVC、AC-3/MP2 音频、非标准 TS 封装……ffmpeg 直接按 URL 拉流，
 * 输出 H.264+AAC 的 HLS。等价于把 MPV/VLC 的解码能力搬进应用里，
 * 而不是像 IPTVnator 那样把流甩给外部播放器。
 */
/**
 * 把浏览器实测到的解码能力告诉服务端。
 *
 * 目前只用一样：**HEVC 能不能直解**。这个包里的 Chromium 在 Windows 上要拿到平台
 * HEVC 硬解才支持（启动时用 mediaCapabilities 探过一次，结果在 state.decodeCap），
 * 支持的话服务端就不该把 HEVC 一律判成「要转码」。
 */
function capsForServer() {
  const cap = state.decodeCap && state.decodeCap.hevc_1080;
  return { hevc: !!(cap && cap.supported) };
}

async function tryFfmpegFallback(failedReason, preferIndex, opts) {
  /*
   * 挑一条线路交给 ffmpeg。
   *
   * ⚠️ preferIndex 是修一个实测到的怪状态：**已经选定的那条线路**必须优先。
   * 原来的写法是「全局挑实测最快的」，于是出现过这种日志（2026-10-07 01:13）：
   *   - 线路一（H.264 1080p / AAC，可直解，5.7 MB/s）已经出画、frames 在涨；
   *   - 紧接着却出现「ffmpeg 开始接管：原因=Chromium 没有视频 MPEG-2…」，
   *     而 /api/remux 回来的却是 tier=remux / h264 —— 因为「最快的那条」
   *     正好就是刚才在播的那条直解线路，于是绕了一圈把能播的流拆掉重封一遍。
   * 也就是说：判定「要转码」的是这条线路，但被送去转码的却是另一条。
   * 现在只要上层给了 preferIndex，就只用它；没给才退回「最快的」。
   */
  /*
   * ⚡ 挑一条真正还站得住的线路。
   *
   * 踩过的坑（2026-10-07 用户截图）：上游对这条地址**45 毫秒就回 404**，
   * 但这里只看 line.playable、不看它是否已被判死，于是照样起 ffmpeg 会话，
   * 拉不到数据、跑满 15 秒才失败，最后报出来的是
   * 「已依次尝试全部 1 条线路（线路一）……15 秒内没有数据」——
   * 用户看到的就是「无法播放」，而真正能播的另外几条从头到尾没被碰过。
   *
   * 现在两道闸：
   *   1. 已被预检/播放判死的（state.failures）直接排除；
   *   2. 指定的那条若已判死，换成下一条没被判死的，而不是硬着头皮用。
   */
  const usable = (i) => {
    const ln = state.lines[i];
    return !!ln && !!ln.playable && !state.failures.has(i);
  };
  let best = null;
  if (preferIndex !== undefined && preferIndex !== null && usable(preferIndex)) {
    const line = state.lines[preferIndex];
    best = { line, kb: lineSpeedCache.get(line.url) || 0, index: preferIndex };
  }
  if (!best) {
    for (let i = 0; i < state.lines.length; i += 1) {
      if (!usable(i)) continue;
      const line = state.lines[i];
      const kb = lineSpeedCache.get(line.url) || 0;
      if (!best || kb > best.kb) best = { line, kb, index: i };
    }
  }
  if (!best) {
    const why = state.lines
      .map((ln, i) => (ln && ln.playable && state.failures.has(i) ? `线路${lineLabel(i + 1)}` : null))
      .filter(Boolean).join('、');
    diagPush('ffmpeg', '没有可播线路，兜底放弃' + (why ? `（已判死：${why}）` : ''), 'err');
    return false;
  }

  const token = state.playToken;
  const channelName = $('osdTitle').textContent;
  state.currentLine = best.index;
  renderLinePanel();
  updateOsdLine(best.index);
  setSpinner(true, `浏览器引擎放不出来（${failedReason}），正在用 ffmpeg 接管…`);
  diagPush('ffmpeg', `开始接管：原因=${failedReason} 线路=${best.index + 1}` +
    `（当前线路=${state.currentLine + 1} 原判定=${state.wantFfmpeg ? 'transcode' : '未判定'}）` +
    `（指定=${preferIndex === undefined || preferIndex === null ? '无，取最快' : preferIndex + 1}）` +
    ` url=${best.line.url}`);

  /*
   * 起新会话之前，先把上一个 ffmpeg 会话关掉。
   * 否则换一次线路就多挂一个 ffmpeg 在后台拉流编码（实测同一个频道接管过多次），
   * 几个进程一起抢 CPU，转码反而更跟不上。
   */
  if (state.remuxSid) {
    const old = state.remuxSid;
    state.remuxSid = null;
    fetch(`/api/remux?id=${encodeURIComponent(old)}`, { method: 'DELETE' })
      .then(() => diagPush('ffmpeg', `已关闭上一个接管会话 ${old}`))
      .catch(() => {});
  }

  try {
    const r = await fetch('/api/remux', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: best.line.url, ref: best.line.ref, ua: best.line.ua, name: channelName,
        /*
         * 'transcode' = 连视频一起重编（源 H.264 的 SPS 浏览器不认时唯一出路）。
         * 判断顺序：调用方显式指定 > 本次播放已经判定要重编 > 这条源以前被拒过 > 先换壳试。
         */
        video: (opts && opts.video) === 'transcode' || state.ffmpegVideoMode === 'transcode'
          || TRANSCODE_URLS.has(best.line.url) ? 'transcode' : 'copy',
        caps: capsForServer(),
      }),
    });
    const d = await r.json();
    if (state.playToken !== token) return true;
    if (!d.ok) throw new Error(d.error || 'ffmpeg 接管失败');
    state.remuxSid = d.id;

    const v = d.video ? `${d.video.codec}${d.video.height ? ' ' + d.video.height + 'p' : ''}` : '';
    const a = d.audio ? d.audio.codec : '';
    state.ffmpegFallback = true;
    $('liveTag').textContent = 'ffmpeg';
    $('liveTag').classList.remove('hidden');
    toast(`已交给 ffmpeg 接管（源编码 ${v}${a ? ' / ' + a : ''}）：${d.reason}`);
    diagPush('ffmpeg', `会话已建：id=${d.id} tier=${d.tier} 源编码=${v}/${a} 原因=${d.reason}`, 'ok');
    // 会话体检要**马上**问一次：ffmpeg 到底有没有被拉起来（started）。
    // 实测踩过（2026-10-07 01:56）：服务端原来是懒启动，客户端那次请求一被中止，
    // ffmpeg 就永远不启动 —— 目录全空、播放器永远在等，而日志里看不出异常。
    try {
      const stRes = await fetch('/api/remux/status?id=' + encodeURIComponent(d.id));
      const stJson = await stRes.json();
      const ss = stJson && stJson.session;
      if (ss) {
        const line = '会话体检：started=' + ss.started + ' finished=' + ss.finished +
          ' exit=' + ss.exitCode + ' 分片=' + ss.segments +
          ' seq=' + ss.mediaSequence +
          ' 客户端已缓=' + video.buffered.length + '段' +
          ' err=' + (ss.error || '无');
        diagPush('ffmpeg', line, (ss.error || ss.finished) ? 'err' : 'ok');
        if (ss.error) toast('ffmpeg 启动失败：' + ss.error, true);
      }
    } catch (err) { /* 体检失败不影响播放 */ }

    destroyPlayer();
    state.hls = null;
    // 等它把播放列表读进来、按真实窗口建好 hls.js 再往下走：
    // 这样看门狗和体检轮询都不会在"播放器还没建好"的空档里空转。
    await attachHlsHls(`/api/local/hls/${d.id}/index.m3u8`, {
      token, name: channelName, kindLabel: 'ffmpeg 转码',
      // 转码档：目标延迟 30 秒 + 40 秒缓冲上限（见 attachHlsHls 里的参数推导）；直解线路完全不受影响
    });
    if (state.playToken !== token) return true;
    startHealthCheck(d.id, token, channelName);
    return true;
  } catch (err) {
    if (state.remuxSid) {
      const bad = state.remuxSid;
      state.remuxSid = null;
      fetch(`/api/remux?id=${encodeURIComponent(bad)}`, { method: 'DELETE' }).catch(() => {});
    }
    if (state.playToken === token) setSpinner(false);
    toast(`ffmpeg 接管也没成功：${err.message}`, true);
    diagPush('ffmpeg', `接管失败：${err.message}`, 'err');
    return false;
  }
}

/**
 * 预判转码路径的起播看门狗。
 *
 * 转码本身要几秒起头，所以给得比直解宽松；但**必须有上限** ——
 * 没有上限时的表现就是「永远转圈、不报错、不换线路」，这是最难查的一种故障。
 * 超时后不再假装还在努力，而是把 video 元素的真实状态 + 诊断入口一起摆出来。
 */
function armFallbackWatchdog(token) {
  clearTimeout(state.watchdog);
  const t0 = Date.now();
  const LIMIT_MS = 75000;
  const tick = () => {
    if (state.playToken !== token) return;
    // 出画了（真的有时间轴推进）就交给常规的卡顿看门狗。
    // 注意：这里不能用 readyState>=2 —— 有数据不等于解出了帧（见 frameReport 注释）
    if (pictureSeen()) {
      state.watchdog = null;
      diagPush('play', `出画成功：rs=${video.readyState} ${video.videoWidth}x${video.videoHeight} ` +
        `t=${video.currentTime.toFixed(2)}`, 'ok');
      return;
    }
    if (Date.now() - t0 > LIMIT_MS) {
      state.watchdog = null;
      setSpinner(false);
      const b = video.buffered;
      const buf = b.length ? `${b.start(0).toFixed(1)}~${b.end(b.length - 1).toFixed(1)}` : '空';
      diagPush('play', `超时未出画：rs=${video.readyState} 缓冲=${buf} ${video.videoWidth}x${video.videoHeight}`, 'err');
      showError('转码已启动，但画面一直没出来',
        `已等 ${Math.round((Date.now() - t0) / 1000)} 秒。<br>` +
        `video 状态：readyState=${video.readyState}，分辨率=${video.videoWidth}×${video.videoHeight}，缓冲=${escapeHtml(buf)}<br>` +
        '<b>请按 L 打开诊断日志 → 点「复制」，把内容发回来</b> —— 日志里有 hls.js 的事件流水，' +
        '能直接看出是卡在拉列表、拉分片，还是 append 之后解不出来。');
      return;
    }
    state.watchdog = setTimeout(tick, 2000);
  };
  tick();
}

/**
 * 转码期间盯着 ffmpeg 的会话状态。
 *
 * 转码是「本机现编」，最怕的表现就是**一直转圈、什么都不说** ——
 * 用户分不清是慢、是拉不到流、还是编不出来。这里每 2.5 秒问一次
 * /api/remux/status，ffmpeg 一旦报错或提前退出，立刻把真实原因摆到界面上。
 */
function startHealthCheck(sid, token, channelName) {
  stopHealthCheck();
  let ticks = 0;
  state.healthTimer = setInterval(async () => {
    if (state.playToken !== token) { stopHealthCheck(); return; }
    // 出画了就停 —— 已经在播，不需要再盯
    if (video.readyState >= 2) { stopHealthCheck(); return; }
    ticks += 1;
    if (ticks % 4 === 0) {
      setSpinner(true, `ffmpeg 转码中…已等待 ${ticks * 2.5 | 0} 秒（首次转码需要几秒）`);
    }
    try {
      const r = await fetch(`/api/remux/status?id=${encodeURIComponent(sid)}`);
      const d = await r.json();
      if (!d.ok || !d.session) return;
      const s = d.session;
      // hls.js 自己解析出来的编码：append 失败时这是最关键的一条线索
      let levelInfo = '';
      const lv = hls.levels && hls.levels[(hls.currentLevel >= 0 ? hls.currentLevel : 0)];
      if (lv) {
        const vc = (lv.videoCodec || lv.attrs && lv.attrs.CODECS || '').toString();
        const ac = lv.audioCodec || '';
        levelInfo = ` hls编码=${vc || '?'}${ac ? '/' + ac : ''}`;
      }
      const listAge = (typeof s.playlistAgeMs === 'number')
        ? `${Math.round(s.playlistAgeMs / 1000)}s前` : '无';
      // 分片在涨、列表却停更 = ffmpeg 改名失败（详见 server.js handleLocalHls 注释）
      const listStalled = typeof s.playlistAgeMs === 'number' && s.playlistAgeMs > 20000
        && s.started && !s.finished;
      diagPush('ffmpeg-status', `rs=${video.readyState} 分片=${s.segments} seq=${s.mediaSequence} 列表更新=${listAge} ` +
        `started=${s.started} finished=${s.finished} exit=${s.exitCode} err=${s.error || '无'}${levelInfo}`,
      (s.error || listStalled) ? (s.error ? 'err' : 'warn') : '');
      if (s.error || (s.finished && s.segments === 0)) {
        stopHealthCheck();
        setSpinner(false);
        showError('ffmpeg 转码失败',
          `源编码 <b>${escapeHtml(describeCodec({ video: s.video, audio: s.audio }) || '未知')}</b><br>` +
          `原因：${escapeHtml(s.error || 'ffmpeg 已退出但没有产出分片')}<br>` +
          (s.stderrTail ? `<pre style="white-space:pre-wrap;font-size:11px;opacity:.75">${escapeHtml(s.stderrTail)}</pre>` : '') +
          '可点「线路」换一条，或把这个错误发回来。');
        toast('ffmpeg 转码失败，原因已显示在画面中央', true);
      } else if (s.finished && s.segments > 0) {
        stopHealthCheck();
        toastThrottled('ffmpeg 已结束（上游可能掐断了流），正在自动恢复…');
      }

      /*
       * 兜底（2026-10-10 22:18 CCTV13 线路一）：换壳档 15 秒还不出画就改重编。
       *
       * 「浏览器拒收我们的换壳产物」那个 bufferAddCodecError 不一定每次都能收到 ——
       * 旧实例排队事件可能被丢弃、hls.js 也可能只是安静地建不出 SourceBuffer。
       * 那一轮的现象就是：会话建好了、列表在涨、loadedmetadata 却始终 0×0，界面一直转圈。
       * 所以不把成败押在那个错误上：只要还没出画（videoWidth 为 0）且用的是换壳档，
       * 到点就直接改成视频重编，并把这条源记下来（下次第一次就用重编）。
       */
      if ((!state.ffmpegVideoMode || state.ffmpegVideoMode === 'copy')
          && !state.transcodeRetryAt && ticks * 2.5 > 15 && !video.videoWidth) {
        state.transcodeRetryAt = Date.now();
        state.ffmpegVideoMode = 'transcode';
        const curLine = state.lines[state.currentLine];
        if (curLine && curLine.url) TRANSCODE_URLS.add(curLine.url);
        diagPush('ffmpeg-status', '换壳档 15 秒未出画：改走视频重编（疑似浏览器不认源的 H.264 参数）', 'warn');
        toastThrottled('换壳出来的画面浏览器解不了，改成重编（多花一点 CPU）…');
        stopHealthCheck();
        tryFfmpegFallback('换壳档未出画（疑似浏览器不认源的 H.264 参数）',
          state.currentLine >= 0 ? state.currentLine : undefined, { video: 'transcode' }).catch(() => {});
        return;
      }
    } catch (err) {
      /* 状态查询失败不影响播放，继续盯 */
    }
  }, 2500);
}

function stopHealthCheck() {
  if (state.healthTimer) {
    clearInterval(state.healthTimer);
    state.healthTimer = null;
  }
}

/**
 * 解码看门狗：「数据一直在来，解码器就是不出帧」的专用判官。
 *
 * 这是**另一类故障**，必须和「拉不到数据」分开判 —— 否则用户和日志都
 * 只会看到一句含糊的「转圈」：
 *   - 数据不来      → buffered 不涨、readyState 上不去（网络/源的问题，换线路有用）
 *   - 数据来了不出帧 → buffered 一直在涨、readyState≥2，但 t 始终 0、分辨率为 0
 *                     （**解码链路的问题，换线路没用**，换软解才有用）
 *
 * 判据只看「时间轴动不动」，不看 readyState —— 理由见 frameReport() 上面那段。
 * 超时后把真实读数摆到界面上，并引到「解码方式切软件解码」这条最便宜的自救路径。
 */
function armDecodeWatchdog(token, { ffmpegMode }) {
  clearTimeout(state.decodeTimer);
  state.decodeTimer = null;
  // 转码档要给 ffmpeg 起进程 + 编出第一个分片的时间，直解档只等解码器
  const UNTIL_WARN_MS = ffmpegMode ? 20000 : 8000;
  const GIVE_UP_MS = ffmpegMode ? 40000 : 15000;
  const t0 = Date.now();
  state.pictureAt = null;
  state.pictureSince = null;
  const tick = () => {
    if (state.playToken !== token) return;
    if (state.mode === 'file' || state.userPaused) {
      state.decodeTimer = setTimeout(tick, 2000);
      return;
    }
    const r = recordFrame();
    if (pictureSeen(r)) {
      state.decodeTimer = null;
      state.pictureSince = null;
      return;
    }
    const waited = Date.now() - t0;
    const gotData = r.rs >= 2 || r.buffered > 0.2;
    if (gotData && !state.pictureSince) {
      state.pictureSince = Date.now();
      diagPush('decode', `数据已入缓冲但解码器还没出帧：${frameText(r)}`, 'warn');
    }
    const stalled = state.pictureSince ? Date.now() - state.pictureSince : 0;

    if (gotData && waited > UNTIL_WARN_MS) {
      setSpinner(true, `数据已经到位（缓冲 ${r.buffered.toFixed(1)} 秒），但解码器没有出帧…`);
    }
    if (gotData && stalled > GIVE_UP_MS) {
      state.decodeTimer = null;
      setSpinner(false);
      const hint = state.decodeMode === 'software'
        ? '当前已经是软件解码，说明问题不在 GPU 解码开关上。'
        : '把控制条上的「解码」切成<b>软件解码</b>（会自动重启应用）再试一次 —— ' +
          '这是本机最可疑的一环：硬件解码链路挂掉时就是「分片 append 成功、却一帧都不出」。';
      showError('数据拉到了，但解码器一帧都没解出来',
        `已等待 ${Math.round(waited / 1000)} 秒。这部分数据是真的（分片一直在进缓冲），` +
        `所以不是网络问题，换线路也没用。<br><br>` +
        `帧读数：<code>${escapeHtml(frameText(r))}</code><br>` +
        `判据：readyState=${r.rs}（≥2 说明有数据），但 currentTime=${r.t.toFixed(2)} 不动、` +
        `分辨率=${r.w}×${r.h}<br><br>${hint}<br>` +
        `按 <b>L</b> 打开诊断日志 → 点「复制」把内容发回来，里面有每秒钟的帧读数变化。`);
      toast('解码器没有出帧 —— 已把真实读数显示在画面中央', true);
      diagPush('decode', `判定：解码器不出帧（等 ${Math.round(waited / 1000)} 秒）${frameText(r)}`, 'err');
      return;
    }
    state.decodeTimer = setTimeout(tick, 2000);
  };
  tick();
}

function stopDecodeWatchdog() {
  clearTimeout(state.decodeTimer);
  state.decodeTimer = null;
}

/* -------------------------------------------------- 线路测速 */

/**
 * 线路测速并自动选快的。
 *
 * 实测同一频道不同线路能差 4 倍（CCTV1：3.0 ~ 12.1 MB/s），
 * 而列表顺序往往就把最慢的排在前面。选错线路的表现就是
 * 「缓冲反复见底、画面每隔几秒卡一下」——加大缓冲治标不治本。
 *
 * 结果按 URL 缓存，同一个源不用反复测。测速走的是和播放同一条代理路径，
 * 所以测出来的速度就是实际能拿到的速度。
 */
const lineSpeedCache = new Map();
/**
 * 线路的实测码率（bps）—— 来自服务端「分片字节数 ÷ EXTINF 时长」。
 *
 * 有了它就能回答「这条线路到底够不够」：1080p 常见 8~13 Mbps，
 * 如果实测吞吐只有 1.1 MB/s（≈9 Mbps），那它**根本喂不满**，
 * 这时调缓冲、跳空洞都是白费力气，唯一出路是换线路。
 */
const lineBitrateCache = new Map();
let speedProbeToken = 0;

/** 把一次测速结果写进缓存。 */
function absorbSpeedResults(results) {
  let got = 0;
  for (const res of results || []) {
    if (res.kbps > 0) { lineSpeedCache.set(res.url, res.kbps); got += 1; }
    if (res.bitrateBps > 0) lineBitrateCache.set(res.url, res.bitrateBps);
  }
  for (const line of state.lines) {
    const kb = lineSpeedCache.get(line.url);
    if (kb) line.speed = kb;
    const br = lineBitrateCache.get(line.url);
    if (br) line.bitrate = br;
  }
  return got;
}

/** 这条线路够不够喂满它自己的码率？返回 null 表示数据不足。 */
function lineHeadroom(line) {
  if (!line) return null;
  const kb = lineSpeedCache.get(line.url) || 0;
  const br = lineBitrateCache.get(line.url) || 0;
  if (!kb || !br) return null;
  const capacityBps = kb * 1024 * 8;      // 实测吞吐（bps）
  return { capacityBps, neededBps: br, ratio: capacityBps / br };
}

/**
 * 起播前把候选线路实测一遍，挑最快的开始播。
 *
 * 这是「高清卡顿」最直接的解法，而且和缓冲参数无关：
 * 同一个频道的线路速度实测能差 8 倍（CCTV1 第一条 1.1 MB/s、第十条 9.7 MB/s），
 * 1080p 需要约 1.3 MB/s，排在慢线路上的表现就是「缓冲永远填不满、画面像 PPT」。
 *
 * 旧代码只在起播**之后**后台测速，然后弹一句「线路N最快，点『线路』可切过去」——
 * 但点「线路」要用户自己动手，绝大多数人就一直留在最慢的那条上。
 *
 * 成本可控：每条只读 512KB 就断开、并发放开、结果按 URL 缓存（一个会话只付一次）。
 * 已缓存足够多时直接跳过，不浪费起播时间。
 */
async function ensureLineSpeeds(candidates) {
  const urls = candidates.map((i) => state.lines[i]).filter((l) => l && l.playable);
  if (urls.length < 2) return false;
  const known = urls.filter((l) => lineSpeedCache.has(l.url)).length;
  if (known >= Math.ceil(urls.length / 2)) return false;   // 已知够多，不再等

  // 客户端也加一道硬超时：服务端再慢也不能让起播无限等下去。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch('/api/linespeed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        lines: urls.slice(0, 16).map((l) => ({ url: l.url, ref: l.ref, ua: l.ua })),
        // 这次只要能排出名次，不需要精确值：采样小一点、整条硬上限压到 3.5 秒
        budgetMs: 1000,
        maxBytes: 384 * 1024,
        concurrency: 12,
        deadlineMs: 3500,
      }),
    });
    const d = await r.json();
    if (!d.ok) return false;
    return absorbSpeedResults(d.results) > 0;
  } catch (err) {
    return false;   // 测速失败/超时不影响播放，退化成原来的顺序
  } finally {
    clearTimeout(timer);
  }
}

async function probeLineSpeeds() {
  const token = ++speedProbeToken;
  const playable = state.lines
    .map((l, i) => ({ l, i }))
    .filter((x) => x.l.playable && !lineSpeedCache.has(x.l.url));
  if (playable.length < 2) return;

  const batch = playable.slice(0, 12);
  try {
    const r = await fetch('/api/linespeed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lines: batch.map((x) => ({ url: x.l.url, ref: x.l.ref, ua: x.l.ua })),
        budgetMs: 3000,
      }),
    });
    const d = await r.json();
    if (token !== speedProbeToken || !d.ok) return;

    // 回填到线路对象，面板上就能直接看到每条线路实测多快、够不够
    absorbSpeedResults(d.results);
    renderLinePanel();

    // 这里只负责把速度显示出来。
    //
    // 起播前 ensureLineSpeeds() 已经挑过最快的那条了，所以正常情况下
    // 当前线路就是最快的，不再提示切换；只有补测发现明显更快的（比如起播时
    // 那批线路还没测到）才提示一句。
    // 不做「无条件的播放中切换」：切换要先停流再重连，必然丢一段画面。
    const current = state.lines[state.currentLine];
    let best = null;
    for (const line of state.lines) {
      if (!line.playable) continue;
      const kb = lineSpeedCache.get(line.url) || 0;
      if (kb > 0 && (!best || kb > best.kb)) best = { line, kb };
    }
    if (best && current && best.line.url !== current.url) {
      const curKb = lineSpeedCache.get(current.url) || 0;
      if (best.kb > Math.max(curKb, 1) * 1.8) {
        const idx = state.lines.indexOf(best.line);
        toast(`实测线路 ${idx + 1} 明显更快（${(best.kb / 1024).toFixed(1)} MB/s` +
              (curKb ? `，当前 ${(curKb / 1024).toFixed(1)} MB/s` : '') +
              '）：点「线路」可切过去');
      }
    }
  } catch (err) {
    /* 测速失败不影响播放 */
  }
}

/* -------------------------------------------------- 进度条 */

function updateSeekBar() {
  const seek = $('seek');
  const label = $('timeLabel');
  const dur = video.duration;
  const seekable = state.mode === 'file' && Number.isFinite(dur) && dur > 0;
  seek.disabled = !seekable;
  if (!seekable) {
    seek.value = '0';
    label.textContent = state.mode === 'file' ? '--:-- / --:--' : '直播';
    return;
  }
  if (!state.seeking) seek.value = String(Math.round((video.currentTime / dur) * 1000));
  label.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)}`;
}

/* -------------------------------------------------- 显卡 / 解码方式 */

/**
 * 解码方式档位（与主进程 command-line 开关一一对应）。
 *
 * 用户要的优先级「独显 → 核显 → 软件」由 Chromium 自己完成：
 * 我们只负责**别把硬解关掉**、并优先指定独显；没有独显时该开关是空操作，
 * 自然会落到核显；硬件解码器不可用时 Chromium 自动退回软件解码。
 */
const DECODE_MODES = [
  { value: 'auto', label: '自动（独显→核显→软解）' },
  { value: 'discrete', label: '独显优先' },
  { value: 'integrated', label: '核显' },
  { value: 'software', label: '软件解码' },
];

function decodeModeLabel(v) {
  const hit = DECODE_MODES.find((m) => m.value === v);
  return hit ? hit.label : v;
}

/** 读主进程报告的显卡与硬解状态（只在桌面版有）。 */
async function loadGpuInfo() {
  if (!window.hubplay || !window.hubplay.gpuInfo) return null;
  try {
    state.gpuInfo = await window.hubplay.gpuInfo();
  } catch (err) {
    state.gpuInfo = null;
  }
  return state.gpuInfo;
}

/**
 * 探测这台机器对各种编码的**硬解能力**。
 *
 * `navigator.mediaCapabilities.decodingInfo()` 是 Chromium 的正式接口，
 * 返回里的 `powerEfficient: true` 表示这个解码配置走的是硬件解码器（省电）。
 * 这是唯一能把「到底有没有用上独显/核显」问清楚的办法 ——
 * 主进程的 getGPUFeatureStatus 只说明全局开关，这里说的是具体编码。
 *
 * 顺带把主流编码都问一遍，用户就能看到自己这台机器到底能硬解什么。
 */
const DECODE_PROBES = [
  { key: 'h264_1080', label: 'H.264 1080p', contentType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080 },
  { key: 'h264_720', label: 'H.264 720p', contentType: 'video/mp4; codecs="avc1.4d401f"', width: 1280, height: 720 },
  { key: 'hevc_1080', label: 'HEVC 1080p', contentType: 'video/mp4; codecs="hvc1.1.6.L120.B0"', width: 1920, height: 1080 },
  { key: 'av1_1080', label: 'AV1 1080p', contentType: 'video/mp4; codecs="av01.0.08M.08"', width: 1920, height: 1080 },
  { key: 'mpeg2_sd', label: 'MPEG-2 SD', contentType: 'video/mp4; codecs="mp2v.0.0"', width: 720, height: 576 },
];

async function probeDecodeCaps() {
  if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return {};
  const out = {};
  for (const p of DECODE_PROBES) {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: { contentType: p.contentType, width: p.width, height: p.height, bitrate: 8e6, framerate: 25 },
      });
      out[p.key] = { label: p.label, supported: !!info.supported, smooth: !!info.smooth, powerEfficient: !!info.powerEfficient };
    } catch (err) {
      out[p.key] = { label: p.label, supported: false, smooth: false, powerEfficient: false, error: err.message };
    }
  }
  state.decodeCap = out;
  return out;
}

/** 当前生效的显卡名（优先取 Chromium 标记为 active 的那块）。 */
function activeGpuName() {
  const devs = (state.gpuInfo && state.gpuInfo.devices) || [];
  const active = devs.filter((d) => d.active && d.name);
  if (active.length) return active.map((d) => d.name).join(' + ');
  const any = devs.filter((d) => d.name);
  return any.length ? any.map((d) => d.name).join(' + ') : '';
}

/**
 * 硬解到底有没有生效。
 * @returns {ok:boolean|null, text:string} null 表示拿不到信息
 */
function hardwareDecodeState() {
  const st = state.gpuInfo && state.gpuInfo.featureStatus;
  const cap = state.decodeCap && state.decodeCap.h264_1080;
  if (!st && !cap) return { ok: null, text: '未知（非桌面版）' };
  const gpuOk = st ? /^enabled/.test(String(st.video_decode || '')) : null;
  const capOk = cap ? cap.powerEfficient : null;
  if (capOk === true) return { ok: true, text: '硬件解码（GPU）' };
  if (capOk === false) {
    return { ok: false, text: gpuOk === false ? '软件解码（硬解被关闭）' : '软件解码（CPU）' };
  }
  if (gpuOk === true) return { ok: true, text: '已启用' };
  if (gpuOk === false) return { ok: false, text: `未启用（${st.video_decode}）` };
  return { ok: null, text: '未知' };
}

/* -------------------------------------------------- 播放统计面板 */

/**
 * 用来回答「卡顿到底是缓冲不够还是解码跟不上」：
 * 丢帧率高 = CPU/GPU 解码瓶颈，调大缓冲没用；
 * 缓冲见底但没丢帧 = 网络抖动，调大缓冲有用。
 */
let statsTimer = null;

function statsRow(k, v, cls) {
  return `<tr><td>${k}</td><td class="${cls || ''}">${v}</td></tr>`;
}

function updateStats() {
  if ($('statsPanel').classList.contains('hidden')) return;
  const v = video;
  const b = v.buffered;
  const end = b.length ? b.end(b.length - 1) : 0;
  const ahead = Math.max(0, end - v.currentTime);
  const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  const hls = state.hls;
  const isLocal = state.mode === 'file';

  const dropPct = q && q.totalVideoFrames > 0
    ? (q.droppedVideoFrames / q.totalVideoFrames) * 100 : 0;

  const rows = [
    statsRow('画面', `${v.videoWidth}×${v.videoHeight}`),
    statsRow('状态', v.paused ? '暂停' : (ahead < 1 ? '缓冲中' : '播放中'),
      ahead < 1 && !v.paused ? 'warn' : ''),
    statsRow('前向缓冲', `${ahead.toFixed(1)} 秒`, ahead < 3 ? 'warn' : 'ok'),
  ];
  if (!isLocal) {
    rows.push(statsRow('已播', fmtTime(v.currentTime)));
  } else {
    rows.push(statsRow('进度', `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`));
  }
  if (q) {
    rows.push(statsRow('解码总帧', String(q.totalVideoFrames)));
    rows.push(statsRow('丢帧', `${q.droppedVideoFrames}（${dropPct.toFixed(2)}%）`,
      dropPct > 2 ? 'bad' : 'ok'));
  }
  const plan = state.livePlan;
  if (plan) {
    rows.push(statsRow('源窗口',
      plan.known
        ? `${plan.windowSeconds.toFixed(0)} 秒（${plan.segments} 个分片 × 约 ${plan.targetDuration.toFixed(0)} 秒）`
        : '没量到，按保守值播',
      plan.known ? '' : 'warn'));
  }
  if (hls && hls.targetLatency != null) {
    const lat = hls.latency || 0;
    const tgt = hls.targetLatency || 0;
    rows.push(statsRow('离直播边缘', `${lat.toFixed(1)} 秒（目标 ${tgt.toFixed(1)}）`,
      tgt && lat > tgt * 2.5 ? 'warn' : 'ok'));
  }
  if (state.holeJumps || state.edgeSeeks) {
    rows.push(statsRow('跳过空洞 / 追直播',
      `${state.holeJumps} / ${state.edgeSeeks} 次`, state.holeJumps + state.edgeSeeks > 5 ? 'warn' : ''));
  }
  rows.push(statsRow('缓冲档位',
    `${bufferPreset().label} · 前向上限 ${plan ? plan.maxBufferLength.toFixed(0) : bufferPreset().seconds} 秒`));
  rows.push(statsRow('引擎', state.mpegts ? 'mpegts.js' : state.flv ? 'flv.js' : state.hls ? 'hls.js' : '原生'));
  // 解码这条链路：Chromium 的全局硬解开关 + 这台机器对具体编码的硬解能力
  const hw = hardwareDecodeState();
  rows.push(statsRow('视频解码', hw.text, hw.ok === false ? 'bad' : hw.ok === true ? 'ok' : ''));
  const gpuName = activeGpuName();
  if (gpuName) rows.push(statsRow('显卡', escapeHtml(gpuName.slice(0, 46))));
  const capH264 = state.decodeCap && state.decodeCap.h264_1080;
  const capHevc = state.decodeCap && state.decodeCap.hevc_1080;
  if (capH264 || capHevc) {
    const mark = (c) => (c ? (c.powerEfficient ? '硬解' : c.supported ? '软解' : '不支持') : '?');
    rows.push(statsRow('硬解能力', `H.264 ${mark(capH264)} · HEVC ${mark(capHevc)}`,
      capH264 && !capH264.powerEfficient ? 'warn' : ''));
  }
  rows.push(statsRow('解码方式', decodeModeLabel(state.decodeMode)));
  // 内置 ffmpeg 的状态：MPEG-2 线路能不能播全看它
  if (state.ffmpegTools) {
    const t = state.ffmpegTools;
    const okBoth = !!(t.ffmpegVersion && t.ffprobeVersion);
    rows.push(statsRow('内置 ffmpeg', okBoth ? (t.ffmpegVersion || '').slice(0, 52) : '不可用（转码线路播不了）',
      okBoth ? 'ok' : 'bad'));
  }
  if (!isLocal && state.currentLine >= 0) {
    const curLine = state.lines[state.currentLine];
    const curKb = (curLine && lineSpeedCache.get(curLine.url)) || 0;
    rows.push(statsRow('线路',
      lineLabel(state.currentLine + 1) + (curKb ? `（实测 ${(curKb / 1024).toFixed(1)} MB/s）` : '（未测速）'),
      curKb && curKb < 1400 ? 'warn' : ''));
    // 这条线路的真实编码 + 播放方式：出问题时一眼能看出是「浏览器没解码器」还是别的原因
    const curCv = curLine && codecCache.get(curLine.url);
    if (curCv) {
      const verdict = codecVerdict(curCv);
      const how = state.ffmpegFallback
        ? 'ffmpeg 转码中'
        : (verdict && verdict.tier === 'ffmpeg' ? 'ffmpeg 转码（待接管）' : 'Chromium 直解');
      rows.push(statsRow('源编码', `${describeCodec(curCv)} → ${how}`,
        verdict && verdict.tier === 'ffmpeg' ? 'warn' : 'ok'));
    }
  }
  if (state.starveSwitches) {
    rows.push(statsRow('带宽不足换线路', `${state.starveSwitches} 次`, 'warn'));
  }

  $('statsBody').innerHTML = rows.join('');

  /*
   * 丢帧明显时关掉「提速追赶」。
   *
   * maxLiveSyncPlaybackRate > 1 意味着按 1.08 倍速播放，解码器每秒要多出 8% 的帧。
   * 对一块刚好够用的 GPU/CPU 来说，这 8% 就是「掉帧」和「不掉帧」的分界。
   * 画面流畅优先于「贴近直播」，所以检测到掉帧就把追赶关掉。
   */
  if (dropPct > 2 && hls && hls.config && hls.config.maxLiveSyncPlaybackRate !== 1) {
    hls.config.maxLiveSyncPlaybackRate = 1;
    try { v.playbackRate = 1; } catch (err) { /* ignore */ }
  }

  // 给一句人话结论
  let verdict = '✅ 一切正常';
  let cls = 'ok';
  const lat = hls && hls.latency != null ? hls.latency : 0;
  const latTarget = hls && hls.targetLatency != null
    ? hls.targetLatency : (plan ? plan.targetLatency : 0);
  const windowText = plan && plan.known ? `${plan.windowSeconds.toFixed(0)} 秒` : '十几秒';
  // 缓冲已经顶到「源窗口允许的上限」时，再调大档位是没用的 ——
  // 只会让 hls.js 去要已经被上游删掉的分片，反而更卡。这一点必须说清楚。
  const capped = !!(plan && plan.known && ahead >= plan.maxBufferLength * 0.8);
  if (dropPct > 2) {
    const hw = hardwareDecodeState();
    const cap = state.decodeCap && state.decodeCap.h264_1080;
    if (hw.ok === false) {
      // 关键区分：同样是丢帧，软解和硬解是两种原因、两种解法。
      verdict = `❌ 解码跟不上（丢帧 ${dropPct.toFixed(1)}%），而且**现在没有在用硬件解码**` +
        `（${hw.text}）。<br>先把上面「解码」切到「自动（独显→核显→软解）」并让它重启 —— ` +
        `有独显/核显却用 CPU 软解时，1080p 很容易掉帧。` +
        (cap && !cap.supported ? '<br>注意这台机器连 H.264 都不支持硬解。' : '');
    } else {
      verdict = `❌ 解码跟不上（丢帧 ${dropPct.toFixed(1)}%）：硬件解码${hw.ok === true ? '已启用，' : ''}` +
        '说明是码率/分辨率超出了这块 GPU 的解码能力，调大缓冲没用，' +
        '建议换低码率线路（线路列表里带 Mbps）或换 HEVC 硬解支持的线路。';
    }
    cls = 'bad';
  } else if (latTarget && lat > latTarget * 2.5) {
    verdict = `⚠️ 画面已落后直播 ${lat.toFixed(0)} 秒（目标 ${latTarget.toFixed(0)}）：<br>` +
      `这类源的分片列表只有 ${windowText}，落后的分片上游已经删掉了，` +
      '正在自动跳回直播边缘。';
    cls = 'warn';
  } else if (state.holeJumps >= 3 || state.edgeSeeks >= 3) {
    verdict = `⚠️ 这条线路在丢分片（已跳过 ${state.holeJumps} 个空洞、追了 ${state.edgeSeeks} 次直播）：<br>` +
      '上游分片保留时间太短。建议换线路，或把「缓冲」档位调到「追直播」。';
    cls = 'warn';
  } else if (ahead < 5 && capped) {
    verdict = `⚠️ 缓冲 ${ahead.toFixed(1)} 秒，但已经顶到上限了：<br>` +
      `这条源的分片列表只有 ${windowText}，缓冲再多也只能这么多。` +
      '卡的话换线路，或把「缓冲」档位调到「追直播」。';
    cls = 'warn';
  } else if (ahead < 3 && !v.paused && !capped) {
    /*
     * 缓冲没顶到上限，却一直填不满 —— 这**不是**「缓冲调得不够大」，
     * 是这条线路交付速度低于码率。旧文案在这里劝用户「调大缓冲」，
     * 完全指错方向：缓冲里根本没有数据可缓。
     */
    const curLine = state.currentLine >= 0 ? state.lines[state.currentLine] : null;
    const hr = lineHeadroom(curLine);
    const mb = (bps) => (bps / 8 / 1024 / 1024).toFixed(2);
    if (hr && hr.ratio < 1.15) {
      verdict = `❌ 这条线路带宽根本不够：实测 ${mb(hr.capacityBps)} MB/s，` +
        `而这个流要 ${mb(hr.neededBps)} MB/s（${(hr.neededBps / 1e6).toFixed(1)} Mbps）。<br>` +
        `<b>调大缓冲没有用</b> —— 缓冲里没数据可缓。点「线路」换一条测速更高的，` +
        '线路列表里已经标出了每条的速度和码率。';
    } else {
      verdict = `⚠️ 前向缓冲长期填不满（${ahead.toFixed(1)} 秒，上限 ${plan ? plan.maxBufferLength.toFixed(0) : '?'} 秒）` +
        (hr ? `，但本线路实测 ${mb(hr.capacityBps)} MB/s，带宽是够的。` : '。') +
        '<br>多半是这一路源本身在抖，换一条线路试试。';
    }
    cls = 'bad';
  } else if (ahead < 5) {
    verdict = `⚠️ 缓冲偏薄（${ahead.toFixed(1)} 秒）：<br>偶发卡顿的话可以调到「抗抖动」。`;
    cls = 'warn';
  } else {
    verdict = `✅ 缓冲 ${ahead.toFixed(1)} 秒、丢帧 ${dropPct.toFixed(2)}%，当前是稳的。`;
  }
  const vd = $('statsVerdict');
  vd.innerHTML = verdict;
  vd.className = `stats-verdict ${cls}`;
}

function toggleStats(force) {
  const panel = $('statsPanel');
  const show = force === undefined ? panel.classList.contains('hidden') : force;
  panel.classList.toggle('hidden', !show);
  clearInterval(statsTimer);
  statsTimer = null;
  if (show) {
    updateStats();
    statsTimer = setInterval(updateStats, 1000);
  }
}

/* -------------------------------------------------- 拖拽文件 */

function bindDragDrop() {
  const mask = $('dropMask');
  let depth = 0;
  const show = (on) => mask.classList.toggle('hidden', !on);

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth += 1;
    show(true);
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth -= 1;
    if (depth <= 0) { depth = 0; show(false); }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    show(false);
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    const paths = files
      .map((f) => (window.hubplay && window.hubplay.pathForFile ? window.hubplay.pathForFile(f) : (f.path || '')))
      .filter(Boolean);
    if (!paths.length) {
      toast('拿不到文件路径（浏览器里拖拽只能拿到文件名，桌面版才行）', true);
      return;
    }
    await openLocalPaths(paths);
  });
}

/* -------------------------------------------------- 卡顿自动恢复 */

/**
 * 直播流卡住是常态（源站抖动、丢包、连接被中间设备回收）。
 * 这里每 2 秒检查一次时间轴有没有推进：
 *   - 意外 paused（不是用户按的）→ 尝试 play() 恢复
 *   - 连续约 12 秒没推进 → 自动切到另一条线路
 *   - 切换次数超过线路数就不再重试，避免无限循环
 */
function stopStallWatchdog() {
  clearInterval(state.stallTimer);
  state.stallTimer = null;
}

/** 当前直播分片列表的实时信息（含直播边缘位置 edge）。 */
function liveDetails() {
  const hls = state.hls;
  if (!hls || !Array.isArray(hls.levels) || !hls.levels.length) return null;
  const idx = hls.currentLevel >= 0 ? hls.currentLevel : 0;
  const level = hls.levels[idx];
  const d = level && level.details;
  if (!d || !d.live || d.edge == null) return null;
  return d;
}

/**
 * 从缓冲空洞里跳出来。
 *
 * 上游删分片很快（实测 5 分片窗口里第 3 旧的 10 秒内就 404），所以某条慢半拍的
 * 线路经常会把某个分片永久丢掉。hls.js 会跳过它，于是 buffered 变成两段、
 * currentTime 正好落在空洞里：时间轴不推进，可数据其实一直在来。
 *
 * 这种情况换线路是错的（下一条线一样会遇到），正确做法是跳到下一段起点。
 * 返回 true 表示已经跳过去了。
 */
function recoverFromBufferHole() {
  const v = video;
  const b = v.buffered;
  if (!b || !b.length) return false;
  const t = v.currentTime;

  // 播放头本来就在缓冲里 → 不是空洞问题，别乱跳
  for (let i = 0; i < b.length; i += 1) {
    if (t >= b.start(i) - 0.1 && t <= b.end(i)) return false;
  }

  // 找播放点之后最近的一段缓冲，跳过去
  let nextStart = null;
  for (let i = 0; i < b.length; i += 1) {
    if (b.start(i) > t && (nextStart === null || b.start(i) < nextStart)) nextStart = b.start(i);
  }
  if (nextStart === null) return false;

  try {
    v.currentTime = nextStart + 0.05;
  } catch (err) {
    return false;
  }
  state.holeJumps += 1;
  v.play().catch(() => {});
  toastThrottled('分片被上游删掉了，已跳过这段空洞', 6000);
  return true;
}

/**
 * 在**已缓冲范围内**向前跳到最靠近直播边缘的位置。
 *
 * 与 seekToLiveEdge 的区别：这里保证落点已经下载好了，所以是**瞬间完成**的，
 * 不会像 seek 到未缓冲区域那样再卡一次。用于「缓冲很足、但播放点落后太多」。
 *
 * 什么时候会出现这种状态：目标延迟被 `liveMaxLatencyDurationCount` 约束住，
 * 但那个参数只管**起播位置**，播放中途落后了它不会拉回来；`maxLiveSyncPlaybackRate`
 * 的 8% 提速要 4~5 分钟才能追回 20 秒。所以必须有一次即时跳转。
 *
 * @returns true 表示跳了
 */
function skipAheadWithinBuffer(reason) {
  const d = liveDetails();
  const b = video.buffered;
  if (!d || !b || !b.length) return false;
  if (state.edgeSeeks >= 12) return false;
  const bufEnd = b.end(b.length - 1);
  const plan = state.livePlan;
  const target = (plan && plan.targetLatency) || (state.hls && state.hls.targetLatency) || 6;
  // 落点夹在缓冲范围内，保证「跳过去立刻就有画面」
  const want = Math.min(Math.max(d.start || 0, d.edge - target), bufEnd - 1);
  if (!(want > video.currentTime + 3)) return false;
  try {
    video.currentTime = want;
  } catch (err) {
    return false;
  }
  state.edgeSeeks += 1;
  video.play().catch(() => {});
  toastThrottled(`画面落后直播过多，已在缓冲内跳到最靠前的位置` +
                 (reason ? `（${reason}）` : ''), 8000);
  return true;
}

/**
 * 把播放点拉回直播边缘。
 *
 * 直播里最要命的不是「没数据」，而是「漂远了」：每卡一次播放点就更落后一点，
 * 而落后的分片又已经被删，于是永远追不回来 —— 统计面板上就会出现
 * 「前向缓冲 48.8 秒 / 目标 46.0」却一直卡。跳回 edge - 目标延迟 就能自愈，
 * 因为那一段分片一定是新的、一定还在。
 */
function seekToLiveEdge(reason) {
  const d = liveDetails();
  if (!d) return false;
  // 上限保护：源真正病态时不能无限跳（次数在面板上可见）
  if (state.edgeSeeks >= 12) return false;
  const hls = state.hls;
  const plan = state.livePlan;
  const target = (plan && plan.targetLatency) || hls.targetLatency || 6;
  const want = Math.max(d.start || 0, d.edge - target);
  if (!(want > video.currentTime + 0.5)) return false;
  try {
    video.currentTime = want;
  } catch (err) {
    return false;
  }
  state.edgeSeeks += 1;
  video.play().catch(() => {});
  toastThrottled(`画面落后直播 ${(hls.latency || 0).toFixed(0)} 秒，已跳回直播边缘` +
                 (reason ? `（${reason}）` : ''), 6000);
  return true;
}

/**
 * 「数据停供多久」才算真僵住。
 *
 * 这个值是整套卡顿处理的宽容度：在这段时间内只要缓冲末端还在长，就说明源还活着，
 * 我们只等不动手。8 秒约等于这些源 1~2 个分片的节奏。
 */
const STALL_QUIET_MS = 8000;

function startStallWatchdog() {
  stopStallWatchdog();
  let lastTime = -1;
  let stalls = 0;
  /**
   * 是否已经真的出过画。
   *
   * 必须区分「还没起播」和「出画之后卡住」：这些源单分片 5~7MB（10~13Mbps），
   * hls.js 起播前要先把分片拉回来并 append 进 MSE，实测从点击到第一帧要 5~25 秒
   * （复现脚本 tools/e2e/probe.js）。老代码从点开那一刻就开始数「时间轴没推进」，
   * 12 秒（6 个 tick）到点就把一条还没出画的线路判死切走，而且提示是
   * 「画面卡住超过 12 秒」——可它根本还没显示过任何画面，用户完全看不懂。
   * 所以没出画之前一律不计停滞，起播期的判活交给下面按「有没有进展」判定的起播兜底。
   */
  let seenPicture = false;
  state.stallTimer = setInterval(() => {
    const attempt = state.activeAttempt;
    // 注意用 < 0 而不是 !state.currentId：列表第一个频道 id 就是 0，
    // 写成 !state.currentId 会让 id=0 的频道永远没有卡顿保护。
    if (!attempt || state.playToken !== attempt.token || state.currentId < 0) return;
    const v = video;

    if (state.userPaused) {
      stalls = 0;
      lastTime = v.currentTime;
      return;
    }

    // 不是用户暂停，却处于 paused：尝试叫醒
    if (v.paused && v.readyState >= 2) {
      v.play().catch(() => {});
    }

    /*
     * 「画面卡住」从**真的出过画**那一刻起才有意义。
     * 老写法是 `if (v.readyState >= 2) seenPicture = true;` —— 有数据就算出过画，
     * 于是解码器不出帧时这里不再保护，只当成普通卡顿数 20 秒然后换线路，
     * 面板上的提示还是「画面卡住超过 20 秒」，可它根本没显示过任何画面。
     * 判据改成帧读数（时间轴在推进 / 有分辨率），见 frameReport()。
     */
    if (pictureSeen(recordFrame())) seenPicture = true;
    if (!seenPicture) {
      lastTime = v.currentTime;
      stalls = 0;
      return;
    }

    /*
     * ⚡ spinner 兜底 —— 踩过的坑（2026-10-07 02:2x 用户截图）：
     * 「起播等待」那句提示会一直挂在画面上，可底下画面明明已经在播。
     * 原因是 `succeed()` 只在**直解路径**里注册（onPlaying / onLoadedData），
     * 而 ffmpeg 预判路径是直接 return 的 —— 那条路线上没人负责关 spinner。
     * 所以在这里兜一道：只要画面真的在动（上面 pictureSeen 已确认），
     * 不管走哪条路径，都把转圈提示收掉。每秒都在跑，最多多显示 1 秒。
     */
    /*
     * 画面在动，说明之前那个「播放失败」已经过时了 —— 无条件收起。
     *
     * 实测（2026-10-10 CCTV13）：旧实例的迟到 bufferIncompatibleCodecsError
     * 在画面上弹了个「ffmpeg 转码播放失败」，而底下 CCTV13 明明在播，
     * 那个面板再也没人收 —— 因为原来的收起条件要求 spinner 还挂着。
     */
    const spEl = $('spinner');
    const errEl = $('errorBox');
    const wasShowing = (spEl && !spEl.classList.contains('hidden')) || (errEl && !errEl.classList.contains('hidden'));
    setSpinner(false);
    hideError();
    if (wasShowing) renderLinePanel();   // 只在真的收掉东西时才重绘面板，别每 2 秒刷一次

    if (Math.abs(v.currentTime - lastTime) < 0.05) stalls += 1;
    else stalls = 0;
    lastTime = v.currentTime;

    /*
     * 「喂不满码率」和「卡住」要分开判。
     * 卡住 = 时间轴不动（下面处理）；喂不满 = 时间轴在动、但前向缓冲长期填不满。
     * 后者的表现是画面一顿一顿像 PPT，而面板上「丢帧 0」、「前向缓冲 1.5 秒」、
     * 「离直播边缘」一路变大 —— 用户截图里就是这一组数字。
     * 它必须在这里拦下来，否则看门狗永远不触发，用户只能一直看幻灯片。
     */
    const bufEndNow = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
    const aheadNow = Math.max(0, bufEndNow - v.currentTime);
    /*
     * 「数据还在不在来」的判据：缓冲末端有没有继续长。
     *
     * 这一条是整个卡顿处理的分水岭 —— 前向缓冲薄、但数据一直在来，是**慢源**，
     * 等着就行（VLC / mpv / PotPlayer 全都这么干）；缓冲薄、而且连续几秒
     * 一点新数据都没有，才叫**真僵住**，那才值得动手。
     */
    if (bufEndNow > (state.bufEndSeen || 0) + 0.05) {
      state.bufEndSeen = bufEndNow;
      state.lastDataAt = Date.now();
    } else if (bufEndNow < (state.bufEndSeen || 0)) {
      state.bufEndSeen = bufEndNow;   // MediaSource 重建 / 换台后缓冲重置
    }
    if (checkStarvation(attempt, aheadNow)) {
      stalls = 0;
      return;
    }

    /*
     * 落后直播太多、但缓冲是满的 —— 立刻在缓冲内往前跳。
     *
     * 这种状态很隐蔽：缓冲 29 秒、丢帧 0、画面也不卡，但离直播已经 31 秒，
     * 而且只会越来越远（hls.js 的 8% 提速要几分钟才追得回来）。
     * 面板上那句「正在自动跳回直播边缘」如果没有这个函数就是空话。
     */
    const latNow = state.hls && state.hls.latency;
    const tgtNow = state.hls && state.hls.targetLatency;
    if (latNow && tgtNow && latNow > Math.max(tgtNow * 2.5, 15) && aheadNow > 3) {
      if (skipAheadWithinBuffer('落后直播过多')) {
        stalls = 0;
        lastTime = v.currentTime;
        return;
      }
    }

    /*
     * ⚡ 先「救活加载器」—— 这是实测抓到的一个真 bug（2026-10-07 02:05 日志）。
     *
     * 现象：服务端 EVENT 列表里**分片早就写好了**（目录里 0~36 片齐全、产出 1.46× 实时），
     * 播放器却整整 26 秒**一个分片都没去请求**（日志里 FRAG_LOADED 从 seg00006 直接跳到 seg00023），
     * 缓冲见底、时间轴停在 10.98，最后靠 hls.js 跳到直播边缘才恢复。
     * 期间 `v.paused` 是 true、`readyState` 还是 4 —— 播放器在等一个永远不会自己来的分片。
     *
     * 根因是 hls.js 的流控制器在流卡住后会停下加载（它的缓冲/加载状态机进入 idle），
     * 而它自己的 nudge 重试对「MSE 缓冲没数据」这种情况不一定能唤醒。
     * 所以这里由我们从外面踹一脚：`startLoad()` 重新挂上加载、`play()` 重新起播。
     * 只要前向缓冲已经见底（< 1.5 秒）就动手，不等它自己悟。
     */
    if (aheadNow < 1.5 && state.hls) {
      /*
       * 前向缓冲见底 ≠ 播放器坏了（2026-10-10 重写）。
       *
       * hls.js 官方文档写得很直白：recoverMediaError()「Resets the MediaSource
       * and restarts streaming from the last known playhead position. This should
       * only be used when the media element is in an error state. It should not be
       * used in response to non-fatal hls.js error events.」
       * 而「缓冲见底」正是非致命状态。VLC / mpv / PotPlayer 在这种情况下的做法
       * 只有两个字：**等**。数据一到接着播，时间轴不跳、缓冲不清。
       *
       * 实测（2026-10-10 21:46~21:48 现场日志）：旧逻辑在 3 分钟里重建了 9 次
       * MediaSource，每次都是一次可见黑屏；而那条源一直在约 1× 产出 ——
       * 是我们自己的「救援」把前向缓冲一次次数清零的（重建后播放头落在最新数据处，
       * 前向缓冲只剩几秒，下一次抖动必然又见底，于是越救越糟）。
       *
       * 现在分三档：
       *   ① 时间轴还在动（stalls === 0）→ 什么都不做，等源补数据；
       *   ② 时间轴不动，但缓冲末端还在长（8 秒内来过数据）→ 也等；
       *   ③ 时间轴不动、且连续 8 秒没有任何新数据 → 这才是真僵住：
       *      先 startLoad()（hls.js 自己的低级重试），仍僵再 recoverMediaError()。
       */
      const quietMs = Date.now() - (state.lastDataAt || 0);
      if (stalls === 0) return;
      if (quietMs < STALL_QUIET_MS) return;

      state.loaderRescues = (state.loaderRescues || 0) + 1;
      const hard = state.loaderRescues >= 2;
      diagPush('play', `真僵住（前向 ${aheadNow.toFixed(1)}s，${(quietMs / 1000).toFixed(0)}s 没有新数据），` +
        `${hard ? '重建 MediaSource（recoverMediaError）' : '救活加载器（startLoad）'}（第 ${state.loaderRescues} 次）`,
      state.loaderRescues > 6 ? 'warn' : 'ok');
      state.lastDataAt = Date.now();
      /*
       * 顺手问一次服务端产出：卡顿现场能立刻分清是「ffmpeg 没写出来」还是
       * 「写了但客户端没取」。实测（02:16/02:18 日志）都是后者 ——
       * 服务端分片一直在写，是 hls.js 的加载器僵住了。
       */
      if (state.remuxSid) {
        fetch(`/api/remux/status?id=${encodeURIComponent(state.remuxSid)}`)
          .then((r) => r.json())
          .then((j) => {
            const ss = j && j.session;
            if (ss) {
              diagPush('ffmpeg', `救援时会话：分片=${ss.segments} seq=${ss.mediaSequence} ` +
                `已缓=${video.buffered.length}段`, 'warn');
            }
          })
          .catch(() => {});
      }
      try {
        /*
         * 走到这里说明源**真的停供了**，那才是 hls.js 文档里说的 error 状态：
         * 第一次先 startLoad()（最低干预，hls.js 自己会重新挂上加载），
         * 第二次仍僵住才 recoverMediaError()（重建 MediaSource —— 有代价，
         * 会黑一下，所以不再拿它当常规手段）。
         */
        if (hard) state.hls.recoverMediaError(); else state.hls.startLoad();
      } catch (err) { /* ignore */ }
      if (v.paused) v.play().catch(() => {});
      stalls = 0;
      lastTime = v.currentTime;
      return;
    }

    /*
     * 卡住时先别急着换线路。
     *
     * 直播卡住十有八九是两件事之一：
     *   1. 某个分片被上游删了，留下一个空洞（buffered 断成两段）；
     *   2. 播放点漂到源窗口以外，要的分片都不存在了。
     * 这两件事**换线路解决不了**（下一条线一样会遇到），但跳一下就能立刻恢复。
     * 所以先试「跳过空洞 / 跳回直播边缘」，跳不动了才判定这条线路不可用。
     * 上限 12 次，避免在一条真的坏掉的线路上无限跳。
     */
    if (stalls >= 5 && (state.holeJumps + state.edgeSeeks) < 12) {
      if (recoverFromBufferHole() || seekToLiveEdge('画面卡住')) {
        stalls = 0;
        lastTime = v.currentTime;
        return;
      }
    }

    // 慢源缓冲见底后恢复可能要十几秒，12 秒太急，放宽到 20 秒
    if (stalls < 10) return; // 约 20 秒
    stalls = 0;

    // 卡死的线路要和「连不上」一样被判为不可用，走同一套顺延逻辑，
    // 否则面板上这条线路还显示正常，实际早就被跳过了。
    const { candidates, index } = attempt;
    abandonLine(candidates, index, '画面卡住超过 20 秒');
  }, 2000);
}

/**
 * 「喂不满码率」检测 —— 和「卡住」是完全不同的故障，必须分开处理。
 *
 * 症状（用户截图里的那组数字就是它）：
 *   前向缓冲 1.5 秒（而上限是 14 秒）、丢帧 0、时间轴在动但一顿一顿像 PPT、
 *   离直播边缘越来越大（因为它播得比实时慢，直播边缘却在正常前进）。
 *
 * 关键区别：**时间轴在推进，所以卡顿看门狗永远不会触发。**
 * 这不是「缓冲不够」——hls.js 根本没够到上限，是这条线路**交付速度低于码率**。
 * 1080p 大约需要 1.3 MB/s，而同一频道的线路能差 8 倍。
 *
 * 所以唯一有效的动作是**换一条更快的线路**；换不了就跳回直播边缘，
 * 至少别让它一路漂到几分钟之后。调缓冲、跳空洞在这里都是白费力气。
 *
 * @returns true 表示已经采取了动作
 */
function checkStarvation(attempt, ahead) {
  const now = Date.now();
  if (ahead < 2) {
    if (!state.thinSince) state.thinSince = now;
  } else if (ahead >= 3) {
    state.thinSince = null;   // 缓过来了，重新计时
    return false;
  } else {
    return false;
  }
  /*
   * 连续多久填不满才算「喂不饱」：转码档要放宽。
   *
   * 实测（2026-10-07 02:10 日志）：转码档刚起播时缓冲只有 0~2 秒（ffmpeg 还在追赶），
   * 8 秒的阈值就把**正在正常工作的转码线路**判成「喂不满码率」并拉黑了 ——
   * 而它其实是唯一能播这条 MPEG-2 源的路。转码档天然带一层缓冲（源→ffmpeg→分片→MSE），
   * 起播阶段的低缓冲不代表这条线路不行。所以转码档给 20 秒观察期。
   */
  const thinMs = (state.wantFfmpeg || state.ffmpegFallback) ? 20000 : 8000;
  if (now - (state.thinSince || now) < thinMs) return false;
  /*
   * 「薄」不等于「坏」（2026-10-10 补这道闸）。
   *
   * 只要缓冲末端还在长，这条线路就一直在交付数据 —— 慢归慢，它能一直播下去，
   * 而这正是 VLC / PotPlayer 面对慢源时的表现。以前这里只看「缓冲低于 2 秒」
   * 的时长，于是一条稳定但偏慢的线路会被判成「喂不满码率」直接拉黑换线，
   * 面板上就出现一屏红色的「带宽不够 / 喂不满码率」。
   * 现在要求源**真的停供**（连续 8 秒没有新数据）才走换线逻辑。
   */
  if (now - (state.lastDataAt || 0) < STALL_QUIET_MS) return false;
  state.thinSince = null;

  const { candidates, index } = attempt;
  const cur = state.lines[index];
  const curKb = (cur && lineSpeedCache.get(cur.url)) || 0;

  // 找一条实测确实更快的、还没试过的线路
  let better = -1;
  let betterKb = 0;
  for (const i of candidates) {
    if (i === index || state.failures.has(i)) continue;
    const kb = lineSpeedCache.get(state.lines[i].url) || 0;
    if (kb > 0 && kb > curKb * 1.3 && kb > betterKb) { better = i; betterKb = kb; }
  }

  if (better >= 0) {
    state.starveSwitches += 1;
    // 换线路 = 把这条标记成不可用再顺延；candidates 已按实测速度降序，
    // 所以顺延过去的必然是更快的那条。提示交给 abandonLine，别重复弹。
    abandonLine(candidates, index,
      `喂不满码率（缓冲长期低于 2 秒${curKb ? `，实测 ${(curKb / 1024).toFixed(1)} MB/s` : ''}` +
      `${betterKb ? `，换到 ${(betterKb / 1024).toFixed(1)} MB/s 的线路` : ''}）`);
    return true;
  }

  // 没有更快的线路可换：跳回直播边缘，别让延迟无限增长
  return seekToLiveEdge('带宽不足，停止落后');
}

/** 把某条线路标记为不可用，并顺延到下一条没试过的线路；都没有了就报错收尾。 */
function abandonLine(candidates, index, reason) {
  state.lastFailReason = reason;
  state.failures.add(index);
  state.failReasons.set(index, reason);
  diagPush('line', `${lineLabel(index + 1)} 不可用：${reason}（已失败 ${state.failures.size}/${candidates.length}）`, 'warn');
  renderLinePanel();
  stopStallWatchdog();

  const next = candidates.find((i) => !state.failures.has(i));
  if (next === undefined) {
    state.currentLine = -1;
    renderLinePanel();
    updateOsdLine(-1);
    setSpinner(false);
    /*
     * 逐条列出失败原因，而不是只报最后一条。
     * 老写法只给「最后一条失败原因」，用户没法判断是源的问题还是线路的问题；
     * 现在每条线路后面跟着它自己的原因（含预检判死的那批）。
     */
    const detail = candidates
      .map((i) => {
        const r = state.failReasons.get(i);
        return `线路${lineLabel(i + 1)}：${r ? escapeHtml(r) : '未尝试'}`;
      })
      .join('<br>');
    showError(
      '所有线路都放不出来',
      `已依次尝试全部 ${candidates.length} 条线路，都不行。<br>` +
        `<div class="err-list">${detail}</div>` +
        '线路池里混着死线是常态（源站只发列表不发分片、或主机连不上）。<br>' +
        '可以稍后点下面的按钮重试，或换一个频道。',
      true
    );
    toast('所有线路都放不出来，已停止重试', true);
    return;
  }
  toast(`${lineLabel(index + 1)} 不可用（${reason}），自动切到 ${lineLabel(next + 1)}`, true);
  startAttempt(candidates);
}

function destroyPlayer() {
  clearTimeout(state.watchdog);
  state.watchdog = null;
  stopHealthCheck();
  stopDecodeWatchdog();
  state.pictureAt = null;
  state.pictureSince = null;
  state.lastFrame = null;
  // 移除上一轮 startAttempt 注册的 video 监听器，避免换台时累积成百上千个悬挂监听
  if (Array.isArray(state.attemptHandlers)) {
    for (const [ev, h] of state.attemptHandlers) {
      try { video.removeEventListener(ev, h); } catch (_) { /* ignore */ }
    }
  }
  state.attemptHandlers = [];
  stopStallWatchdog();
  /*
   * 实例序号自增：被销毁的 hls.js 实例还有排队中的事件（ERROR 尤其致命 ——
   * 实测 2026-10-10 22:16 与 CCTV13 那次，迟到的 bufferAddCodecError /
   * bufferIncompatibleCodecsError 把刚建好的会话又拆一次，或者直接在画面上
   * 弹一个「播放失败」而底下画面其实在播）。所有事件回调都会先比对序号。
   */
  state.hlsSeq += 1;
  if (state.hls) {
    try { state.hls.destroy(); } catch (err) { /* ignore */ }
    state.hls = null;
  }
  if (state.mpegts) {
    try { state.mpegts.destroy(); } catch (err) { /* ignore */ }
    state.mpegts = null;
  }
  if (state.flv) {
    try { state.flv.destroy(); } catch (err) { /* ignore */ }
    state.flv = null;
  }
  video.removeAttribute('src');
  try { video.load(); } catch (err) { /* ignore */ }
}

/** 左上角信息条：频道 + 正在使用哪条线路 */
function updateOsdLine(index) {
  const parts = [state.osdBase];
  const line = state.lines[index];
  if (line) {
    parts.push(`${lineLabel(index + 1)} · ${KIND_LABEL[line.kind] || line.kind}`);
    const speed = fmtSpeed(line.speed);
    if (speed) parts.push(speed);
  } else {
    parts.push('无可用线路');
  }
  $('osdSub').textContent = parts.filter(Boolean).join(' · ');
}

async function playChannel(id) {
  const key = String(id);
  const channel = allChannels().find((c) => String(c.id) === key);
  if (!channel) return;
  if (channel.local) return playLocalEntry(channel);

  state.currentId = channel.id;
  state.mode = 'stream';
  $('liveTag').classList.remove('hidden');
  highlightRow(id);
  hideError();
  applySidebar();
  saveConfig({ lastChannel: channel.favKey });
  $('nowPlaying').textContent = channel.name;
  $('controls').classList.remove('hidden');
  $('osdTitle').textContent = channel.name;
  state.osdBase = [channel.group, channel.sources].filter(Boolean).join(' · ');
  $('osdSub').textContent = state.osdBase;
  $('osd').classList.remove('hidden');
  $('placeholder').classList.add('hidden');
  setSpinner(true, '正在获取线路…');

  let data;
  try {
    const r = await fetch(`/api/lines?id=${id}`);
    data = await r.json();
    if (!data.ok) throw new Error(data.error || '线路获取失败');
  } catch (err) {
    setSpinner(false);
    showError('线路获取失败', escapeHtml(String(err.message || err)));
    return;
  }

  state.lines = data.lines || [];
  state.failures = new Set();
  state.failReasons = new Map();
  state.currentLine = -1;
  state.userPaused = false;
  state.wantFfmpeg = false;     // 换台/换频道都重新判定，别把上一个频道的结论带过来
  state.ffmpegTried = false;
  state.ffmpegFallback = false;
  state.ffmpegVideoMode = 'copy';   // 视频先按「换壳」试，被浏览器拒了再重编（见下面的 CodecError 处理）
  state.ffmpegHandoffAt = 0;
  state.transcodeRetryAt = 0;
  state.lastFailReason = '';
  renderLinePanel();

  const RANK = { hls: 0, file: 0, audio: 0, flv: 1, unknown: 2, rawts: 3 };
  /**
   * 候选线路排序。
   *
   * 实测最容易踩的坑：列表顺序经常把最慢的线路排在最前（CCTV1 第一条 1.1 MB/s，
   * 第十条 9.7 MB/s，差 8.8 倍），按顺序挑就会一直卡。
   * 所以**已知实测速度的按速度降序**。
   *
   * 速度相同时（或都没测速）再按「Chromium 能不能直解」排：
   * 直解 → 换壳 → 只能转码。差别是实打实的 CPU —— 直解零成本，
   * 转码要实时编 H.264。能用直解的线路，就没理由先去转码。
   */
  const TIER_RANK = { direct: 0, remux: 1, transcode: 2 };
  const tierOf = (i) => {
    const l = state.lines[i];
    const cv = l && codecCache.get(l.url);
    if (!cv) return 1;                       // 没探到，按中间档，别奖励也别惩罚
    const verdict = codecVerdict(cv);
    if (verdict && verdict.tier === 'ffmpeg') return 2;
    return TIER_RANK[cv.tier] ?? 1;
  };
  const orderCandidates = () => state.lines
    .map((l, i) => i)
    .filter((i) => state.lines[i].playable)
    .sort((a, b) => {
      const sa = lineSpeedCache.get(state.lines[a].url) || 0;
      const sb = lineSpeedCache.get(state.lines[b].url) || 0;
      if (sa !== sb) return sb - sa;   // 有实测速度的排前面，快的优先
      const ta = tierOf(a);
      const tb = tierOf(b);
      if (ta !== tb) return ta - tb;   // 同样快时，优先能直解的
      return (RANK[state.lines[a].kind] ?? 9) - (RANK[state.lines[b].kind] ?? 9);
    });

  if (!orderCandidates().length) {
    setSpinner(false);
    const kinds = Array.from(new Set(state.lines.map((l) => l.kind))).join(' / ') || '未知';
    showError(
      '这个频道没有浏览器能播的线路',
      `共 ${state.lines.length} 条线路，格式为 <b>${escapeHtml(kinds)}</b>。<br>` +
        'RTSP / RTMP 这类需要专用播放器；裸 TS（/rtp/）本来可以走 mpegts.js，' +
        '但如果是 HEVC 编码 Chromium 也解不了。<br>' +
        '换一个频道，或在 iptv-hub 里给这个频道补一条 HLS 线路。'
    );
    return;
  }

  /*
   * 起播前先测速挑最快的那条。
   *
   * 这一步是「1080p 卡成 PPT」的正面解法：卡顿的根源经常不是缓冲不够，
   * 而是**这条线路根本喂不满这个码率**。慢线路再怎么调缓冲都没用，
   * 换到快线路立刻就好。测速很便宜，且结果按 URL 缓存，只在一个会话里付一次。
   */
  if (state.lines.filter((l) => l.playable).length > 1) {
    const token0 = state.playToken;
    setSpinner(true, '正在测速，挑选最快的线路…');
    const measured = await ensureLineSpeeds(state.lines.map((l, i) => i).filter((i) => state.lines[i].playable));
    if (state.playToken !== token0) return;   // 测速期间用户换台了
    if (measured) renderLinePanel();
  }

  /*
   * 探编码 —— 这一步是「点开能播、不用先撞二十秒墙」的关键。
   *
   * 只探排序靠前的几条（真正会用的就是它们），每条实测 0.46 秒、并发 4。
   * 探完把结论写进 codecCache，orderCandidates() 的 tierOf() 会用它排序，
   * startAttempt() 会用它决定「直解」还是「交给 ffmpeg」。
   */
  {
    const token0 = state.playToken;
    setSpinner(true, '正在识别线路编码…');
    const ordered = orderCandidates();
    await probeLineCodecs(ordered);
    if (state.playToken !== token0) return;
    renderLinePanel();
  }

  const candidates = orderCandidates();
  const fastest = lineSpeedCache.get(state.lines[candidates[0]].url) || 0;
  if (fastest > 0) {
    toast(`已选实测最快的 ${lineLabel(candidates[0] + 1)}（${(fastest / 1024).toFixed(1)} MB/s）`);
  }

  // 封面/占位换成该频道相关信息
  state.candidates = candidates;
  startAttempt(candidates);
  // 后台继续把剩余线路（超出 16 条或刚才没测到的）补测一遍，只用于展示
  if (candidates.length > 1) probeLineSpeeds();
}

/**
 * 依次尝试候选线路。
 *
 * 统一模型：只认 state.failures 这个集合。
 * 「连不上」和「卡死」都往里加，每次挑第一条还没被标记的线路来试；
 * 全都标记完了就明确报错收尾。这样面板上的状态永远和实际行为一致。
 */
async function startAttempt(candidates, engineQueue) {
  const token = ++state.playToken;

  /*
   * 每次「重新开始试一条线路」都先清掉「正由 ffmpeg 接管」的标记。
   * 否则手动从 MPEG-2 线路切到能直解的 H.264 线路后，这个标记还留着，
   * 面板会一直显示「ffmpeg 转码中」，看门狗也会按转码档的宽阈值计时。
   * （wantFfmpeg 不清：它是「已判定 Chromium 解不了」的结论，换线路时由上层重置。）
   */
  if (!state.wantFfmpeg) state.ffmpegFallback = false;

  /*
   * 预判编码：Chromium 没有这个解码器的流，直接交给内置 ffmpeg，
   * 不要先花二十秒让 hls.js 解析失败再逐条换线路。
   *
   * 这是「VLC / PotPlayer 能播、我们播不了」的**正面解法**：
   * 它们的解码器来自 libav，我们内置的 ffmpeg 就是同一个 libav。
   * 差别只在于要在播放之前就问清楚，而不是等播放器撞墙。
   *
   * 只在第一条候选上判定：能直解就用直解（零 CPU），
   * 判定要转码就直接起 ffmpeg，不浪费测速和试错的时间。
   */
  /*
   * ⚡ 起播前的可用性预检（2026-10-07 新增）。
   *
   * 起因：换到某个聚合源后，点某个频道只看到
   * 「未知 / FLV 解码失败」。实测那条频道 10 条镜像里**只有 1 条真能播**，
   * 其余 9 条是两类死线：连不上（4 条）、列表能拿但分片被源站 404 挡回（5 条）。
   *
   * 「列表能拿到」这一条最坑人 —— 它是合法的 m3u8，只探容器必然判成 hls 可用，
   * 于是要等 hls.js 逐级失败（hls → mpegts → flv）才肯放手，一条白烧十几秒，
   * 最后报出来的还是最后一级引擎的话（「FLV 解码失败」），和真实原因毫无关系。
   *
   * 所以这里在真正起播之前，先把候选里「列表能拿但分片取不到」的死线挑出来，
   * 标进 failures 并**带上原因**，让播放直接落到那条能用的线路上，
   * 同时让面板显示真实原因而不是引擎的临终遗言。
   */
  if (!state.wantFfmpeg && candidates.length > 1) {
    const pool = candidates.filter((i) => !state.failures.has(i)).slice(0, 6);
    let done = 0;
    const alive = [];
    await Promise.all(pool.map(async (i) => {
      const ln = state.lines[i];
      if (!ln || !ln.url) return;
      try {
        const hit = await sniffLine(ln, { preflight: true, timeoutMs: 9000 });
        if (hit.kind === 'dead') {
          state.failures.add(i);
          state.failReasons.set(i, `源不可用：${hit.reason}`);
        } else {
          alive.push(i);
          if (hit.kind && hit.kind !== 'unknown') ln.kind = hit.kind;
        }
      } catch (err) {
        alive.push(i);   // 预检失败不代表线路死，交给正常流程

      } finally {
        done += 1;
        if (state.playToken === token) {
          setSpinner(true, `正在预检线路可用性…（${done}/${pool.length}）`);
          renderLinePanel();
        }
      }
    }));
    if (state.playToken !== token) return;
    const still = candidates.filter((i) => !state.failures.has(i));
    if (!still.length) {
      setSpinner(false);
      const why = pool.map((i) => `线路${lineLabel(i + 1)}：${state.failReasons.get(i) || '不可用'}`).join('<br>');
      showError(
        '这个频道的线路都不可用',
        why + '<br>预检发现它们的播放列表能拿到，但分片被源站拒绝（换 UA / 换分片序号都一样）。<br>' +
          '可以点下面的按钮重试（源站可能只是一时抖），或换一个频道。',
        true
      );
      return;
    }
  }

  if (!state.wantFfmpeg) {
    const first = candidates.find((i) => !state.failures.has(i));
    if (first !== undefined) {
      const line0 = state.lines[first];
      let cv = line0 && line0.url ? codecCache.get(line0.url) : null;
      if (!cv && line0 && line0.url) {
        setSpinner(true, `正在识别 ${lineLabel(first + 1)} 的编码…`);
        cv = await probeLineCodec(line0);
        if (state.playToken !== token) return;
      }
      const verdict = cv ? codecVerdict(cv) : null;
      /*
       * token 守卫：等编码探测期间用户又点了一次频道/线路的话，这一轮已经是旧的了。
       * 没有这道守卫时，旧的 startAttempt 会继续往下走并把 ffmpeg 拉起来接管，
       * 把新那一轮**已经出画**的播放掐掉重来 —— 实测日志里就是「已出画 → 被接管」。
       */
      if (state.playToken !== token) return;
      if (verdict && verdict.tier === 'ffmpeg') {
        state.wantFfmpeg = true;
        state.ffmpegTried = true;
        toast(
          `${lineLabel(first + 1)} 是 ${describeCodec(cv)}，${verdict.reason}：` +
          '直接交给内置 ffmpeg 转码（不消耗时间试错）'
        );
        destroyPlayer();
        // 把「被判要转码的这条线路」明确交给 ffmpeg，别让它自己再去挑（见 tryFfmpegFallback 注释）
        const started = await tryFfmpegFallback(verdict.reason, first);
        if (state.playToken !== token) return;
        if (started) {
          /*
           * ⚠️ 这条 return 绕过了下面整套逐线路逻辑，所以必须**自己把两个看门狗挂上**：
           *   armFallbackWatchdog —— 起播超时就把真实状态摆出来；
           *   armDecodeWatchdog  —— 「有数据但不出帧」的专用判官。
           *
           * 更关键的是 `state.activeAttempt`：卡顿看门狗（startStallWatchdog）第一行就
           * 检查它，**没有它整条看门狗从第一秒起就是空转的** —— 不检测饿死、不跳空洞、
           * 不救援加载器、也不换线路。实测（2026-10-07 02:07 日志）：ffmpeg 路径上出现过
           * 26 秒 / 24 秒的卡死窗口，期间播放器一个分片都没请求，而所有保护逻辑都在睡觉。
           * 之前只在直解路径赋过这个值，ffmpeg 路径漏了 —— 这里补上。
           */
          state.currentLine = first;
          state.activeAttempt = { candidates, index: first, token };
          startStallWatchdog();
          armFallbackWatchdog(token);
          armDecodeWatchdog(token, { ffmpegMode: true });
          diagPush('play', `转码档保护已挂上：activeAttempt=线路${first + 1}`, 'ok');
          return;
        }
        // ffmpeg 都没起来：退回逐条线路试（可能刚好这条线路本身有问题）
        state.wantFfmpeg = false;
        state.ffmpegTried = false;
      }
    }
  }

  const index = candidates.find((i) => !state.failures.has(i));
  if (index === undefined) {
    stopStallWatchdog();
    // 浏览器三个引擎都试过了还是不行 —— 交给 ffmpeg。
    // 这一步是「PotPlayer 能播、我们播不了」的正面解法：
    // 不再直接报错，而是用内置 ffmpeg 把流转成 Chromium 一定能播的 H.264/AAC HLS。
    if (!state.ffmpegTried) {
      state.ffmpegTried = true;
      const lastReason = state.lastFailReason || '引擎不支持';
      const ok = await tryFfmpegFallback(lastReason);
      if (ok) return;
    }
    state.currentLine = -1;
    renderLinePanel();
    updateOsdLine(-1);
    setSpinner(false);
    const detail2 = candidates
      .map((i) => {
        const r = state.failReasons.get(i);
        return `线路${lineLabel(i + 1)}：${r ? escapeHtml(r) : '浏览器引擎与 ffmpeg 都没成功'}`;
      })
      .join('<br>');
    showError(
      '所有线路都放不出来',
      `已依次尝试全部 ${candidates.length} 条线路，并且 ffmpeg 接管也没成功。<br>` +
        `<div class="err-list">${detail2}</div>` +
        '可以稍后点下面的按钮重试，或换一个频道。',
      true
    );
    return;
  }

  const tried = candidates.filter((i) => state.failures.has(i)).length;
  const line = state.lines[index];
  // 记下地址：全部线路都失败时，「用外部播放器打开」要拿它去交给 PotPlayer/VLC/mpv
  if (line && line.url) state.lastTriedUrl = line.url;
  state.currentLine = index;
  renderLinePanel();
  updateOsdLine(index);
  setSpinner(true, `正在连接 ${lineLabel(index + 1)}（第 ${tried + 1}/${candidates.length} 条）…`);

  destroyPlayer();

  state.activeAttempt = { candidates, index, token };
  state.holeJumps = 0;
  state.edgeSeeks = 0;
  state.thinSince = null;
  state.parseFails = 0;
  startStallWatchdog();
  armDecodeWatchdog(token, { ffmpegMode: !!state.wantFfmpeg || !!state.ffmpegFallback });

  const fail = (reason) => {
    if (state.playToken !== token) return;
    abandonLine(candidates, index, reason);
  };

  /** 这个引擎放不出来时，先在同一条线路上换引擎，都试完才判定这条线路不可用。 */
  const failNextEngine = (reason) => {
    if (state.playToken !== token) return;
    if (engines.length > 1) {
      const rest = engines.slice(1);
      toast(`${ENGINE_LABEL[engine] || engine} 放不出来（${reason}），改用 ${ENGINE_LABEL[rest[0]] || rest[0]} 再试`);
      startAttempt(candidates, rest);
      return;
    }
    fail(reason);
  };

  /*
   * ⚠️ succeed 只在「真的出画」时才算成功。
   *
   * 老写法是事件一到就 succeed：清看门狗、清 spinner。可是 video 的 `playing`
   * 事件在**解码器还没解出任何一帧**时也会触发（MSE 里有数据就播），
   * 于是看门狗被撤掉、spinner 被清掉，而画面永远不出来 —— 这就是
   * 「转圈、不报错、不换线路」的源代码级成因。改动见 frameReport() 注释。
   */
  const succeed = () => {
    if (state.playToken !== token) return;
    clearTimeout(state.watchdog);
    state.watchdog = null;
    stopHealthCheck();
    stopDecodeWatchdog();
    setSpinner(false);
    hideError();
    renderLinePanel();
  };

  const onPlaying = () => {
    if (state.playToken !== token) return;
    const r = recordFrame();
    if (!pictureSeen(r)) {
      // 事件说「在播」，帧读数说「没出画」→ 不认这个成功，交给解码看门狗继续盯
      diagPush('decode', `playing 事件到了但还没出帧：${frameText(r)}`, 'warn');
      return;
    }
    succeed();
  };
  const onLoadedData = () => {
    if (state.playToken === token && pictureSeen()) setSpinner(false);
  };
  const onError = () => fail('媒体错误');
  video.addEventListener('playing', onPlaying, { once: true });
  video.addEventListener('loadeddata', onLoadedData, { once: true });
  video.addEventListener('error', onError, { once: true });
  // 登记本轮机子，换台时 destroyPlayer 会按引用移除，防止监听器泄漏
  state.attemptHandlers = [['playing', onPlaying], ['loadeddata', onLoadedData], ['error', onError]];

  // 地址猜不出协议的先探一下真实容器，再决定交给哪个引擎。
  // 关键：/api/sniff 是串行 await 的（8 秒 × 2 次），探测期间还没有任何播放器实例，
  // 谈不上「没有数据」。旧代码把 15 秒死线写在探测之前，等于让探测先吃掉起播预算——
  // 源里 59% 的频道主类型是 unknown（本机实测 5162 个频道里 3076 个），
  // 这些频道的每一条候选线路都被白白扣掉最多 16 秒。现在起播兜底挪到下面、
  // 真正把地址交给引擎之后再计时。
  if (line.kind === 'unknown') setSpinner(true, `正在探测 ${lineLabel(index + 1)} 的格式…`);
  const kind = await refineLineKind(line);
  if (state.playToken !== token) return;   // 探测期间用户已经换台了
  if (kind !== line.kind && kind !== 'unknown') {
    line.kind = kind;
    renderLinePanel();
    updateOsdLine(index);
  }

  /*
   * 量一下这条线路的直播窗口，用来决定「离直播边缘站多远、能缓多深」。
   *
   * 这一步是「很卡 / 基本看不了」的正面解法：这些源的窗口只有 15~25 秒，
   * 旧配置却让 hls.js 站在直播边缘后面 5~10 个分片（25~50 秒）、前向缓 60 秒，
   * 要的分片早就被上游删了。量一次窗口（几百字节，缓存 10 分钟）就能算出
   * 真正可用的参数，比任何「调大缓冲」都有效。
   */
  if (kind === 'hls') {
    setSpinner(true, `正在测量 ${lineLabel(index + 1)} 的直播窗口…`);
    await prepareLivePlan(line, token);
    if (state.playToken !== token) return;
  } else {
    state.livePlan = null;
    state.liveWindow = null;
  }

  /**
   * 起播兜底：按「有没有进展」判定，而不是固定 15 秒死线。
   *
   * 老写法是「15 秒到点还没 readyState>=2 就判死」。实测（tools/e2e/hlsprobe.js）
   * 这些源起播本来就慢：CCTV2 线路一 15 秒时仍然一个字节都没出画，而 hls.js
   * 自己要到 21 秒才判定 fragParsingError。固定死线比播放内核自己的判定还早，
   * 会把「慢但在稳定收数据」的线路先杀掉，白白多换一轮线路。
   * 现在改成：只要还在进展（readyState 提升或缓冲区变长）就续期，
   * 连续 STARTUP_STALL_MS 毫无进展才放弃，起播总预算 STARTUP_MAX_MS。
   */
  const STARTUP_STALL_MS = 15000;   // 连续多久零进展才判这条线路没戏
  const STARTUP_MAX_MS = 45000;     // 起播总预算（含多次续期）
  /*
   * ffmpeg 转码档要单独放宽：它是**本机现编** H.264，
   * 从起进程、拉流、编出第一个 2 秒分片、到 hls.js 拿到列表，几秒到十几秒都正常，
   * 老机器上更久。用直解的 15 秒标准卡它，会把正在正常工作的转码判死。
   */
  const ffmpegMode = state.wantFfmpeg || !!state.ffmpegFallback;
  const stallMs = ffmpegMode ? 40000 : STARTUP_STALL_MS;
  const maxMs = ffmpegMode ? 90000 : STARTUP_MAX_MS;
  const startupBegin = Date.now();
  let seenRs = video.readyState;
  let seenBufEnd = 0;
  const armStartupWatchdog = () => {
    state.watchdog = setTimeout(() => {
      if (state.playToken !== token) return;
      /*
       * 只有「真的出画」才把看门狗交出去。
       *
       * 老写法是 `if (video.readyState >= 2) return;` —— 于是出现这种情形：
       * 分片正常 append（readyState 到 2/3、缓冲还在涨），解码器却一帧不出
       * （H.264 硬解链路挂掉的典型表现）。看门狗以为成功了就撤了，
       * 卡顿看门狗又因为「时间轴没动过」不计停滞，**两个看门狗互相甩锅**，
       * 结果就是永远转圈、不报错。现在只要没出画就继续盯，并在超时后明确报「解码不出帧」。
       */
      const fr = recordFrame();
      if (pictureSeen(fr)) { state.watchdog = null; return; }   // 已出画，改由卡顿看门狗负责
      const b = video.buffered;
      const bufEnd = b.length ? b.end(b.length - 1) : 0;
      const progressed = video.readyState > seenRs || bufEnd > seenBufEnd + 0.05;
      if (video.readyState > seenRs) seenRs = video.readyState;
      if (bufEnd > seenBufEnd) seenBufEnd = bufEnd;
      if (progressed && Date.now() - startupBegin < maxMs) {
        armStartupWatchdog();   // 还在进展：续期，别把慢源当死链
        return;
      }
      if (fr.rs >= 2 || fr.buffered > 0.5) {
        // 数据一直都在，就是解不出画面 —— 换线路没意义，交给 ffmpeg / 软解
        fail(`数据已就位（缓冲 ${fr.buffered.toFixed(1)} 秒）但解码器不出帧`);
      } else {
        fail(progressed
          ? `起播超时（${Math.round(maxMs / 1000)} 秒仍未出画）`
          : `${Math.round(stallMs / 1000)} 秒内没有数据`);
      }
    }, stallMs);
  };
  armStartupWatchdog();

  // 一条线路可以换引擎重试（同一容器喂错引擎必然失败，但先失败再换比不试强）
  const engines = (engineQueue && engineQueue.length) ? engineQueue : enginesFor(kind);
  const engine = engines[0];
  const url = proxyUrl(line);

  if (engine === 'flv' && window.flvjs && window.flvjs.isSupported()) {
    const player = window.flvjs.createPlayer(
      { type: 'flv', url, isLive: true, hasAudio: true, hasVideo: true },
      // stashInitialSize 单位是**字节**：flv.js 默认 393216（384KB），内部上限 3MB。
      // 原来写 4096 只有 4KB，13Mbps 下连 0.01 秒都装不下，等于没缓冲。
      { enableWorker: false, stashInitialSize: bufferPreset().stash, lazyLoad: false }
    );
    player.attachMediaElement(video);
    player.on(window.flvjs.Events.ERROR, () => failNextEngine('FLV 解码失败'));
    player.load();
    player.play().catch(() => {});
    state.flv = player;
    return;
  }

  if (engine === 'native') {
    video.src = url;
    video.play().catch(() => fail('播放被拒绝'));
    return;
  }

  /**
   * 裸 MPEG-TS（UDPXY 的 /rtp/）：mpegts.js 解复用 TS 后重封装成 fMP4 喂给 MSE。
   * 实测 h264+aac / h264+mp2 / h264+ac3 都能出画；hevc（多为 4K）会在
   * addSourceBuffer 阶段报 hvc1 unsupported，这里单独给出可读的提示。
   */
  if (engine === 'mpegts' && window.mpegts && window.mpegts.isSupported()) {
    // 裸 TS 走的是 UDPXY 中继，画质完全取决于那条线路的丢包情况。
    // 实测同一台服务器上有的线路 0% 损坏、有的 64% 坏块，
    // 不提示的话用户会以为播放器坏了。
    if (!state.rawtsHintShown) {
      state.rawtsHintShown = true;
      toast('这是裸 TS 线路：若出现绿块/花屏，说明该线路丢包，点「线路」换一条即可');
    }
    const player = window.mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url },
      {
        enableWorker: true,
        // 打开 stash 缓冲以吸收网络抖动；关掉 latencyChasing——
        // 实测它在个别流上会把播放器弄成 paused 且不再恢复，稳定性优先于那 1 秒延迟。
        // 注意：stashInitialSize 的**单位是字节**，名字里的 KB 是误导。
        // mpegts.js 默认 65536（64KB），内部上限 3MB。之前写 384 / 8192
        // 相当于 384 字节 / 8KB，13Mbps 下连 0.01 秒都装不下，等于没缓冲。
        enableStashBuffer: true,
        stashInitialSize: bufferPreset().stash,
        liveBufferLatencyChasing: false,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
      }
    );
    const isHevc = (s) => /hvc1|hev1|hevc|h\.265/i.test(String(s || ''));
    player.on(window.mpegts.Events.MEDIA_INFO, (mi) => {
      if (state.playToken !== token) return;
      if (isHevc(mi.videoCodec)) fail('HEVC/H.265（多为 4K），Chromium 解不了');
    });
    player.on(window.mpegts.Events.ERROR, (type, detail, info) => {
      if (state.playToken !== token) return;
      const msg = String((info && info.msg) || '');
      if (isHevc(msg) || isHevc(detail)) {
        fail('HEVC/H.265（多为 4K），Chromium 解不了');
        return;
      }
      failNextEngine(`${type}/${detail}`);
    });
    player.attachMediaElement(video);
    player.load();
    player.play().catch(() => {});
    state.mpegts = player;
    return;
  }

  if (engine === 'mpegts') {
    failNextEngine('裸 TS 解码库未就绪');
    return;
  }

  // HLS / 未知格式交给 hls.js
  if (window.Hls && window.Hls.isSupported()) {
    // 处于「猜」的状态（后面还有别的引擎要试）时把超时压短，
    // 否则要白等 20 秒才回退到 mpegts/flv
    const guessing = engines.length > 1;
    const mySeq = ++state.hlsSeq;   // 这个实例的序号：被换掉之后，它的事件一律作废
    const hls = new window.Hls(makeHlsConfig({
      // 处于「猜」的状态（后面还有别的引擎要试）时把超时压短，
      // 否则要白等 20 秒才回退到 mpegts/flv
      manifestLoadingTimeOut: guessing ? 7000 : 20000,
      manifestLoadingMaxRetry: guessing ? 0 : 3,
      levelLoadingTimeOut: guessing ? 8000 : 20000,
      levelLoadingMaxRetry: guessing ? 1 : 4,
      fragLoadingTimeOut: 30000,
    }, state.livePlan));
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (state.hlsSeq !== mySeq) return;   // 旧实例的迟到事件：忽略
      if (state.playToken !== token) return;
      if (!data.fatal) return;
      const detail = String(data.details || data.type || '未知错误');

      /*
       * 缓冲类错误**不是「线路坏了」**，不能判死刑。
       *
       * bufferStalledError 的含义是「缓冲里没数据了」，hls.js 自己会 nudge 重试；
       * 只有持续 nudge 不动（上面把 nudgeMaxRetry 提到了 12）它才升级成 fatal。
       * 之前这里一 fatal 就 failNextEngine → 把这条线路永久拉黑，
       * 结果慢源播一会儿就把 9 条线路全标成「已失败」，最后什么都播不了。
       * 而 PotPlayer / ok影视 之所以正常，正是因为它们不会因为一次缓冲见底就放弃源。
       *
       * 所以：缓冲类错误交给 hls.js 自愈；真的长时间不动，由卡顿看门狗
       * （连续 12 秒时间轴不推进）去换线路 —— 那条路径有完整的状态提示。
       */
      if (/buffer(Stalled|SeekOverHole|AppendError|Appending|Full)/i.test(detail)) {
        toastThrottled(`缓冲跟不上（${detail}），正在自动恢复…`);
        /*
         * 光提示不做事是不够的：fatal 的 bufferStalledError 意味着 hls.js 已经
         * 停下加载了。这些源的分片窗口只有 15~25 秒，缓冲见底 / 出现空洞是常态，
         * 必须真的动手 —— 先跳空洞，再跳回直播边缘，都不行就让它从直播边缘重新加载。
         */
        /*
         * 注意这里**不再** seekToLiveEdge('缓冲见底')：跳回直播边缘会把辛苦攒下的
         * 前向缓冲一次丢掉（播放头落到最新数据处，缓冲立刻只剩几秒），
         * 下一次抖动必然又见底 —— 现场日志里那个「重建 → 缓冲归零 → 再重建」
         * 的死循环就是这么来的。只有缓冲里真有空洞时才跳（recoverFromBufferHole），
         * 其余情况交给 hls.js 自己重挂加载 + 上面的看门狗。
         */
        if (!recoverFromBufferHole()) {
          try { hls.startLoad(); } catch (err) { /* ignore */ }
        }
        return;
      }

      /*
       * bufferAddCodecError：hls.js 连 SourceBuffer 都建不起来。
       *
       * 这不是「线路坏了」，而是**这条流的编码 Chromium 不认** —— 实测就是
       * MP2 / AC-3 音频、HEVC 视频这类；编码探测没覆盖到的时候就会走到这里。
       * 以前它掉进下面的 failNextEngine → 这条线路被永久标成
       * 「已失败: bufferAddCodecError」，然后去试下一条 —— 而下一条常常是
       * 同一个源，一样建不起 SourceBuffer，于是整屏线路一条条变红。
       *
       * 正确的出路是交给内置 ffmpeg 换壳/转码（这正是这个应用存在的意义）：
       * 拿**当前这条**线路去接管，而不是换线。
       */
      if (/bufferAddCodecError|manifestIncompatibleCodecsError/i.test(detail)) {
        /*
         * ⚠️ 这个错误可能来自**已经被销毁的旧 hls.js 实例**（迟到事件）。
         *
         * 实测（2026-10-10 22:16:26~28，线路一）：第一次 `bufferAddCodecError` 触发接管、
         * 会话 2c57d7… 建好、正在「起播等待」；2 秒后同一批迟到事件又来一次，
         * 于是刚建好的会话被拆掉、又建一个（1e47ca5b…），再等一次 20 秒 ——
         * 连着拆了两次，画面一次都没起来。用户看到的就是「线路一又不行了」。
         *
         * 所以：只要**已经在 ffmpeg 路径上**（有会话 / 已标记兜底），这类报错一律忽略；
         * 而且无论走不走接管，都绝不让它落到下面的 failNextEngine（那会把线路拉黑）。
         */
        /*
         * 防抖但**不能锁死**（2026-10-10 22:19 的教训）：接管后 15 秒内的重复报错忽略
         * （那是被销毁的旧实例排队里的重复事件），过期之后必须允许再试 ——
         * 一刀切的永久忽略会让「一次没成的接管」变成永远转圈。
         */
        const sinceHandoff = Date.now() - (state.ffmpegHandoffAt || 0);
        if (state.remuxSid && sinceHandoff < 15000) {
          diagPush('play', `忽略接管的重复报错 ${detail}（接管后 ${(sinceHandoff / 1000).toFixed(1)}s）`, 'warn');
          return;
        }
        if (!state.wantFfmpeg) {
          state.wantFfmpeg = true;
          state.ffmpegHandoffAt = Date.now();
          state.ffmpegTried = true;
          diagPush('play', `编码不支持（${detail}）：改走 ffmpeg 接管，线路${index + 1}`, 'warn');
          toastThrottled('这条流的编码 Chromium 解不了，正在交给内置 ffmpeg…');
          destroyPlayer();
          tryFfmpegFallback('Chromium 没有这条流的解码器', index).then((ok) => {
            if (state.playToken !== token) return;
            if (!ok) {
              // ffmpeg 也没起来：退回原来的「换下一条线路」逻辑
              state.wantFfmpeg = false;
              state.ffmpegTried = false;
              failNextEngine(detail);
              return;
            }
            /*
             * 这条 return 绕过了 startAttempt 下面那整套保护，必须自己挂上：
             * activeAttempt 缺了的话，卡顿看门狗从第一秒起就是空转的。
             */
            state.currentLine = index;
            state.activeAttempt = { candidates, index, token };
            startStallWatchdog();
            armFallbackWatchdog(token);
            armDecodeWatchdog(token, { ffmpegMode: true });
            diagPush('play', `转码档保护已挂上：activeAttempt=线路${index + 1}`, 'ok');
          }).catch(() => {
            if (state.playToken !== token) return;
            state.wantFfmpeg = false;
            state.ffmpegTried = false;
            state.ffmpegHandoffAt = 0;
            failNextEngine(detail);
          });
          return;
        }
        // 已经在兜底流程里（wantFfmpeg=true）：既不重复接管，也不拉黑线路
        return;
      }

      /*
       * 分片取不到：最常见的具体原因是 404 —— 这个分片已经滑出上游窗口被删了
       * （实测 5 分片窗口里第 3 旧的 10 秒内就没）。此时原地重试毫无意义，
       * 而且重试期间播放点还在继续落后，所以直接跳到直播边缘去要新的分片。
       */
      const status = data.response && data.response.code;
      /*
       * 分片取不到：404/410 是「这个分片已经被上游删了」；403 常见于中转源对
       * 某个具体分片临时拒绝 —— 实测 192.168.1.10:19105 那条 relay：清单正常、
       * 一部分分片 403；本机用同一条 ffmpeg 命令单独跑，它报
       * 「failed too many times, skipping」跳过去继续出片（照样有画面）。
       *
       * 所以这类**不是「线路坏了」**：原地重试没意义（分片已经不在窗口里），
       * 跳到直播边缘要新的分片才对；跳的次数由 seekToLiveEdge 自己封顶。
       * 以前只有 404/410 走这条路，403 直接掉进「拉黑换线」，
       * 面板上就留下一条「已失败: fragLoadError」——而那条线其实还能看。
       */
      if (/fragLoadError/i.test(detail) && status >= 400 && status < 500) {
        if (seekToLiveEdge(`分片被上游拒绝（HTTP ${status}）`)) {
          toastThrottled(`分片被上游拒绝（HTTP ${status}），已跳到直播边缘重试`);
        } else {
          /*
           * 跳不动了（state.edgeSeeks 用尽）→ 这条线路确实不能用。
           * 这里必须交给换线逻辑：只 toast 不换线的话，遇到一条永远 403 的线
           * 就会原地打转，看起来就是「什么都不播」。
           */
          failNextEngine(`分片持续被拒（HTTP ${status}）`);
        }
        return;
      }

      // 解析类错误：如果还在「猜引擎」阶段，说明猜错了引擎，换下一个；
      // 已经确定引擎的情况下多半是单个分片坏了，hls.js 会跳过，不必拉黑整条线路
      if (/ParsingError/i.test(detail)) {
        state.parseFails += 1;
        if (engines.length > 1) {
          failNextEngine(detail);
        } else if (state.parseFails >= 3) {
          /*
           * 同一条线路连续解析失败 3 次 —— 这基本不是「某个分片坏了」，
           * 而是**整条线路的编码 Chromium 根本不认识**（实测 MPEG-2 就是这个表现：
           * 一个分片都解不出来，hls.js 反复报 fragParsingError）。
           * 一直在这儿重试就是无限转圈，换线路 + 兜底才是出路。
           */
          fail(`连续 ${state.parseFails} 次分片解析失败（疑似编码不支持）`);
        } else {
          toastThrottled(`分片解析失败（${detail}），正在重试…`);
        }
        return;
      }

      failNextEngine(detail);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    state.hls = hls;
    return;
  }

  video.src = url;
  video.play().catch(() => fail('播放被拒绝'));
}

function stepChannel(delta) {
  const items = visibleChannels();
  if (!items.length) return;
  let pos = items.findIndex((c) => String(c.id) === String(state.currentId));
  if (pos < 0) pos = 0;
  else pos = (pos + delta + items.length) % items.length;
  playChannel(items[pos].id);
}

/* ---------------------------------------------------------------- 收藏 */

async function toggleFavorite(id) {
  const key = String(id);
  const channel = allChannels().find((c) => String(c.id) === key && !c.local);
  if (!channel) return;
  const want = !channel.favorite;
  channel.favorite = want;
  if (want) state.favorites.add(channel.favKey);
  else state.favorites.delete(channel.favKey);
  renderGroups();
  invalidateList(false);
  try {
    const r = await fetch('/api/favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favKey: channel.favKey, favorite: want, key: channel.key || '' }),
    });
    const data = await r.json();
    if (data.ok && data.hubSynced) toast(want ? '已收藏（已同步到 iptv-hub）' : '已取消收藏（已同步到 iptv-hub）');
  } catch (err) {
    toast('收藏保存失败', true);
  }
}

/* ---------------------------------------------------------------- 转义 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

/* ---------------------------------------------------------------- 事件 */

function bindEvents() {
  $('btnImport').addEventListener('click', () => doImport(false));
  $('btnPlay').addEventListener('click', () => doImport(true));
  $('srcInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doImport(true);
  });

  $('btnClear').addEventListener('click', () => {
    destroyPlayer();
    state.channels = [];
    state.groups = [];
    state.locals = [];
    state.mode = 'stream';
    state.currentId = -1;
    state.lines = [];
    state.hub = null;
    state.enriched = false;
    renderGroups();
    renderChannels();
    $('controls').classList.add('hidden');
    $('linePanel').classList.add('hidden');
    $('osd').classList.add('hidden');
    $('placeholder').classList.remove('hidden');
    $('hubLabel').textContent = '';
    $('seek').disabled = true;
    $('seek').value = '0';
    $('timeLabel').textContent = '直播';
    $('liveTag').classList.remove('hidden');
    setBadge('未加载', 'idle');
    setStatus('未连接', '');
    hideError();
    applySidebar();
  });

  $('btnFavOnly').addEventListener('click', () => {
    state.favOnly = !state.favOnly;
    state.group = state.favOnly ? '__fav__' : '全部';
    $('btnFavOnly').classList.toggle('on', state.favOnly);
    renderGroups();
    invalidateList();
  });

  $('btnSidebar').addEventListener('click', toggleSidebar);

  // 缓冲档位：hls.js 的缓冲参数只在创建时读取，所以要重开当前播放才生效
  $('bufferSel').addEventListener('change', async (e) => {
    const val = e.target.value;
    if (!BUFFER_PRESETS[val]) return;
    state.bufferPreset = val;
    await saveConfig({ bufferPreset: val });
    const b = bufferPreset();
    const plan = state.liveWindow ? LiveWin.planFromWindow(state.liveWindow, b) : null;
    toast(`缓冲改为「${b.label}」：` +
          (plan
            ? `前向 ${plan.maxBufferLength.toFixed(0)} 秒、离直播边缘 ${plan.targetLatency.toFixed(0)} 秒` +
              `（源窗口 ${plan.windowSeconds.toFixed(0)} 秒）`
            : `前向 ${b.seconds} 秒（未量到源窗口，按点播处理）`) +
          (state.currentId !== -1 ? '，正在重开当前播放' : ''));
    if (state.currentId !== -1) {
      if (String(state.currentId).startsWith('local:')) {
        const entry = state.locals.find((x) => String(x.id) === String(state.currentId));
        if (entry) playLocalEntry(entry);
      } else {
        playChannel(state.currentId);
      }
    }
  });

  /*
   * 解码方式切换。
   *
   * 命令行开关（--force_high_performance_gpu / --disable-accelerated-video-decode …）
   * 只能在进程启动时生效，所以这里必须「存配置 → 重启应用」。
   * 非桌面版（浏览器里调试）没有这个能力，只落盘不重启。
   */
  $('decodeSel').addEventListener('change', async (e) => {
    const val = e.target.value;
    if (!DECODE_MODES.some((m) => m.value === val)) return;
    state.decodeMode = val;
    await saveConfig({ decodeMode: val });
    if (window.hubplay && window.hubplay.setDecodeMode) {
      toast(`解码改为「${decodeModeLabel(val)}」，正在重启应用…`);
      await window.hubplay.setDecodeMode(val);
    } else {
      toast(`解码改为「${decodeModeLabel(val)}」（桌面版重启后生效）`);
    }
  });

  // 打开本地视频文件
  $('btnOpenFile').addEventListener('click', async () => {
    if (window.hubplay && window.hubplay.openFiles) {
      const paths = await window.hubplay.openFiles();
      if (paths && paths.length) await openLocalPaths(paths);
    } else {
      toast('文件对话框只在桌面版可用；这里可以直接把视频文件拖进窗口', true);
    }
  });

  // 进度条
  video.addEventListener('timeupdate', updateSeekBar);
  video.addEventListener('durationchange', updateSeekBar);
  video.addEventListener('progress', updateSeekBar);
  $('seek').addEventListener('input', () => { state.seeking = true; });
  $('seek').addEventListener('change', () => {
    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 0) {
      video.currentTime = (Number($('seek').value) / 1000) * dur;
    }
    state.seeking = false;
    updateSeekBar();
  });

  $('groupChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.group = chip.dataset.group;
    state.favOnly = state.group === '__fav__';
    $('btnFavOnly').classList.toggle('on', state.favOnly);
    renderGroups();
    invalidateList();
  });

  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      state.query = value;
      invalidateList();
    }, 120);
  });

  // 虚拟滚动：滚动时按 rAF 重算可视窗口，避免每个 scroll 事件都重排
  let scrollRaf = 0;
  $('channelList').addEventListener(
    'scroll',
    () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        renderChannels();
      });
    },
    { passive: true }
  );

  // 窗口尺寸变了，可视行数也跟着变
  window.addEventListener('resize', () => {
    state.renderedRange = null;
    renderChannels();
  });

  $('channelList').addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();
      toggleFavorite(fav.dataset.fav);
      return;
    }
    const row = e.target.closest('.ch');
    if (row) {
      // 注意不能 Number()：本地视频条目的 id 是 "local:xxxx" 这种字符串，
      // 转了会变 NaN，find 永远匹配不到，表现就是「点了没反应」
      playChannel(row.dataset.id);
      collapseSidebarForPlayback();
    }
  });

  // 台标加载失败时换成占位块（error 事件不冒泡，必须用捕获）
  $('channelList').addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img && img.tagName === 'IMG' && img.classList.contains('ch-logo')) {
        const div = document.createElement('div');
        div.className = 'ch-logo-fallback';
        div.textContent = 'TV';
        img.replaceWith(div);
      }
    },
    true
  );

  $('linePanel').addEventListener('click', (e) => {
    const item = e.target.closest('.line-item');
    if (!item || item.classList.contains('dead')) return;
    const index = Number(item.dataset.line);
    const channel = state.channels.find((c) => c.id === state.currentId);
    if (!channel) return;
    // 手动指定线路：先清掉它的失败标记，然后从它开始往后顺延
    state.failures.delete(index);
    // 用户明确点了某条线路，就把「已判定走 ffmpeg」的结论清掉，重新按这条线路判
    state.wantFfmpeg = false;
    state.ffmpegTried = false;
    state.ffmpegFallback = false;
    const ordered = [index, ...state.candidates.filter((i) => i !== index)];
    state.candidates = ordered;
    state.currentLine = index;
    renderLinePanel();
    startAttempt(ordered);
  });

  $('btnLines').addEventListener('click', () => {
    $('linePanel').classList.toggle('hidden');
  });

  $('btnToggle').addEventListener('click', () => {
    if (video.paused) {
      state.userPaused = false;
      video.play().catch(() => {});
    } else {
      state.userPaused = true;
      video.pause();
    }
  });
  video.addEventListener('play', () => { $('btnToggle').textContent = '⏸'; });
  video.addEventListener('pause', () => { $('btnToggle').textContent = '▶'; });

  $('btnPrev').addEventListener('click', () => stepChannel(-1));
  $('btnNext').addEventListener('click', () => stepChannel(1));

  $('volume').addEventListener('input', (e) => {
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
    updateMuteIcon();
    saveConfig({ volume: video.volume, mute: video.muted });
  });

  $('btnMute').addEventListener('click', () => {
    video.muted = !video.muted;
    updateMuteIcon();
    saveConfig({ mute: video.muted });
  });

  $('btnFull').addEventListener('click', toggleFullscreen);
  $('btnStats').addEventListener('click', () => toggleStats());

  document.addEventListener('fullscreenchange', syncFullscreenUI);

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      // 全屏时把 Esc 让给浏览器原生退出逻辑，别被下面的面板关闭吃掉
      if (document.fullscreenElement) return;
      if (!$('linePanel').classList.contains('hidden')) {
        $('linePanel').classList.add('hidden');
        e.preventDefault();
        return;
      }
    }
    if (typing && e.key !== 'Escape') {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        $('search').focus();
      }
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (video.paused) {
        state.userPaused = false;
        video.play().catch(() => {});
      } else {
        state.userPaused = true;
        video.pause();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepChannel(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepChannel(1);
    } else if (e.key.toLowerCase() === 'f') {
      $('btnFull').click();
    } else if (e.key.toLowerCase() === 'm') {
      $('btnMute').click();
    } else if (e.key.toLowerCase() === 'i') {
      toggleStats();
    } else if (e.key.toLowerCase() === 'l') {
      toggleDiag();
    } else if (e.key.toLowerCase() === 'b') {
      toggleSidebar();
    } else if (e.key === '/') {
      e.preventDefault();
      $('search').focus();
    }
  });

  /* ------------------------------------------------ 诊断面板与视频事件挂钩 */

  $('btnDiagCopy').addEventListener('click', async () => {
    const text = diagText();
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${diagLog.length} 条日志，直接粘贴发回即可`);
    } catch (err) {
      // 剪贴板 API 被拒时退回到「全选」，让用户手动 Ctrl+C
      const el = $('diagLog');
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('已全选日志，按 Ctrl+C 复制', true);
    }
  });
  $('btnDiagClear').addEventListener('click', () => {
    diagLog.length = 0;
    renderDiag();
    toast('诊断日志已清空');
  });

  /*
   * video 元素自己的事件也全记下来。
   * hls.js 说「我 append 成功了」不等于画面出来了 —— 解码器会不会报错、
   * autoplay 有没有被拒、是不是卡在 waiting，只有 video 元素知道。
   */
  for (const ev of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'waiting',
    'stalled', 'suspend', 'emptied', 'ended', 'abort', 'error']) {
    video.addEventListener(ev, () => {
      const b = video.buffered;
      const buf = b.length ? `${b.start(0).toFixed(1)}~${b.end(b.length - 1).toFixed(1)}` : '-';
      diagPush('video', `${ev} rs=${video.readyState} t=${video.currentTime.toFixed(2)} ` +
        `${video.videoWidth}x${video.videoHeight} paused=${video.paused} buffered=${buf}`,
      ev === 'error' ? 'err' : ev === 'stalled' || ev === 'waiting' ? 'warn' : '');
    });
  }
  // 播放失败时把 video.error 的具体代码也记下来（MEDIA_ERR_* 有明确含义）
  video.addEventListener('error', () => {
    const e = video.error;
    diagPush('video', `video.error code=${e ? e.code : '?'} message=${e ? e.message : '?'}`, 'err');
  });

  /*
   * 每秒采一次样。事件流水看不出「一直在转但时间轴不动」这种情况，
   * 持续采样能看出来 —— 而它恰好是最常见的故障形态。
   */
  setInterval(() => {
    // 起播阶段全量采样（这是定位「不出画」的关键证据），出画后停掉免得刷屏
    if (state.mode !== 'stream') return;
    if (state.pictureAt && Date.now() - state.pictureAt > 3000) return;
    if (!state.lastFrame && state.currentLine < 0) return;
    const r = frameReport();
    state.lastFrame = r;
    samplePush(`rs=${r.rs} t=${r.t.toFixed(2)} paused=${r.paused} ` +
      `buf=${r.buffered.toFixed(1)}s ${r.w}x${r.h}` +
      `${r.frames == null ? '' : ` frames=${r.frames} dropped=${r.dropped}`}` +
      `${pictureSeen(r) ? ' [出画]' : (r.rs >= 2 ? ' [有数据/无帧]' : ' [无数据]')}` +
      `${state.ffmpegFallback ? ' [ffmpeg]' : ''}`);
  }, 1000);

  diagPush('env', `启动完成：${navigator.platform} hls.js=${window.Hls ? window.Hls.version : '无'} ` +
    `MSE=${window.MediaSource ? '有' : '无'}`, 'ok');
}

/** 诊断面板开关。 */
function toggleDiag() {
  const p = $('diagPanel');
  const show = p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  if (show) {
    renderDiag();
    toast(`诊断日志 ${diagLog.length} 条（按 L 关闭，点「复制」发回）`);
  }
}

function updateMuteIcon() {
  $('btnMute').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
}

/**
 * 全屏。
 *
 * 让 .stage（播放区）走 DOM Fullscreen API，而不是去 IPC 调 setFullScreen：
 *  1. Electron 里元素全屏会自动把 BrowserWindow 也切成全屏，两者兼得；
 *  2. 侧边栏会被真正隐藏、视频铺满整屏，这才是点播放器全屏键的预期；
 *  3. 失败时能拿到真实异常，而不是按钮点了没反应。
 */
async function toggleFullscreen() {
  const stage = document.querySelector('.stage');
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (stage && stage.requestFullscreen) {
      await stage.requestFullscreen({ navigationUI: 'hide' });
      return;
    }
    if (window.hubplay && window.hubplay.toggleFullscreen) {
      await window.hubplay.toggleFullscreen();
      return;
    }
    toast('当前环境不支持全屏', true);
  } catch (err) {
    toast(`全屏切换失败：${(err && err.message) || err}`, true);
  }
}

function syncFullscreenUI() {
  const on = !!document.fullscreenElement;
  $('btnFull').textContent = on ? '⛗' : '⛶';
  $('btnFull').title = on ? '退出全屏 (F / Esc)' : '全屏 (F)';
  document.body.classList.toggle('is-fullscreen', on);
}

/* ---------------------------------------------------------------- 启动 */

(async function main() {
  bindEvents();
  bindSidebarHover();
  bindDragDrop();
  $('seek').disabled = true;
  $('timeLabel').textContent = '直播';
  syncTopbarHeight();
  state.loading = true;   // 先按「正在加载」渲染，别闪一下「没有匹配的频道」
  renderGroups();
  renderChannels();
  await loadConfig();

  if (window.hubplay && window.hubplay.info) {
    try {
      const info = await window.hubplay.info();
      document.title = `HubPlay ${info.version}`;
    } catch (err) { /* ignore */ }
  }

  // 显卡 / 硬解能力：这两件事决定「1080p 是 GPU 在解还是 CPU 在解」，
  // 是丢帧问题唯一能查清方向的依据。都不阻塞播放，失败了也只是面板少两行。
  await loadGpuInfo();
  probeDecodeCaps().then(() => updateStats());

  /*
   * 启动自检：ffmpeg / ffprobe 到底在不在。
   *
   * 这不是可有可无的一步 —— MPEG-2 这类线路**全靠内置 ffmpeg 转码**才能播。
   * 而随包的 ffmpeg 是共享库版本（一堆 dll），在个别机器上会被杀软/组策略拦掉，
   * 表现就是「点什么都播不了，界面还什么都不说」。所以启动就把结论摆出来。
   */
  checkFfmpegTools();

  // 暴露一份给自动化测试和高级用户用（拖拽在无头环境里没法真模拟）。
  // BUFFER_PRESETS 一起挂出来：诊断脚本要用**和播放器完全同一份**档位定义去跑
  // 对照实验，否则测试里写死的参数会悄悄和真实行为脱节（已经踩过一次）。
  Object.assign(DIAG_DEBUG, { frameReport, pictureSeen, recordFrame, frameText, armDecodeWatchdog, stopDecodeWatchdog });

  window.hubplayApp = {
    openLocalPaths, playChannel, state, allChannels, visibleChannels,
    probeLineSpeeds, tryFfmpegFallback, measureLiveWindow, livePlanFor,
    BUFFER_PRESETS, bufferPreset,
    loadGpuInfo, probeDecodeCaps, hardwareDecodeState, decodeModeLabel, DECODE_MODES,
    // 编码判定相关：tools/codec_ui_check.js 靠它验证「Chromium 解不了的走 ffmpeg」
    probeLineCodec, codecVerdict, chromiumCanDecode, describeCodec, codecCache, probeLineCodecs,
    checkFfmpegTools,
    // 诊断面板：tools/ffmpeg_play_check.js 与用户排查都靠它
    diagText, toggleDiag, diagLog, diagSamples,
    // 「到底出没出画」的判据：工具脚本用它复现 MSE「有数据但解不出帧」的死局
    frameReport, pictureSeen, frameText, DIAG_DEBUG,
  };

  // 自动恢复上次导入的频道列表，省得每次开软件都要再点一次「导入」
  const saved = $('srcInput').value.trim();
  if (saved) {
    state.pendingRestoreKey = state.lastChannelFavKey || '';
    doImport(false, { silent: true });
  } else {
    state.loading = false;
    renderChannels();
    setStatus('未连接', '');
    setBadge('待导入', 'idle');
  }
})();
