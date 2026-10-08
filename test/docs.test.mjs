#!/usr/bin/env node
// 文档行号对账（零依赖，纯 node）——README / DESIGN 里印着的每一个 `path:NN` 都被读回来对账。
//
// 为什么要有这一支：文档里挂着成片的「去看第 N 行」，写这句话的时候没有任何机器核过它。
// 改了代码不重编行号，文档不会响，读者按图索骥找到的是隔壁那行。这一腿把那句话变成一条会红的断言。
// 条数不写在这里——本腿每次跑都当场数，写在注释里的那个数会在下一次改文档时变成第二句没人核的话。
//
// 口径与家族里其余几份（doublechoco / ferry / yajilin / echo-location / creek / lightsout / tapa /
// triplets）同一份，不是这一仓自创：
//   · 只有反引号里的 `path:NN` / `path:NN-MM` 算引用；逗号列出的每一段各算一条；
//   · 贴法两种都产出锚点——`NAME`（`path:NN`） 与 `path:NN` 的 `NAME`；间隔超过 4 个字符或跨行不算注解；
//   · 裸续引（完整引用后面只写 `:NN`）向同一句里最近的那条完整引用借路径，句号/分号/空行/新标题截断这次借，
//     借不到的计入「无法定址」，由等式闸逐处钉住，不静默跳过；
//   · 跨仓引用（`../别的仓/…:NN`）按形状分出去：单仓 checkout 里读不到它，按"文件在不在"决定红不红
//     就是一条随环境漂的闸。这条腿只数它，不替别的仓担保行号；
//   · 锚点认**整词**不认子串：短名字坐在声明长标识符的那一行上也会"出现"，子串口径把一次真的漂读成绿；
//   · 两半主判据各防一种谎：范围半 = 文件在盘上、行号落在真实行数内、**被指的那几行不许整段是空白**
//     （"在界内"不等于"指到了代码"）；锚点半 = 贴着引用那个名字必须作为完整标识符出现在被指的那几行里。
//
// 这一腿不覆盖什么：它只证明印在纸上的行号还坐在它所描述的那几行上，不证明周围的句子；
// 也不证明文档里那些没写成 `path:NN` 形状的说法。
// 跑法：本仓的 node 用例统一住在 test/*.test.mjs，`npm run unit` 用 glob 扫它们——所以这一份不需要
// 任何入口去点名它，`npm test`、tools/verify.sh 的 unit 段、以及 ci.yml 的 Suites 那一步（它调的就是
// `npm run unit`）都会跑到。那句「CI 会跑到」证的只是接线：跑没跑到由那一次 run 的读数说，本文件不复述远端形态。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATH_SRC = '[\\w./-]+?\\.(?:js|mjs|cjs|sh|json|yml|html|css|md)';
const CITE = new RegExp('^(' + PATH_SRC + '):([0-9]+(?:[,-][0-9]+)*)$');
const BARE = /^:([0-9]+(?:[,-][0-9]+)*)$/;
const STOP = /[。！？；]/;
const ID = /^[A-Za-z_$][A-Za-z0-9_$]{2,}(?:\.[A-Za-z_$][A-Za-z0-9_$]+)*$/;

