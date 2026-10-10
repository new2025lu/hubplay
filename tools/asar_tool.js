
'use strict';
/**
 * asar 拆包 / 打包 / 校验（纯 Node）。
 *
 * 为什么要自己写：**标准 node 不能 require asar**，而 Electron 自带的 node 会把
 * 任何以 .asar 结尾的路径都当压缩包劫持掉（连读一个名叫 app.asar 的普通文件都会 ENOENT）。
 * 所以这里直接按格式解析字节：4 字节 pickle 长度 + 8 字节 header pickle + header JSON + 对齐后的文件内容。
 *
 * 用法：
 *   node tools/asar_tool.js list   <app.asar>
 *   node tools/asar_tool.js verify <app.asar> <dir>          # 逐文件比对 integrity 哈希
 *   node tools/asar_tool.js export <app.asar> <dir>
 *   node tools/asar_tool.js pack   <dir> <out.asar>
 *   node tools/asar_tool.js rebuild <src.asar> <dir> <out.asar>   # 用 dir 里被改过的文件替换后重打包
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  /*
   * 头部布局（Chromium Pickle，全部对齐到 4 字节）：
   *   0   u32  4                    外层 pickle 长度
   *   4   u32  header pickle 总长    原包 = 4128（= 4 + 4 + 4 + 4116 对齐后的 JSON 区）
   *   8   u32  JSON 长度             原包 = 4117
   *   12  u32  ??                    原包 = 4117（Pickle 的 header size，与 JSON 长度相同）
   *   16  ...  JSON 本体，后面补 NUL 到 4 字节对齐
   *   base     = 16 + align4(JSON 长度)   ← 实测原包 = 4136，该处正是 icon.png 的 PNG 签名
   */
  const pickle0 = head.readUInt32LE(0);
  const pickle1 = head.readUInt32LE(4);
  const padded = head.readUInt32LE(8);      // JSON 区（含 NUL 对齐）
  const jsonLen = head.readUInt32LE(12);    // JSON 本体长度
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  const header = JSON.parse(jb.toString('utf8'));
  // 注意：偏移 8 那个长度比 JSON 区**多 4**（原包写 4124，而 JSON 区实际是 4120 = 4117 + 3 个 NUL 对齐）
  const base = 16 + padded - 4;
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, v] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (v.files) walk(v, p);
      else if (typeof v.size === 'number' && v.offset !== undefined) files.push({ p, off: Number(v.offset), size: v.size, hash: v.integrity && v.integrity.hash, node: v });
      else console.warn('  (跳过无法识别的条目 ' + p + ')');
    }
  };
  walk(header, '');
  return {
    base, pickle0, pickle1, jsonLen, padded, header, files,
    read: (p) => { const f = files.find((x) => x.p === p); if (!f) return null; const b = Buffer.alloc(f.size); fs.readSync(fd, b, 0, f.size, base + f.off); return b; },
    close: () => fs.closeSync(fd),
  };
}

function verifier(dir) {
  return (p, buf) => {
    const f = path.join(dir, p);
    if (!fs.existsSync(f)) return 'missing-in-dir';
    const d = fs.readFileSync(f);
    return d.length === buf.length && sha256(d) === sha256(buf) ? 'same' : 'DIFF';
  };
}

function list(file) {
  const a = readAsar(file);
  console.log('asar: ' + file);
  console.log('  pickle0=' + a.pickle0 + ' pickle1=' + a.pickle1 + ' jsonLen=' + a.jsonLen + ' padded=' + a.padded + ' contentBase=' + a.base);
  for (const f of a.files) {
    const ok = f.hash === sha256(a.read(f.p));
    console.log('  ' + (ok ? 'OK  ' : 'BAD ') + String(f.size).padStart(9) + ' @' + String(f.off).padStart(9) + '  ' + f.p);
  }
  a.close();
}

function verify(file, dir) {
  const a = readAsar(file);
  let bad = 0;
  const check = verifier(dir);
  for (const f of a.files) {
    const buf = a.read(f.p);
    const selfOk = f.hash === sha256(buf);
    const dirState = check(f.p, buf);
    if (!selfOk || dirState !== 'same') { bad++; console.log('  ' + (selfOk ? 'integrity-OK' : 'integrity-BAD') + '  dir=' + dirState + '  ' + f.p); }
  }
  a.close();
  console.log((bad ? '❌ ' : '✅ ') + (a.files.length - bad) + '/' + a.files.length + ' files match integrity hash and on-disk content');
  return bad === 0;
}

