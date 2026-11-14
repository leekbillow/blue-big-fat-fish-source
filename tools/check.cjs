#!/usr/bin/env node
/*
 * 蓝色大肥鱼 · 页面自检
 *   用法（任意目录均可）：node tools/check.cjs
 * 9 项全绿才算过；有红项会打印详情并以退出码 1 结束。
 */
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const HTML = path.join(BASE, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const dataJs = fs.readFileSync(path.join(BASE, 'data.js'), 'utf8');

let SCENES, TRIGGERS, IMGNOTE;
const results = [];
const check = (name, fn) => {
  try { results.push({ name, ok: true, detail: fn() }); }
  catch (e) { results.push({ name, ok: false, detail: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ---------- 1. 数据求值 ---------- */
check('数据求值（SCENES / TRIGGERS / IMGNOTE / CLASSES）', () => {
  const api = new Function(dataJs + '\nreturn {SCENES,TRIGGERS,IMGNOTE,CLASSES};')();
  SCENES = api.SCENES; TRIGGERS = api.TRIGGERS; IMGNOTE = api.IMGNOTE;
  assert(Array.isArray(SCENES) && SCENES.length, 'SCENES 求值为空');
  const byCls = {};
  SCENES.forEach((s) => { byCls[s.cls] = (byCls[s.cls] || 0) + 1; });
  return SCENES.length + ' 条（' + Object.entries(byCls).map(([k, v]) => k + ' ' + v).join(' / ') + '）';
});

/* ---------- 2. 编号唯一 + no/disp 一致 ---------- */
check('编号唯一 + 内部 id 与显示编号一致', () => {
  const ids = SCENES.map((s) => s.no);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert(!dup.length, '重复 id: ' + dup.join(','));
  const groups = {};
  SCENES.forEach((s) => { (groups[s.cls] = groups[s.cls] || []).push(s); });
  const bad = [];
  Object.keys(groups).forEach((k) => groups[k].forEach((s, i) => {
    if (s.no !== k + (i + 1)) bad.push(s.no + ' 应为 ' + k + (i + 1));
  }));
  assert(!bad.length, '错位: ' + bad.join('; '));
  return ids.length + ' 个 id，各类内顺序与 id 完全一致';
});

/* ---------- 3. TRIGGERS 覆盖 ---------- */
check('TRIGGERS 覆盖全部条目', () => {
  const miss = SCENES.filter((s) => !TRIGGERS[s.no]).map((s) => s.no);
  assert(!miss.length, '缺触发源: ' + miss.join(','));
  const extra = Object.keys(TRIGGERS).filter((k) => !SCENES.some((s) => s.no === k));
  assert(!extra.length, 'TRIGGERS 有多余键: ' + extra.join(','));
  return Object.keys(TRIGGERS).length + ' 条触发源，另 ' + Object.keys(IMGNOTE).length + ' 条图文核注';
});

/* ---------- 4. 图片命中 ---------- */
const allAssets = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else allAssets.push(path.relative(BASE, f).split(path.sep).join('/'));
  });
})(path.join(BASE, 'assets'));

const used = new Map();
SCENES.forEach((s) => {
  (Array.isArray(s.orig) ? s.orig : (s.orig ? [s.orig] : [])).forEach((o) => {
    if (o && o.src) used.set(o.src, s.no);
  });
  (s.imgs || []).forEach((i) => used.set(/^\d{3,4}$/.test(i) ? 'assets/memes/' + i + '.webp' : i, s.no));
});
[...html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)].forEach((m) => used.set(m[1], '页面静态引用'));

check('图片引用全部命中（无缺失、无外链）', () => {
  const missing = [], remote = [];
  [...used.keys()].forEach((u) => {
    if (/^https?:/.test(u)) { remote.push(u); return; }
    if (!fs.existsSync(path.join(BASE, u.split('/').join(path.sep)))) missing.push(u + '（' + used.get(u) + '）');
  });
  assert(!missing.length, '缺失文件: ' + missing.join(', '));
  assert(!remote.length, '外链图片: ' + remote.join(', '));
  return used.size + ' 个引用全部存在，无外链图片';
});

check('assets 无未引用文件', () => {
  const lower = new Set([...used.keys()].map((u) => u.toLowerCase()));
  const unused = allAssets.filter((f) => !lower.has(f.toLowerCase()));
  assert(!unused.length, '未引用: ' + unused.join(', '));
  return allAssets.length + ' 个资源全部在用';
});

/* ---------- 5. 标签平衡 ---------- */
check('静态 HTML 标签平衡', () => {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const VOID = new Set(['br', 'img', 'meta', 'link', 'input', 'hr', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);
  const stack = [], errs = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(stripped))) {
    const close = m[1] === '/', tag = m[2].toLowerCase();
    if (VOID.has(tag) || /\/$/.test(m[3].trim())) continue;
    if (!close) stack.push(tag);
    else {
      if (!stack.length) { errs.push('多余闭合 </' + tag + '>'); continue; }
      const top = stack.pop();
      if (top !== tag) errs.push('<' + top + '> 被 </' + tag + '> 关闭');
    }
  }
  assert(!stack.length, '未闭合: ' + stack.join(','));
  assert(!errs.length, errs.join('; '));
  return '开闭配对正确';
});