const inheritedPath = (text, spans, i) => {
  for (let j = i - 1; j >= 0; j--) {
    const pc = spans[j].body.match(CITE);
    if (!pc) continue;
    const between = text.slice(spans[j].end, spans[i].s);
    if (between.includes('\n') && (STOP.test(between) || /\n[ \t]*\n/.test(between) || /\n#{1,6} /.test(between))) return null;
    return { path: pc[1] };
  }
  return null;
};
const tokOf = (body) => {
  const seg = body.includes('::') ? body.slice(body.lastIndexOf('::') + 2) : body;
  if (seg.includes('/')) return '';
  const head = seg.split('(')[0].trim();
  if (ID.test(head)) return head;
  const lhs = head.split(/[=:]\s/)[0].trim();
  return ID.test(lhs) ? lhs : '';
};

const lineCache = new Map();
const linesOf = (p) => {
  if (!lineCache.has(p)) {
    let arr = null;
    try {
      arr = fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n');
      if (arr[arr.length - 1] === '') arr.pop();
    } catch {
      arr = null;
    }
    lineCache.set(p, arr);
  }
  return lineCache.get(p);
};

function parseRefs(text, orphans = null) {
  const spans = [];
  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(text))) spans.push({ body: m[1], s: m.index, end: m.index + m[0].length });
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const c = spans[i].body.match(CITE);
    const bare = c ? null : BARE.exec(spans[i].body);
    if (!c && !bare) continue;
    const owner = c ? { path: c[1] } : inheritedPath(text, spans, i);
    if (!owner) { if (orphans) orphans.push(bare[0]); continue; }
    let anchor = '';
    let consumed = false;
    const next = spans[i + 1];
    const gA = next ? text.slice(spans[i].end, next.s) : null;
    if (gA !== null && gA.length <= 4 && !gA.includes('\n')) {
      const gN = gA.replace(/\s+/g, '');
      if (/^[（(]/.test(gN) || gN === '的') { consumed = true; anchor = tokOf(next.body); }
    }
    if (!consumed && i > 0) {
      const prev = spans[i - 1];
      const gap = text.slice(prev.end, spans[i].s);
      const gT = gap.replace(/\s+/g, '');
      const shaped = /^[（(]/.test(gT) || /[\w一-鿿]/.test(gT);
      if (shaped && !/\s/.test(prev.body) && gap.length <= 4 && !gap.includes('\n')) anchor = tokOf(prev.body);
    }
    const range = c ? c[2] : bare[1];
    for (const seg of range.split(',')) {
      const parts = seg.split('-').map(Number);
      out.push({ path: owner.path, from: parts[0], to: parts[parts.length - 1] || parts[0], anchor, cont: !c });
    }
  }
  return out;
}

const wordCache = new Map();
const hasWord = (text, name) => {
  if (!wordCache.has(name)) {
    wordCache.set(name, new RegExp('(^|[^A-Za-z0-9_$])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_$])'));
  }
  return wordCache.get(name).test(text);
};

function audit(text) {
  const orphans = [];
  const refs = parseRefs(text, orphans);
  const outOfRange = [];
  const anchorBad = [];
  let foreign = 0;
  for (const r of refs) {
    if (r.path.startsWith('..')) { foreign++; continue; }
    const label = `${r.path}:${r.from}${r.to !== r.from ? '-' + r.to : ''}`;
    const lines = linesOf(r.path);
    if (!lines) { outOfRange.push(`${label} 文件不存在`); continue; }
    if (r.from < 1 || r.to > lines.length) {
      outOfRange.push(`${label} 越界（该文件共 ${lines.length} 行）`);
      continue;
    }
    if (lines.slice(r.from - 1, r.to).join('').trim() === '') {
      outOfRange.push(`${label} 那几行整段是空行`);
      continue;
    }
    if (r.anchor) {
      // 点号限定名（`Game.recompute`）认**最后一段**：那是声明自己的名字，前缀是散文里的归属写法。
      const name = r.anchor.includes('.') ? r.anchor.split('.').pop() : r.anchor;
      if (!hasWord(lines.slice(r.from - 1, r.to).join('\n'), name)) anchorBad.push(`${label} 那几行里没有 ${name}`);
    }
  }
  // `` `文件`（N 行）`` 这种实测值按等式收：写歪一格、文件不在，都算指不回实处。
  const cntRe = new RegExp('`(' + PATH_SRC + ')`（([0-9]+) 行）', 'g');
  let k;
  while ((k = cntRe.exec(text))) {
    const lines = linesOf(k[1]);
    if (!lines) outOfRange.push(`${k[1]}（${k[2]} 行）文件不存在`);
    else if (lines.length !== Number(k[2])) outOfRange.push(`${k[1]} 实测 ${lines.length} 行，文档写的是 ${k[2]}`);
  }
  return { refs, outOfRange, anchorBad, cont: refs.filter((r) => r.cont).length, unaddressed: orphans.length, foreign };
}

// ── 输入集当场从跟踪清单取，不写死文件名 ──────────────────────────────────────────────────────
// 写死的清单会在有人新增一份 .md 的那天悄悄缩小样本，而它照样绿。
// 也不许只挑仓根：哪天一份文档住进 docs/ 或某个子目录，`!f.includes('/')` 就把它悄悄关掉 ——
// 那份就悄悄从样本里没了，而它照样绿。本仓今天的 .md 都还在仓根，这一句是给"以后那份"上的保险。
const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const docs = tracked.filter((f) => f.endsWith('.md') && !/changelog|license/i.test(f));
const DOC_TEXT = docs.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

let checks = 0, fails = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n       ${detail}`); }
};

const A = audit(DOC_TEXT);
// 另一条独立数法：只按形状数，不借路径、不认锚点。两条数法必须数到同一批引用。
// 它的文法要与 CITE 逐字一致：写成 `(?:,[0-9]+)*(?:-[0-9]+)?` 就数不到 `:21-22,44-51`（区间再并列），
// 于是这一类等式会在文档没写坏的那天因为数法自己漏数而红——fleet 那份第一次红就是这么来的。
const loose = [...DOC_TEXT.matchAll(new RegExp('`(' + PATH_SRC + '):([0-9]+(?:[,-][0-9]+)*)`', 'g'))]
  .reduce((n, m) => n + m[2].split(',').length, 0);
const looseBare = (DOC_TEXT.match(/`:[0-9]+(?:[,-][0-9]+)*`/g) || []).length;

ok('D1 输入集不空：跟踪清单里的 .md 当场数出（新增一份、或把它搬进子目录，都不会缩小样本）',
  docs.length >= 2, `本轮 ${docs.length} 份：${docs.join(', ') || '（一份都没扫到）'}`);
ok('D2 每份文档都至少贡献一条引用：某份被跳过时这里红，而不是条数悄悄变少',
  docs.every((f) => audit(fs.readFileSync(path.join(ROOT, f), 'utf8')).refs.length > 0),
  docs.map((f) => `${f}=${audit(fs.readFileSync(path.join(ROOT, f), 'utf8')).refs.length}`).join(' · '));
ok('D3 每一条 `path:NN` 都指回实处：文件在盘上、行号落在真实行数内、被指的那几行不许整段是空白',
  A.outOfRange.length === 0 && A.refs.length > 0,
  `解析 ${A.refs.length} 条 · 指不回实处 ${A.outOfRange.length} 条：${A.outOfRange.slice(0, 4).join(' | ') || '（0 条）'}`);
ok('D4 锚点腿：贴着引用那个名字必须作为**完整标识符**出现在被指的那几行里（整词，不是子串）',
  A.anchorBad.length === 0, `带指认 ${A.refs.filter((r) => r.anchor).length} 条 · 对不上 ${A.anchorBad.length} 条：${A.anchorBad.slice(0, 4).join(' | ') || '（0 条）'}`);
ok('D5 条数等式：本腿的解析段数 = 另一条独立数法（只按形状数）的段数 + 续引借来的段数',
  A.refs.length === loose + A.cont, `解析 ${A.refs.length} = 形状数 ${loose} + 续引 ${A.cont} · 文档里另有 ${looseBare} 处裸续引`);
ok('D6 续引都借到了路径：句号/分号/空行/新标题截断之后借不到的计入「无法定址」，一处都不许静默跳过',
  A.unaddressed === 0, `续引 ${A.cont} 条 · 无法定址 ${A.unaddressed} 条${A.unaddressed ? '：' + A.unaddressed : ''}`);
// 跨仓那几条被 D3/D4 分出去不判，这里就得有一条独立的数法对账：只按形状数，不看文件在不在。
// 两边同源于 parseRefs 的等式（`foreign === refs.filter(...)`）恒真，什么都拦不住，所以右边另起一路；
// 逗号列出的每一段各算一条，续引借到跨仓路径的那些单独加回（形状那一路看不见它们）。
const foreignRe = new RegExp('`(' + PATH_SRC + '):([0-9]+(?:[,-][0-9]+)*)`', 'g');
let foreignShape = 0;
for (let fm = foreignRe.exec(DOC_TEXT); fm; fm = foreignRe.exec(DOC_TEXT)) {
  if (fm[1].startsWith('..')) foreignShape += fm[2].split(',').length;
}
const foreignCont = A.refs.filter((r) => r.cont && r.path.startsWith('..')).length;
ok('D7 跨仓引用按形状分出去、只数不判（本仓 checkout 读不到别的仓的行号，判红就是随环境漂的闸）',
  A.foreign === foreignShape + foreignCont,
  `形状数 ${foreignShape} 段 + 续引借来 ${foreignCont} 段 · 解析分出去 ${A.foreign} 段 · 其余 ${A.refs.length - A.foreign} 段由 D3/D4 实判`);

// ── 反空转：两条判据各自要在同一份文本上"必须能红"──────────────────────────────────────────────
// 阳性对照不能来自文档本身（文档现在是绿的）。也不许靠"改写文档里那一条真引用"来造：一条路径常被引好几处，
// `replace` 打中的是第一处，它可能根本没带指认，那一格就以"变异没生效"的形状假绿。
// 所以喂给同一个 audit() 的是当场合成的两句文本，靶子（真空行行号、名字不在场的那一行）全部现量：
// 不写死行号，也不写死文件名——写死的夹具会在自己漂走那天停止测试。
const cited = [...new Set(A.refs.filter((r) => !r.path.startsWith('..') && linesOf(r.path)).map((r) => r.path))];
const blankHit = (() => {
  for (const p of cited) {
    const i = (linesOf(p) || []).findIndex((l) => l.trim() === '');
    if (i >= 0) return { p, line: i + 1 };
  }
  return null;
})();
const declRe = /^\s*(?:export\s+)?(?:var|let|const|function|class)\s+([A-Za-z0-9_$]+)/;
const anchorHit = (() => {
  for (const p of cited) {
    const L = linesOf(p) || [];
    for (let i = 0; i < L.length; i++) {
      const m = declRe.exec(L[i]);
      if (!m || !/^[A-Za-z_$][\w$]{2,}$/.test(m[1])) continue;
      for (let j = 0; j < L.length; j++) {
        if (j !== i && L[j].trim() !== '' && !hasWord(L[j], m[1])) return { p, name: m[1], line: j + 1 };
      }
    }
  }
  return null;
})();
if (blankHit) {
  const ma = audit(`见 \`${blankHit.p}:${blankHit.line}\``);
  ok('D8 反空转（范围半）：把引用指到被引文件的一处真空行上，范围腿必须红（"在界内"不等于"指到了代码"）',
    ma.refs.length === 1 && ma.outOfRange.length === 1 && /空行/.test(ma.outOfRange[0]),
    `靶子 ${blankHit.p}:${blankHit.line} · 合成后 refs=${ma.refs.length} outOfRange=${ma.outOfRange.length}：${ma.outOfRange.join(' | ')}`);
} else {
  ok('D8 反空转（范围半）：本腿当场量不到一把可用的空行靶子——这一格没被证明过', false,
    '被引用的文件里一行空行都没有，或解析到 0 条可判引用');
}
if (anchorHit) {
  const ma = audit(`见 \`${anchorHit.name}()\`（\`${anchorHit.p}:${anchorHit.line}\`）`);
  ok('D9 反空转（锚点半）：把带指认的引用搬到同一文件里不含那个名字的一行，锚点腿必须红、范围腿不许跟着红',
    ma.refs.length === 1 && ma.anchorBad.length === 1 && ma.outOfRange.length === 0,
    `靶子 ${anchorHit.name} @ ${anchorHit.p}:${anchorHit.line} · 合成后 anchorBad=${ma.anchorBad.length} outOfRange=${ma.outOfRange.length}：${ma.anchorBad.concat(ma.outOfRange).join(' | ')}`);
} else {
  ok('D9 反空转（锚点半）：本腿当场量不到"名字不在场"的靶子——这一格没被证明过', false,
    `可判文件 ${cited.length} 个里找不到一个「声明名 + 不含该名的非空行」配对`);
}

console.log(`\n文档行号对账：${docs.length} 份文档 · ${A.refs.length} 条引用 · ${A.refs.filter((r) => r.anchor).length} 条带指认 · ${A.cont} 条续引 · ${A.foreign} 条跨仓`);
console.log(`rows: ${checks} fail: ${fails}`);
console.log(`RESULT docs-test ok=${fails === 0} checks=${checks} fails=${fails}`);
if (fails) process.exit(1);