function exportAll(file, dir) {
  const a = readAsar(file);
  for (const f of a.files) {
    const out = path.join(dir, f.p);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, a.read(f.p));
  }
  a.close();
  console.log('exported ' + a.files.length + ' files -> ' + dir);
  return a.files.length;
}

/** 按 @electron/asar 的布局打包：header pickle + NUL 对齐 + 顺序文件内容。 */
function packDir(dir, outFile, order) {
  const files = [];
  const collect = (rel) => {
    const abs = path.join(dir, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) collect(r);
      else files.push(r.replace(/\\/g, '/'));
    }
  };
  collect('');
  if (order) files.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const tree = { files: {} };            // 根节点本身就是 { files: {...} }
  let offset = 0;
  const contents = [];
  for (const rel of files) {
    const data = fs.readFileSync(path.join(dir, rel));
    const parts = rel.split('/');
    let node = tree;                           // tree 本身就是 { files: {...} } 结构，别再套一层
    for (let i = 0; i < parts.length - 1; i++) {
      node.files = node.files || {};
      node.files[parts[i]] = node.files[parts[i]] || {};
      node = node.files[parts[i]];
    }
    node.files = node.files || {};
    node.files[parts[parts.length - 1]] = {
      size: data.length,
      offset: String(offset),
      integrity: { algorithm: 'SHA256', hash: sha256(data), blockSize: 4194304, blocks: [sha256(data)] },
    };
    offset += data.length;
    contents.push(data);
  }
  const jsonRaw = Buffer.from(JSON.stringify(tree), 'utf8');   // tree 就是整个 header（根节点自带 files）
  const pad = (4 - (jsonRaw.length % 4)) % 4;
  const json = pad ? Buffer.concat([jsonRaw, Buffer.alloc(pad)]) : jsonRaw;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);                    // 外层 pickle 长度
  head.writeUInt32LE(json.length + 8, 4);      // header pickle 总长（原包 = 4128 = 4120 + 8）
  head.writeUInt32LE(json.length + 4, 8);      // 原包这个位置比 JSON 区多 4（4124 vs 4120），照抄以保持布局一致
  head.writeUInt32LE(jsonRaw.length, 12);      // JSON 本体长度（原包 = 4117）
  fs.writeFileSync(outFile, Buffer.concat([head, json, ...contents]));
  const base = 16 + json.length;
  console.log('packed ' + files.length + ' files, contentBase=' + base + ' -> ' + outFile);
  return { count: files.length, base };
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd === 'list') list(a1);
else if (cmd === 'verify') { const ok = verify(a1, a2); process.exit(ok ? 0 : 1); }
else if (cmd === 'export') exportAll(a1, a2);
else if (cmd === 'pack') packDir(a1, a2);
else if (cmd === 'rebuild') {
  const src = readAsar(a1);
  const order = src.files.map((f) => f.p);
  src.close();
  const tmp = path.join(path.dirname(a2), '._pack_tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  exportAll(a1, tmp);
  // 用 dir 里的文件覆盖（只覆盖 dir 里真实存在、且内容不同的）
  let replaced = 0;
  const apply = (rel) => {
    const abs = path.join(a2, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { apply(r); continue; }
      const srcAbs = path.join(tmp, r);
      if (!fs.existsSync(srcAbs)) continue;
      const a = fs.readFileSync(srcAbs), b = fs.readFileSync(path.join(abs, e.name));
      if (sha256(a) !== sha256(b)) { fs.writeFileSync(srcAbs, b); replaced++; console.log('  replaced ' + r + '  (' + a.length + ' -> ' + b.length + ' bytes)'); }
    }
  };
  apply('');
  const out = packDir(tmp, a3, order);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rebuild done: replaced ' + replaced + ' file(s)');
} else {
  console.log('usage: list|verify|export|pack|rebuild');
  process.exit(2);
}
