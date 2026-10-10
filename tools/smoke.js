'use strict';

/**
 * 纯 Node 冒烟测试：不启动 Electron，直接拉起本地服务验证
 *   1. iptv-hub 导入
 *   2. M3U 分片改写是否把相对路径换成代理地址
 *   3. Referer / UA 是否透传
 *   4. 裸 TS (/rtp/) 是否被正确标为不可播
 */

const path = require('path');
const { LocalServer } = require('../src/server');

const HUB = process.env.HUB_URL || 'http://127.0.0.1:18787';

async function main() {
  const server = new LocalServer({
    rendererDir: path.join(__dirname, '..', 'renderer'),
    dataDir: path.join(__dirname, '..', '.testdata'),
    port: Number(process.env.PORT || 17911),
  });
  const origin = await server.start();
  console.log('local server:', origin);

  const t0 = Date.now();
  const res = await fetch(`${origin}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: HUB }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`import failed: ${data.error}`);

  console.log(`导入耗时: ${Date.now() - t0}ms`);
  console.log(`kind=${data.kind} total=${data.total} playable=${data.playable} canEnrich=${data.canEnrich}`);
  console.log(`hub: ${data.hub.meta?.name} v${data.hub.meta?.version} tz=${data.hub.meta?.timezone}`);
  console.log(`stats: 频道 ${data.hub.stats?.channels} / 线路 ${data.hub.stats?.streams}`);
  console.log('分组:', data.groups.slice(0, 8).map((g) => `${g.name}(${g.count})`).join(' '));

  const cctv = data.channels.find((c) => /CCTV1$/.test(c.name)) || data.channels[0];
  console.log(`\n样本频道: ${cctv.name} [${cctv.group}] kind=${cctv.kind} 线路=${cctv.lineCount} 可播=${cctv.playableCount}`);

  const linesRes = await fetch(`${origin}/api/lines?id=${cctv.id}`);
  const lines = await linesRes.json();
  lines.lines.slice(0, 4).forEach((l, i) => {
    console.log(`  线路${i + 1} playable=${l.playable} kind=${l.kind} ref=${l.ref || '-'} ua=${l.ua ? 'yes' : '-'}`);
    console.log(`         ${l.url}`);
  });

  const first = lines.lines.find((l) => l.kind === 'hls');
  if (!first) {
    console.log('没有 HLS 线路，跳过代理验证');
  } else {
    const proxyUrl =
      `${origin}/p?u=${encodeURIComponent(first.url)}` +
      (first.ref ? `&r=${encodeURIComponent(first.ref)}` : '') +
      (first.ua ? `&ua=${encodeURIComponent(first.ua)}` : '');
    console.log('\n代理抓取播放列表...');
    const pr = await fetch(proxyUrl);
    const body = await pr.text();
    console.log(`  HTTP ${pr.status} content-type=${pr.headers.get('content-type')} bytes=${body.length}`);
    const segs = body.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    console.log(`  分片数=${segs.length}`);
    segs.slice(0, 3).forEach((s) => console.log(`    ${s.slice(0, 150)}`));

    if (segs[0] && segs[0].includes('/p?u=')) {
      const segRes = await fetch(segs[0]);
      console.log(`  拉取首个分片: HTTP ${segRes.status} type=${segRes.headers.get('content-type')}`);
      const buf = await segRes.arrayBuffer();
      console.log(`  分片字节数: ${buf.byteLength}`);
    }
  }

  // 裸 TS 标记检查
  const rawts = data.channels.filter((c) => c.kind === 'rawts');
  console.log(`\n裸 TS(/rtp/) 频道数: ${rawts.length}，示例: ${rawts.slice(0, 3).map((c) => c.name).join(', ')}`);

  const enrichStart = Date.now();
  const er = await fetch(`${origin}/api/enrich`, { method: 'POST' });
  const ed = await er.json();
  console.log(`\n元信息补全耗时: ${Date.now() - enrichStart}ms`, ed.enrich || ed.error);
  const after = ed.channels?.find((c) => /CCTV1$/.test(c.name));
  if (after) console.log(`  CCTV1 补齐后: speed=${after.speed} 线路=${after.lineCount} logo=${after.logo ? 'yes' : 'no'}`);

  await server.stop();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
