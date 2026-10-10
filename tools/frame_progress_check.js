'use strict';
(async () => {
const path = require('path');
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('✅ ' + label + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('❌ ' + label + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------- DOM 桩 */
function makeClassList(el) {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
  };
}
function makeEl(id) {
  const e = {
    id, textContent: '', innerHTML: '', value: '', title: '', disabled: false,
    scrollTop: 0, scrollHeight: 0, checked: false, dataset: {},
    offsetHeight: 48, offsetWidth: 1380, clientHeight: 800, clientWidth: 1380,
    style: { setProperty() {}, removeProperty() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {},
    querySelector() { return makeEl('q'); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
  e.classList = makeClassList(e);
  return e;
}
const els = new Map();
const videoStub = {
  readyState: 0, currentTime: 0, videoWidth: 0, videoHeight: 0, paused: true,
  buffered: { length: 0, start: () => 0, end: () => 0 },
  duration: NaN, volume: 1, muted: false, error: null,
  addEventListener() {}, removeEventListener() {},
  play() { return Promise.resolve(); }, pause() {}, load() {},
  getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }),
};
const documentStub = {
  getElementById(id) { if (id === 'video') return videoStub; if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  createElement: (t) => makeEl(t),
  createRange: () => ({ selectNodeContents() {} }),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => makeEl('sel'), querySelectorAll: () => [],
  body: makeEl('body'), documentElement: makeEl('html'),
};
els.set('video', videoStub);

const sandbox = {
  console,
  document: documentStub,
  navigator: { platform: 'test', clipboard: { writeText: async () => {} }, mediaCapabilities: null },
  location: { href: 'http://127.0.0.1:17899/' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  Headers: class {}, URLSearchParams, AbortController,
  MediaSource: { isTypeSupported: () => true },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(() => fn(0), 16), cancelAnimationFrame() {},
  performance: { now: () => Date.now() },
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// 渲染进程会往 window/document 上挂事件，补全这些浏览器 API
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
sandbox.innerWidth = 1380;
sandbox.innerHeight = 880;
sandbox.devicePixelRatio = 1;
sandbox.hubplay = undefined;

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'renderer/app.js' });
  ok(true, 'renderer/app.js 能在 DOM 桩里加载（无 ReferenceError / 语法错）');
} catch (err) {
  ok(false, 'renderer/app.js 加载失败', err.message);
  console.log(String(err.stack || '').split('\n').slice(0, 6).join('\n'));
}

// 启动是异步的（main() 里 await loadConfig / loadGpuInfo），轮询等它把接口挂出来
let app = sandbox.window.hubplayApp;
for (let i = 0; i < 60 && !app; i++) { await sleep(50); app = sandbox.window.hubplayApp; }
app = app || {};
const dbg = app.DIAG_DEBUG;
ok(!!dbg && typeof dbg.pictureSeen === 'function', 'DIAG_DEBUG 已暴露 pictureSeen / armDecodeWatchdog');

function setVideo(o) {
  videoStub.readyState = o.rs;
  videoStub.currentTime = o.t;
  videoStub.videoWidth = o.w;
  videoStub.videoHeight = o.h;
  videoStub.paused = !!o.paused;
  videoStub.buffered = o.buf
    ? { length: 1, start: () => 0, end: () => o.buf }
    : { length: 0, start: () => 0, end: () => 0 };
}

/* --------------------------------------------- 一、出画判据 */
if (dbg) {
  setVideo({ rs: 3, t: 0, w: 0, h: 0, buf: 8 });
  eq(dbg.pictureSeen(dbg.frameReport()), false,
    'readyState=3 + 缓冲 8 秒，但 currentTime=0 / 分辨率 0×0 → 判「没出画」（老代码会判成已出画）');
  setVideo({ rs: 2, t: 0.4, w: 1920, h: 1080, buf: 6 });
  eq(dbg.pictureSeen(dbg.frameReport()), true, '时间轴推进 + 有分辨率 → 判「已出画」');
  setVideo({ rs: 1, t: 0, w: 0, h: 0, buf: 0 });
  eq(dbg.pictureSeen(dbg.frameReport()), false, '还没数据 → 判「没出画」');
  setVideo({ rs: 4, t: 0.9, w: 0, h: 0, buf: 12 });
  eq(dbg.pictureSeen(dbg.frameReport()), false, '只有音频在走、没有视频尺寸 → 仍算没出画');
}

/* --------------------------------------------- 二、解码看门狗 */
if (dbg && typeof dbg.armDecodeWatchdog === 'function') {
  const errBox = documentStub.getElementById('errorBox');
  setVideo({ rs: 3, t: 0, w: 0, h: 0, buf: 9 });
  app.state.playToken = 7;
  app.state.mode = 'stream';
  app.state.userPaused = false;
  app.state.decodeMode = 'auto';
  errBox.classList.add('hidden');
  dbg.armDecodeWatchdog(7, { ffmpegMode: false });
  await sleep(17000);          // 直解档 15 秒判死
  ok(!errBox.classList.contains('hidden'), '「有数据但不出帧」约 15 秒后弹出明确错误（不再永远转圈）');
  const log = app.diagLog || [];
  const decodeRows = log.filter((r) => r.tag === 'decode');
  ok(decodeRows.some((r) => /数据已入缓冲但解码器还没出帧/.test(r.msg)), '日志留下第一次「有数据但没出帧」采样');
  ok(decodeRows.some((r) => /判定：解码器不出帧/.test(r.msg)), '日志留下最终判定', decodeRows[decodeRows.length - 1] && decodeRows[decodeRows.length - 1].msg);
  dbg.stopDecodeWatchdog();

  const errBox2 = documentStub.getElementById('errorBox');
  errBox2.classList.add('hidden');
  setVideo({ rs: 3, t: 1.6, w: 1280, h: 720, buf: 7 });
  app.state.playToken = 8;
  dbg.armDecodeWatchdog(8, { ffmpegMode: false });
  await sleep(3000);
  ok(errBox2.classList.contains('hidden'), '真的出画时看门狗自行退出，不误报');
  dbg.stopDecodeWatchdog();
}

/* --------------------------------------------- 三、诊断文本 */
if (typeof app.diagText === 'function') {
  setVideo({ rs: 3, t: 0, w: 0, h: 0, buf: 8 });
  if (dbg) dbg.recordFrame();      // 让 state.lastFrame 跟上（pictureSeen 用它）
  const txt = app.diagText();
  ok(/帧进度/.test(txt) && /出画判定/.test(txt), 'diagText 带「帧进度 + 出画判定」两行');
  ok(/解码器没出帧/.test(txt), 'diagText 明确指出「readyState≥2 但解码器没出帧」');
  ok(/线路失败一览/.test(txt), 'diagText 带「线路失败一览」（环形缓冲挤掉后仍看得到谁被判死）');
}

console.log('\n通过 ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
})();