/* ---------- 6. JS 引用的 id 都存在 ---------- */
check('JS 引用的 DOM id 都存在（无 null 引用）', () => {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const staticIds = new Set([...html.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set();
  [...script.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].forEach((m) => refs.add(m[1]));
  [...script.matchAll(/querySelector(?:All)?\(\s*['"]#([^'"\s.\[:>]+)/g)].forEach((m) => refs.add(m[1]));
  const runtime = new Set(['sec-a', 'sec-b', 'sec-c', 'sec-d']);
  const miss = [...refs].filter((id) => !staticIds.has(id) && !runtime.has(id));
  assert(!miss.length, '引用了不存在的 id: ' + miss.join(','));
  return refs.size + ' 个引用全部有效';
});

/* ---------- 7. 卡片/弹窗图片路径可用 ---------- */
check('卡片/弹窗图片路径可用', () => {
  const bad = [], noMeme = [];
  SCENES.forEach((s) => {
    if (!s.imgs || !s.imgs.length) { noMeme.push(s.no); return; }
    const first = s.imgs[0];
    const u = /^\d{3,4}$/.test(first) ? 'assets/memes/' + first + '.webp' : first;
    if (!fs.existsSync(path.join(BASE, u.split('/').join(path.sep)))) bad.push(s.no + ' → ' + u);
    if (s.orig) {
      const o = Array.isArray(s.orig) ? s.orig[0] : s.orig;
      if (o && o.src && !fs.existsSync(path.join(BASE, o.src.split('/').join(path.sep)))) bad.push(s.no + ' 原图 → ' + o.src);
    }
  });
  assert(!bad.length, bad.join('; '));
  return (SCENES.length - noMeme.length) + ' 条的卡片与弹窗图片均存在'
    + (noMeme.length ? '；' + noMeme.length + ' 条无梗图（' + noMeme.join(' ') + '）' : '');
});

/* ---------- 8. DOM 桩渲染真实执行 ---------- */
check('DOM 桩渲染（脚本执行 + 卡片 + 弹窗）', () => {
  const registry = [], byId = {};
  const qsa = (sel) => (sel === '.card' || sel === '.card:not([style*="display: none"])')
    ? registry.filter((e) => (' ' + e._cls + ' ').includes(' card ')) : [];
  const makeEl = (tag, id) => {
    const el = {
      tagName: (tag || 'div').toUpperCase(), id: id || '', _cls: '', _html: '', textContent: '', value: '',
      dataset: {}, style: {}, children: [], attrs: {}, scrollTop: 0, src: '',
      appendChild(c) { el.children.push(c); return c; },
      removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
      addEventListener() {}, removeEventListener() {}, insertBefore(c) { el.children.push(c); return c; },
      setAttribute(k, v) { el.attrs[k] = v; }, getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      classList: {
        add(...c) { c.forEach((x) => { if (!(' ' + el._cls + ' ').includes(' ' + x + ' ')) el._cls = (el._cls + ' ' + x).trim(); }); },
        remove(...c) { c.forEach((x) => { el._cls = (' ' + el._cls + ' ').split(' ').filter((v) => v && v !== x).join(' '); }); },
        contains(c) { return (' ' + el._cls + ' ').includes(' ' + c + ' '); }, toggle() {},
      },
      get innerHTML() { return el._html; }, set innerHTML(v) { el._html = v; },
      get className() { return el._cls; }, set className(v) { el._cls = v; },
    };
    registry.push(el); return el;
  };
  const stubDoc = {
    getElementById(id) { if (!byId[id]) byId[id] = makeEl('div', id); return byId[id]; },
    createElement(tag) { return makeEl(tag); },
    querySelector() { return null; }, querySelectorAll(sel) { return qsa(sel); },
    addEventListener() {}, body: makeEl('body'),
  };
  const body = dataJs + '\n' + [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const api = new Function('document', 'window', 'console',
    body + '\n;return {SCENES,openViewer};')(stubDoc, { addEventListener() {} }, console);

  const cards = registry.filter((e) => (' ' + e._cls + ' ').includes(' card '));
  let cardCount = 0;
  registry.filter((e) => e._cls === 'grid').forEach((g) => g.children.forEach((c) => { if ((' ' + c._cls + ' ').includes(' card ')) cardCount++; }));
  assert(cards.length === api.SCENES.length, '卡片生成 ' + cards.length + ' 张 ≠ 条目 ' + api.SCENES.length + ' 条');
  assert(cardCount === api.SCENES.length, '展开后入列 ' + cardCount + ' 张 ≠ 条目 ' + api.SCENES.length + ' 条');
  const junk = cards.filter((c) => /undefined|NaN|\[object Object\]/.test(c._html));
  assert(!junk.length, junk.length + ' 张卡片含 undefined/NaN');

  const errs = [];
  api.SCENES.forEach((s) => {
    try {
      api.openViewer(s.no);
      if (!byId['vtrans'] || byId['vtrans']._html.length < 50) errs.push(s.no + ' 转录为空');
      if (!byId['vtabs'].children.length) errs.push(s.no + ' 无媒体标签');
    } catch (e) { errs.push(s.no + ': ' + e.message); }
  });
  assert(!errs.length, errs.join('; '));
  return cardCount + ' 张卡片（入列）+ ' + api.SCENES.length + ' 个弹窗全部渲染成功';
});

/* ---------- 输出 ---------- */
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log('\n🐳 大肥鱼页面自检 · ' + path.relative(process.cwd(), HTML) + '\n');
results.forEach((r, i) => {
  console.log('  ' + (r.ok ? '✅' : '❌') + ' [' + (i + 1) + '/' + results.length + '] ' + pad(r.name, 40) + r.detail);
});
const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? '❌ ' + failed.length + ' 项未通过' : '✅ ' + results.length + '/' + results.length + ' 全部通过') + '\n');
process.exit(failed.length ? 1 : 0);
