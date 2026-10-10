'use strict';

/*
 * 回归检查：转码档的播放列表读流会不会在客户端已经断开之后还挂着不关。
 *
 * 背景（2026-10-10 实测，HubPlay 1.6.6 → 1.6.7）
 * --------------------------------------------
 * ffmpeg 每重写一次播放列表，都是「写 index.m3u8.tmp → 改名盖住 index.m3u8」。
 * Windows 上只要目标文件被别的句柄占着、而那个句柄没有 FILE_SHARE_DELETE，
 * 这一步就会失败（ffmpeg 只报一句 warning，而它是 -loglevel error，于是被吞掉）。
 * 本机实测（MoveFileEx 直调）：Node 侧持有句柄时，改名确实会失败。
 *
 * 1.6.6 的写法（server.js · handleLocalHls）：
 *     res.writeHead(200, { 'Content-Length': stat.size, ... });
 *     fs.createReadStream(target).pipe(res);
 * 而这段代码可能已经等了 25 秒，播放器那边却是「fetch + 2~3 秒超时中止」——
 * 播放列表刚写出来的那一刻，发起请求的客户端往往已经断了。对已经死掉的响应开读流，
 * 读流没人消费、永远走不到 'end'，fd 就不再归还（1.6.6 的现场：ffmpeg 报
 * “failed to rename file index.m3u8.tmp to index.m3u8: Operation not permitted”，
 * 而该文件句柄由 HubPlay 主进程持有，播放列表永远停在第一个分片）。
 *
 * 这个脚本怎么判
 * --------------
 * 两个子进程分别扮演「服务端」和「播放器的轮询」（必须分进程：同进程内复现不出来）。
 * 服务端子进程自己数：
 *     OPENED  本进程为播放列表开了几个读流
 *     CLOSED  其中有几个真正走到了 'close'（fd 归还）
 *   1) 负对照 legacy：必须出现 OPENED > CLOSED，否则说明这台机器上复现不出来，
 *      结论不可信，直接报 FAIL（退出码 2）；
 *   2) 回归 current ：必须 OPENED === CLOSED —— 一个都不许挂住。
 * 另外顺手记一次「改名能不能盖上」，作为辅助信号打印出来。
 *
 * 用法：node tools/hls_handle_leak_check.js
 */

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROUNDS = 3;
const LEGACY = 'legacy';
const CURRENT = 'current';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 子进程 */

/** 服务端：等播放列表出现，再按指定写法回包；自己统计读流的开/关。 */
function serve(mode, file, port) {
  const stats = { opened: 0, closed: 0, readFiles: 0 };
  const server = http.createServer(async (req, res) => {
    const deadline = Date.now() + 25000;
    for (;;) {
      try {
        const stat = await fsp.stat(file);
        if (stat.size > 0) {
          if (mode === LEGACY) {
            // 1.6.6 的写法：不检查客户端是否还在，读流直接接到响应上
            res.writeHead(200, {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Content-Length': stat.size,
              'Cache-Control': 'no-store',
            });
            stats.opened += 1;
            const stream = fs.createReadStream(file);
            stream.on('close', () => { stats.closed += 1; });
            stream.pipe(res);
            return;
          }
          // 1.6.7 的写法：客户端走了就不碰文件；列表整份读进内存再回包
          if (res.destroyed || res.writableEnded) return;
          stats.readFiles += 1;
          const buf = await fsp.readFile(file);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
          });
          res.end(buf);
          return;
        }
      } catch (err) { /* 还没写出来 */ }
      if (Date.now() > deadline) { try { res.writeHead(504); res.end(); } catch (e) { /* ignore */ } return; }
      await sleep(250);
    }
  });
  server.listen(port, '127.0.0.1');
  // 父进程到点后来取读数
  process.on('message', () => {});
  process.send = process.send || (() => {});
  const report = () => {
    process.stdout.write('STATS ' + JSON.stringify(stats) + String.fromCharCode(10), () => process.exit(0));
  };
  setTimeout(report, 12000);
  setTimeout(() => process.exit(0), 20000);
}

/** 客户端：播放器的读法 —— fetch + 超时中止，循环若干次。 */
async function poll(url, abortMs, everyMs, durationMs) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), abortMs);
    try {
      const r = await fetch(url, { signal: c.signal, cache: 'no-store' });
      await r.text();
    } catch (err) { /* 中止算正常 */ }
    clearTimeout(timer);
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ 父进程 */

/** ffmpeg 需要的那一步：把新列表改名盖住旧列表。做得到 = 没被占住。 */
function canReplaceByRename(file) {
  const probe = file + '.probe';
  try {
    fs.renameSync(file, probe);
    fs.renameSync(probe, file);
    return true;
  } catch (err) {
    try { if (fs.existsSync(probe)) fs.renameSync(probe, file); } catch (e) { /* ignore */ }
    return false;
  }
}

function runServerChild(mode, file, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, '--server', mode, file, String(port)], {
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('close', () => {
      const m = /STATS (\{[^}]*\})/.exec(out);
      resolve(m ? JSON.parse(m[1]) : { opened: -1, closed: -1, readFiles: -1 });
    });
  });
}

async function runRound(mode, index) {
  const dir = path.join(os.tmpdir(), 'hubplay-leak-check-' + mode + '-' + index + '-' + Date.now());
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'index.m3u8');
  const port = 19000 + Math.floor(Math.random() * 2000);

  const serverDone = runServerChild(mode, file, port);
  await sleep(700);
  const client = spawn(process.execPath, [__filename, '--client', 'http://127.0.0.1:' + port + '/index.m3u8', '1500', '250', '6000'], { stdio: 'ignore', windowsHide: true });
  await sleep(2100);

  const nl = String.fromCharCode(10);
  let body = '#EXTM3U' + nl + '#EXT-X-VERSION:7' + nl + '#EXT-X-PLAYLIST-TYPE:EVENT' + nl;
  for (let i = 0; i < 3; i += 1) body += '#EXTINF:2.000000,' + nl + 'seg0000' + i + '.m4s' + nl;
  await fsp.writeFile(file, body);

  try { client.kill(); } catch (e) { /* ignore */ }
  const stats = await serverDone;
  const replaceable = canReplaceByRename(file);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { stats, replaceable, leaked: stats.opened > stats.closed };
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--server') return serve(process.argv[3], process.argv[4], Number(process.argv[5]));
  if (arg === '--client') return poll(process.argv[3], Number(process.argv[4]), Number(process.argv[5]), Number(process.argv[6]));

  console.log('每种写法各跑 ' + ROUNDS + ' 轮（每轮约 12 秒）…');
  let legacyLeak = 0;
  let currentLeak = 0;
  let currentOpened = 0;
  for (let i = 0; i < ROUNDS; i += 1) {
    const r = await runRound(LEGACY, i);
    if (r.leaked) legacyLeak += 1;
    console.log('  负对照 ' + (i + 1) + '/' + ROUNDS + '：读流 opened=' + r.stats.opened +
      ' closed=' + r.stats.closed + '  改名可用=' + r.replaceable);
  }
  for (let i = 0; i < ROUNDS; i += 1) {
    const r = await runRound(CURRENT, i);
    if (r.leaked) currentLeak += 1;
    currentOpened += Math.max(0, r.stats.opened);
    console.log('  回归   ' + (i + 1) + '/' + ROUNDS + '：读流 opened=' + r.stats.opened +
      ' closed=' + r.stats.closed + '  改名可用=' + r.replaceable);
  }

  console.log('');
  console.log('legacy（createReadStream + 已中止的客户端）：' + legacyLeak + '/' + ROUNDS + ' 轮留下未关闭的读流');
  console.log('current（断开即返回 + 整份读进内存）      ：' + currentLeak + '/' + ROUNDS + ' 轮留下未关闭的读流');

  if (legacyLeak === 0) {
    console.log('FAIL：负对照一次都没复现出「读流不关」——这台机器上检查手段失效，先别信这个结果。');
    process.exit(2);
  }
  if (currentLeak > 0) {
    console.log('FAIL：当前写法仍会留下未关闭的读流。');
    process.exit(1);
  }
  if (currentOpened > 0) {
    console.log('FAIL：当前写法不该为播放列表开读流（opened=' + currentOpened + '）。');
    process.exit(1);
  }
  console.log('PASS：旧写法把读流挂在死掉的响应上，当前写法一次都没开过读流、更没的挂。');
  process.exit(0);
})();
