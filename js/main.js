// The shell: hash routes in, canvas out, save file in between. Nothing here knows the rules of
// the chart — those live in js/core — and nothing here draws — that is js/view.js.
//
// Two things this file is careful about, because the repo's whole claim rests on them:
//
//   * It never searches on a gesture. Every tap/drag is checked by `js/core/rules.js`'s
//     single-step legality plus `clueStatus` for the tally. The solver is only ever called from
//     `window.fleet.probe()`, which a test (or the maintainer) asks for; build-time generation
//     lives in tools/bake.mjs, not here.
//   * Every number it prints was measured by something else: `solutionCount`, `depth` and
//     `guesses` are read out of js/data/lots.js, which tools/bake.mjs writes and
//     test/lots.test.mjs recomputes. The shell does not rate a chart.

import {
  createGame, restoreGame, dumpGame, placeHull, liftHull, hullAt, undo, resetGame, markWater,
  cycleMark, tapPlace, statusOf, fleetLeft, progress, boardOf,
} from './core/game.js';
import { SHIP, WATER, UNKNOWN, MARK, createBoard, set, hullsOf, parseBoard, serialize, summarize } from './core/board.js';
import { deduce } from './core/solve.js';
import { solve } from './core/solve.js';
import { countByTable } from './core/enumerate.js';
import { store } from './core/storage.js';
import {
  TIERS, ALL, byId, levelAt, lotsIn, randomLot, dailyLot, tierByKey, puzzleOf, indexOf,
} from './core/library.js';
import { todayKey } from './core/rng.js';
import { createView } from './view.js';
import { createAudio } from './audio.js';
import './pwa.js'; // 离线注册：副作用导入，成功/失败都挂在 window.fleetPwa 上

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  dock: $('dock'), shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'),
  verdict: $('verdict'), tally: $('tally'), undo: $('undo'), hint: $('hint'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('chart'), wipe: $('wipe'),
  sound: $('sound'), pause: $('pause'), fullscreen: $('fullscreen'), help: $('help'),
  resume: $('resume'), pauseveil: $('pauseveil'), howto: $('howto'), howtoClose: $('howto-close'),
};

const CHARTS = ALL.length;

const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  hints: 0,
  label: '',
  day: null,
  paused: false,
};

// 声音只有一个出口：js/audio.js。这里不判断"该不该响"（那是静音的活），只决定"这一步算什么声音"。
const audio = createAudio(window);

const CODE_NAMES = {
  outOfBounds: '船身画到图外去了',
  overlap: '这一格已经有船了',
  contact: '两艘船不能相邻，斜角也不行',
  fleet: '船坞里没有这个长度，或者舰队已经全部下水',
  rowClue: '这一行的船格数对不上线索',
  colClue: '这一列的船格数对不上线索',
};

function clampIndex(n) {
  return Math.min(CHARTS, Math.max(1, Number(n) || 1));
}

// #/c/12 · #/daily · #/random/patrol/4kq2 · #/lot/harbour-03
// A lot id in the URL resolves to the same clues on another device without the receiver
// needing the sender's save file: the link shares the chart, never a score.
function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIERS[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  return { mode: 'campaign', index: clampIndex(n) };
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    return { lot: dailyLot(day), label: `每日一题 · ${day}`, note: `seed hashSeed('daily|${day}')`, day };
  }
  if (rt.mode === 'random') {
    const tier = tierByKey(rt.tier);
    return { lot: randomLot(rt.key, tier.key), label: `随机 · ${tier.label}`, note: tier.blurb };
  }
  if (rt.mode === 'lot') {
    const lot = byId(rt.id) || ALL[0];
    return { lot, label: `题面 ${lot.id}`, note: tierByKey(lot.tier).blurb };
  }
  const lot = levelAt(rt.index - 1);
  return { lot, label: `第 ${rt.index} 题`, note: `共 ${CHARTS} 题 · ${tierByKey(lot.tier).label}` };
}

const view = createView(el.canvas, {
  onDrag: (x, y, len, axis) => commitDrag(x, y, len, axis),
  onTap: (x, y) => commitTap(x, y),
  onWater: (x, y) => commitWater(x, y),
  onQuery: (x, y) => commitQuery(x, y),
});

// --- 暂停 ---------------------------------------------------------------------------
// 暂停改的是"这局还推不推进"，不是遮罩的透明度：画布的 rAF 循环被取消（`step()` 再也拿不到
// dt，抖动与提示高亮都停在原地），音频上下文挂起，手势在 view 与这里各挡一次 —— 后者是为了
// `window.fleet.drag()` 这类绕过手指的调用也挡得住，否则"暂停"只对鼠标成立。
function setPaused(on) {
  const next = !!on && !!app.game && !app.game.done;
  if (app.paused === next) return app.paused;
  app.paused = next;
  view.setPaused(next);
  if (next) audio.hold();
  else audio.release(); // 静音态下 release 不会唤醒上下文：那是偏好，不是暂停的副作用
  el.pauseveil.hidden = !next;
  el.pause.setAttribute('aria-pressed', String(next));
  el.pause.textContent = next ? '已暂停' : '暂停';
  return app.paused;
}

function blocked() {
  if (!app.paused) return false;
  say('<b>已暂停</b> · 盘面不再推进：按 P 或点"继续"再下子');
  return true;
}

function say(html) {
  el.hintline.innerHTML = html;
}

function setGame(lot, label) {
  app.lot = lot;
  app.label = label || app.label;
  app.game = createGame(lot);
  app.hints = 0;
  setPaused(false); // 换一题就是重新开始看盘，不把上一题的暂停带过来
  const draft = store.loadProgress(lot.id);
  let restored = false;
  if (draft) {
    restored = !!restoreGame(app.game, draft);
    if (!restored) store.saveProgress(lot.id, '');
  }
  view.attach(app.game);
  el.curtain.hidden = true;
  say(restored ? '接着上次的图：这是你留在本机的一半舰队' : '');
  after();
}

// The one place a gesture lands: a finger on the canvas, a replay from a test link and the
// panel's own buttons all arrive here, and all get held to the same rule.
function refuse(code, hull) {
  store.reject();
  audio.play('refuse');
  const p = progress(app.game);
  if (hull) view.kickHull(hull);
  for (const line of statusOf(app.game).rows) if (line.over) view.kickLine('r', line.i);
  for (const line of statusOf(app.game).cols) if (line.over) view.kickLine('c', line.i);
  say(`<b>不计入</b> · ${CODE_NAMES[code] || code} · 累计拒绝 ${p.errors} 次`);
  view.redraw();
  renderReadout();
  return false;
}

function commitDrag(x, y, len, axis) {
  if (blocked()) return false;
  const r = placeHull(app.game, x, y, len, axis);
  if (!r) return false;
  if (!r.ok) return refuse(r.code, { x, y, len, axis });
  audio.play('place');
  after(`放入 <b>${len}</b> 格${axis === 'h' ? '横' : '竖'}船 · (${x},${y})`);
  return true;
}

// A tap on open water lays the shortest hull still in the dock (that is how a submarine gets
// drawn — there is no drag short enough to draw one); a tap on a hull lifts it again.
function commitTap(x, y) {
  if (blocked()) return false;
  if (hullAt(app.game, x, y) >= 0) {
    if (!liftHull(app.game, x, y)) return false;
    audio.play('mark');
    after(`捞起 (${x},${y}) 那条船`);
    return true;
  }
  const r = tapPlace(app.game, x, y);
  if (!r.ok) return refuse(r.code, { x, y, len: 1, axis: 'h' });
  audio.play('place');
  after(`轻点放入 <b>${r.hull.len}</b> 格船 · (${x},${y})`);
  return true;
}

function commitWater(x, y) {
  if (blocked()) return false;
  if (cellStateAt(x, y) === SHIP) {
    say(`<b>不计入</b> · 这一格已经有船了 —— 要换位置就先点它把它捞起来`);
    view.kickHull({ x, y, len: 1, axis: 'h' });
    view.redraw();
    return false;
  }
  if (!markWater(app.game, x, y)) {
    const st = statusOf(app.game);
    if (!st.rows[y].full || !st.cols[x].full) {
      say(`<b>不计入</b> · 第 ${y + 1} 行还要 ${Math.max(0, st.rows[y].clue - st.rows[y].have)} 格，第 ${x + 1} 列还要 ${Math.max(0, st.cols[x].clue - st.cols[x].have)} 格 —— 这一格还可能藏船`);
      view.kickHull({ x, y, len: 1, axis: 'h' });
      view.redraw();
      return false;
    }
    return false; // already water: re-marking is not a second move
  }
  after('涂上一格水');
  audio.play('water');
  return true;
}

function commitQuery(x, y) {
  if (blocked()) return false;
  if (hullAt(app.game, x, y) >= 0) return false;
  if (!cycleMark(app.game, x, y)) return false;
  const on = cellStateAt(x, y) === MARK;
  audio.play('mark');
  after(`铅笔 <b>?</b> ${on ? '落下' : '擦去'}`);
  return true;
}

function cellStateAt(x, y) {
  const b = boardOf(app.game);
  return b.cells[y * app.game.n + x];
}

// The save file keeps a draft for a chart that has something on it, and nothing for one that
// does not. Writing an all-dots draft every time a chart is opened would fill the save with 96
// empty rows and make "清空存档 leaves nothing behind" false on the device that just wiped it.
function persist() {
  const p = progress(app.game);
  const settled = hullCellsOf(p) + p.marks;
  if (settled) store.saveProgress(app.lot.id, dumpGame(app.game));
  else if (store.loadProgress(app.lot.id)) store.saveProgress(app.lot.id, '');
}

// What happens after any gesture: redraw, persist the draft, then either report progress or
// finish the chart. The over-clue warning lives here because a legal drop can still overshoot:
// `canPlaceHull` never reads a clue.
function after(note) {
  view.redraw();
  const p = progress(app.game);
  if (p.done) {
    store.saveProgress(app.lot.id, '');
    finish(p);
    return;
  }
  persist();
  if (p.over) {
    const st = statusOf(app.game);
    const lines = [
      ...st.rows.filter((r) => r.over).map((r) => `第 ${r.i + 1} 行`),
      ...st.cols.filter((c) => c.over).map((c) => `第 ${c.i + 1} 列`),
    ];
    say(`<b>超线 ${lines.join('、')}</b> · 船格已经压过线索，这一条不算满足（放错的那步仍然算一步）`);
  } else if (note) {
    const left = p.fleetLeft.length ? `还剩 ${p.fleetLeft.join('/')}` : '舰队已全部下水';
    say(`${note} · ${left} · 已涂水 ${p.marks} 格 · 拒绝 ${p.errors} 次`);
  }
  renderReadout();
  renderTotals();
}

function finish(p) {
  const lot = app.lot;
  const rec = store.solve(lot.id, { moves: p.hulls });
  if (app.day) store.markDaily(app.day, lot.id);
  let nextIndex = 0;
  if (app.mode === 'campaign') {
    store.unlock(Math.max(store.unlocked, app.index + 1));
    nextIndex = app.index < CHARTS ? app.index + 1 : 0;
  }
  el.next.hidden = !nextIndex;
  el.tally.innerHTML = `你的 <b>${p.hulls}</b> 次放船 · 拒绝 <b>${p.errors}</b> 次 · 涂水 <b>${p.marks}</b> 格<br>`
    + `这一题唯一解 <b>${lot.solutionCount}</b> 个（两条独立路线对账），求解器实测假设层数 <b>${lot.depth}</b>、推理枯竭 <b>${lot.guesses}</b> 次`
    + (rec.best === p.hulls ? '<br>这是这一题的最好成绩' : `<br>本机最好成绩 <b>${rec.best}</b> 次`);
  el.verdict.textContent = '舰队就位';
  el.curtain.hidden = false;
  setPaused(false); // 解开了就不该停在暂停态：遮罩要把结果画在最后一帧上
  audio.play('win');
  render();
}

function renderCrumbs() {
  const tier = tierByKey(app.lot.tier);
  el.crumbs.innerHTML = `${app.label}<b>${tier.label}<span class="band"> ${tier.blurb}</span></b>`;
}

function field(label, value, note, cls = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><dt><small>${note}</small></dt></div>`;
}

function renderReadout() {
  const p = progress(app.game);
  const lot = app.lot;
  const rec = store.record(lot.id);
  el.readout.innerHTML = [
    field('船坞', p.fleetLeft.length ? p.fleetLeft.join(' · ') : '空', `舰队 ${lot.fleet.join('/')} 格`),
    field('下水', `${p.hulls}/${lot.fleet.length}`, '放船次数'),
    field('涂水', p.marks, `空格 ${(lot.n * lot.n) - p.marks - hullCellsOf(p)}`),
    field('拒绝', p.errors, '不计入', p.errors ? 'over' : ''),
    field('超线', p.over, '压过线索的行/列', p.over ? 'over' : ''),
    field('完成', p.done ? '是' : '否', '行+列+舰队全对'),
    field('唯一解', lot.solutionCount, '两条路线实测', 'par'),
    field('假设层数', lot.depth, `推理枯竭 ${lot.guesses} 次`, 'par'),
    field('题面', `${lot.n}×${lot.n}`, lot.id),
    field('最好成绩', rec && Number.isFinite(rec.best) ? rec.best : '—', rec ? `下过 ${rec.plays} 次` : '还没有记录', 'best'),
  ].join('');
  el.dock.innerHTML = renderDock(p);
  el.undo.disabled = !app.game.history.length || app.game.done;
  el.hint.disabled = app.game.done;
  el.restart.disabled = !p.hulls && !p.marks && !p.errors;
}

// The number of ship squares afloat, straight off the board the rules read.
function hullCellsOf(p) {
  return (p.dump.match(/#/g) || []).length;
}

function renderDock(p) {
  const fleet = app.lot.fleet;
  const left = p.fleetLeft;
  let html = '';
  for (const len of fleet) {
    const k = left.indexOf(len);
    const afloat = k < 0;
    if (!afloat) left.splice(k, 1);
    let bars = '';
    for (let c = 0; c < len; c++) bars += '<i></i>';
    html += `<span class="hull ${afloat ? 'afloat' : ''}">${bars}<em>${len}</em></span>`;
  }
  return html + `<span class="legend">拖动画船 · 轻点放最短船 · 点船捞起 · Shift+点涂水 · 右键/长按记 <b>?</b></span>`;
}

function renderTotals() {
  const doneN = ALL.filter((l) => {
    const r = store.record(l.id);
    return r && r.solved;
  }).length;
  el.totals.innerHTML = `已解 <b>${doneAll(doneN)}</b>/${CHARTS} · 拒绝 <b>${store.stats.rejects}</b> 次 · 放船 <b>${store.stats.drags}</b> 次`
    + (store.persistent() ? '' : ' · <b>本机不保存</b>');
}

function doneAll(n) {
  return n;
}

function renderShelf() {
  if (app.mode === 'campaign') {
    const unlocked = store.unlocked;
    let html = '';
    for (const tier of TIERS) {
      html += `<p class="tier">${tier.label} · ${tier.band}</p>`;
      for (const lot of lotsIn(tier.key)) {
        const n = indexOf(lot) + 1;
        const rec = store.record(lot.id);
        const cls = [
          n === app.index ? 'here' : '',
          rec && rec.solved ? 'done' : '',
        ].filter(Boolean).join(' ');
        html += `<button type="button" data-index="${n}" class="${cls}" title="实测假设层数 ${lot.depth} · 枯竭 ${lot.guesses} 次" ${n > unlocked ? 'disabled' : ''}>${n}</button>`;
      }
    }
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-index]').forEach((b) => {
      b.addEventListener('click', () => go(`#/c/${b.dataset.index}`));
    });
    return;
  }
  if (app.mode === 'random') {
    let html = '<p class="tier">选一段（band 是求解器实测的假设层数）</p>';
    for (const tier of TIERS) {
      const on = tier.key === app.route.tier ? 'here' : '';
      html += `<button type="button" class="${on}" data-tier="${tier.key}">${tier.label}<br><small>${tier.band} · ${tier.blurb}</small></button>`;
    }
    html += '<button type="button" class="wide" data-reroll="1">换一题</button>';
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-tier]').forEach((b) => {
      b.addEventListener('click', () => go(`#/random/${b.dataset.tier}/${token()}`));
    });
    el.shelf.querySelector('[data-reroll]').addEventListener('click', () => go(`#/random/${app.route.tier}/${token()}`));
    return;
  }
  if (app.mode === 'daily') {
    const done = app.day && store.dailyDone(app.day);
    el.shelf.innerHTML = `<p class="tier">今天这一题对所有设备相同（种子是日期）${done ? ' · 已解' : ''}</p>`
      + `<button type="button" class="wide" data-back="1">回到战役 第 ${store.unlocked} 题</button>`;
  } else {
    el.shelf.innerHTML = '<p class="tier">分享的题面</p>';
  }
  const back = el.shelf.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => go(`#/c/${store.unlocked}`));
}

function render() {
  el.modes.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  });
  renderCrumbs();
  renderReadout();
  renderTotals();
  renderShelf();
}

function token() {
  // `Math.random()` can in principle return exactly 0, which would stringify to "0" and mint
  // an empty token — and an empty token is a route that re-mints itself forever.
  return Math.random().toString(36).slice(2) || 'roll';
}

function go(hash) {
  if (location.hash === hash) apply();
  else location.hash = hash;
}

function apply() {
  const rt = parseHash();
  app.route = rt;
  app.mode = rt.mode;
  if (rt.mode === 'random' && !rt.key) {
    // A bare #/random/patrol would mean a different chart on every visit and an unreproducible
    // link, so the token is minted once and written back into the URL.
    location.replace(`${location.pathname}${location.search}#/random/${rt.tier}/${token()}`);
    return;
  }
  const r = resolve(rt);
  if (!r.lot) {
    say('这一段还没有题面');
    return;
  }
  app.day = r.day || null;
  app.index = rt.mode === 'campaign' ? rt.index : indexOf(r.lot) + 1;
  setGame(r.lot, r.label);
  render();
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/lot/${app.lot.id}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('链接已复制：分享的是题面，不是成绩'), () => toast(url));
  } else {
    toast(url);
  }
}

// 提示 is the propagation in js/core/solve.js made visible: `deduce` writes only what the
// clues and the diagonal rule already prove, with no assumption and no search, so a hint can
// never spoil a chart. It costs nothing on the tap path because it is only called from here.
function hintOnce() {
  const d = deduce(puzzleOf(app.lot));
  if (!d) {
    say('线索推到这里已经矛盾了 —— 有一步船放错了');
    return { cells: [], line: '' };
  }
  const board = boardOf(app.game);
  const open = [];
  for (let i = 0; i < d.cells.length; i++) {
    if (board.cells[i] !== UNKNOWN) continue;
    if (d.cells[i] !== UNKNOWN) open.push(i);
  }
  app.hints++;
  view.showDeduction(open);
  view.redraw();
  audio.play('hint');
  const line = open.length
    ? `提示 ${open.length} 格：线索与斜角规则已经能定下这些位置（不含任何假设）`
    : '提示：这一格已经推不出去了，剩下的要靠假设 —— 这道题的实测假设层数是 ' + app.lot.depth;
  say(line);
  return { cells: open, line, hints: app.hints };
}

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  if (b.dataset.mode === 'campaign') go(`#/c/${clampIndex(store.unlocked)}`);
  else if (b.dataset.mode === 'daily') go('#/daily');
  else go(`#/random/${TIERS[0].key}/${token()}`);
});

el.undo.addEventListener('click', () => {
  if (blocked()) return;
  if (!undo(app.game)) return;
  audio.play('mark');
  persist();
  view.redraw();
  renderReadout();
  say('撤销一步');
});

el.hint.addEventListener('click', () => { if (!blocked()) hintOnce(); });
el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(CHARTS, app.index + 1)}`));

// Restart resets more than the board. The view keeps a shake buffer, a pending deduction and a
// drag preview, and the frame clock (`last`) is what makes the next dt meaningful: leaving any
// of them behind means the new attempt inherits the old one's state, which is exactly what a
// player pressing "重开" expects to lose.
function restart() {
  resetGame(app.game);
  app.hints = 0;
  el.curtain.hidden = true;
  store.saveProgress(app.lot.id, '');
  setPaused(false);
  view.resetAnimation();
  audio.reset();
  view.redraw();
  render();
  say('回到起点');
}

// --- 静音 / 全屏 / 玩法说明 ---------------------------------------------------------
// 静音是 `ctx.suspend()`，不是把音量拧到看不见：js/audio.js 里那条断言（静音期间零个节点）
// 就是为了让"字符串里有 mute"和"电池真的没在振膜"变成同一件事。
function renderSound() {
  const muted = audio.isMuted();
  el.sound.setAttribute('aria-pressed', String(muted));
  el.sound.textContent = muted ? '静音' : '有声';
  el.sound.title = muted ? '取消静音（M）' : '静音（M）';
  return muted;
}

function toggleMute() {
  const muted = audio.toggle();
  renderSound();
  if (!muted) audio.play('mark'); // 刚解开的这一下是指纹按的，允许出声当作回执
  return muted;
}

el.sound.addEventListener('click', toggleMute);
el.pause.addEventListener('click', () => setPaused(!app.paused));
el.resume.addEventListener('click', () => setPaused(false));

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function renderFullscreen() {
  const on = isFullscreen();
  el.fullscreen.setAttribute('aria-pressed', String(on));
  el.fullscreen.textContent = on ? '退出全屏' : '全屏';
  el.fullscreen.title = on ? '退出全屏（F）' : '全屏（F）';
  return on;
}

// 全屏绑在真实的 #fullscreen 按钮上，F 只是它的别名：requestFullscreen 只肯在用户手势里生效，
// 脚本自己调用会被拒。所以这里只承诺"按下去就一定试一次"，试不成就把原因说清楚。
function toggleFullscreen() {
  const doc = document;
  if (isFullscreen()) {
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (!exit) return Promise.resolve(renderFullscreen());
    return Promise.resolve(exit.call(doc)).then(renderFullscreen, renderFullscreen);
  }
  const target = doc.documentElement;
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!request) {
    toast('这个浏览器没有开放全屏');
    return Promise.resolve(false);
  }
  return Promise.resolve(request.call(target)).then(renderFullscreen, () => {
    toast('全屏被拦下了：再点一次按钮（键盘的 F 也算一次手势）');
    return renderFullscreen();
  });
}

el.fullscreen.addEventListener('click', toggleFullscreen);
for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(type, renderFullscreen);
}

// 玩法说明是一块盖在盘上的布：它挡住了 canvas，所以手势自然进不来 —— 不需要再为它做一套
// "帮助模式"的判定分支。第一次在这台设备打开（存档里一条记录都没有）就自动摊开：规则没人
// 读的话，"不计入"看起来就像 bug。
function setHelp(on) {
  const next = !!on;
  el.howto.hidden = !next;
  el.help.setAttribute('aria-pressed', String(next));
  if (next) {
    if (typeof el.howtoClose.focus === 'function') el.howtoClose.focus();
  } else if (typeof el.canvas.focus === 'function') {
    el.canvas.focus({ preventScroll: true });
  }
  return next;
}

el.help.addEventListener('click', () => setHelp(el.howto.hidden));
el.howtoClose.addEventListener('click', () => setHelp(false));

function freshDevice() {
  return store.stats.solves === 0 && store.unlocked <= 1 && Object.keys(store.records).length === 0;
}

function closeOverlays() {
  if (!el.howto.hidden) { setHelp(false); return; }
  if (app.paused) { setPaused(false); return; }
  if (!el.curtain.hidden) el.curtain.hidden = true;
}

// Enter/空格：覆盖层在的时候是"开始/继续"，都不在的时候是暂停的别名（§2 把两件事都给了它）。
function startOrContinue() {
  if (!el.howto.hidden) { setHelp(false); return 'help-closed'; }
  if (app.paused) { setPaused(false); return 'resumed'; }
  if (!el.curtain.hidden) {
    el.curtain.hidden = true;
    if (!el.next.hidden) el.next.click();
    else el.again.click();
    return 'advanced';
  }
  setPaused(true);
  return 'paused';
}

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape') closeOverlays();
  else if (k === 'h' || k === '?') setHelp(el.howto.hidden);
  else if (k === 'enter' || k === ' ') { ev.preventDefault(); startOrContinue(); }
  else if (k === 'p') setPaused(!app.paused);
  else if (k === 'm') toggleMute();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'u') el.undo.click();
  else if (k === 'g') el.hint.click();
  else if (k === 'r') el.restart.click();
});

view.start();
renderSound();
renderFullscreen();
if (freshDevice()) setHelp(true);

// Wiping the save is the one destructive thing this game can do, so it asks twice instead of
// firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部记录');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

// Deliberately not paused on visibilitychange: a tab that reports itself hidden (headless
// Chrome does) must still be able to paint the chart an automated finger is about to draw on.
// 玩家的"暂停"只有一个入口：HUD 上的 #pause 按钮与 P/空格，见上面的 keydown。
apply();

// --- the test surface ---------------------------------------------------------------------
// `window.fleet` is what tools/playtest.mjs drives. It exposes the same commit() a finger
// reaches, the geometry an automated finger needs, and a probe that re-runs the printed numbers
// in this browser. Nothing here judges legality twice: every call goes through js/core.

window.fleet = {
  version: 1,
  get state() {
    const p = app.game ? progress(app.game) : null;
    return {
      mode: app.mode,
      label: app.label,
      id: app.lot && app.lot.id,
      tier: app.lot && app.lot.tier,
      band: app.lot && app.lot.band,
      index: app.index,
      n: app.lot && app.lot.n,
      hulls: p ? p.hulls : 0,
      marks: p ? p.marks : 0,
      errors: p ? p.errors : 0,
      over: p ? p.over : 0,
      done: !!(p && p.done),
      fleetLeft: p ? p.fleetLeft.slice() : [],
      hints: app.hints,
      depth: app.lot && app.lot.depth,
      guesses: app.lot && app.lot.guesses,
      solutionCount: app.lot && app.lot.solutionCount,
      unlocked: store.unlocked,
      solved: ALL.filter((l) => {
        const r = store.record(l.id);
        return r && r.solved;
      }).length,
      curtain: !el.curtain.hidden,
      persistent: store.persistent(),
      day: app.day,
      // 交互开关是行为，不是文案：浏览器侧要能直接读到"循环真的停了""上下文真的挂起了"。
      paused: app.paused,
      help: !el.howto.hidden,
      fullscreen: isFullscreen(),
      muted: audio.isMuted(),
      reducedMotion: view.anim().reducedMotion,
      loop: view.anim().raf,
    };
  },
  // The pool, as measurements only. `band` is the solver's stack depth, not a rating.
  get pool() {
    const byTier = {};
    for (const t of TIERS) {
      const rows = lotsIn(t.key);
      byTier[t.key] = {
        n: rows.length ? rows[0].n : 0,
        fleet: rows.length ? rows[0].fleet.join('/') : '',
        lots: rows.length,
        depthMin: Math.min(...rows.map((r) => r.depth)),
        depthMax: Math.max(...rows.map((r) => r.depth)),
        guessesMax: Math.max(...rows.map((r) => r.guesses)),
        unique: rows.filter((r) => r.solutionCount === 1).length,
        band: t.band,
      };
    }
    return { charts: CHARTS, byTier };
  },
  get bands() { return TIERS; },
  // Re-derive the printed numbers for the chart on screen, in this browser, from the puzzle
  // alone: the solver (limit 2, early stop) and the independent enumeration table. This is the
  // only place the browser is allowed to search, and a gesture never calls it.
  probe(opts = {}) {
    const puzzle = puzzleOf(app.lot);
    const t0 = performance.now();
    const s = solve(puzzle, { limit: 2 });
    const solverMs = performance.now() - t0;
    const t1 = performance.now();
    const e = opts.table === false ? null : countByTable(puzzle, { limit: 2, budget: 600000 });
    const tableMs = performance.now() - t1;
    return {
      id: app.lot.id,
      printed: { count: app.lot.solutionCount, depth: app.lot.depth, guesses: app.lot.guesses },
      solver: { count: s.count, depth: s.depth, guesses: s.guesses, nodes: s.nodes, truncated: s.truncated },
      table: e ? { count: e.count, route: e.route, truncated: e.truncated } : null,
      agrees: s.count === app.lot.solutionCount && s.depth === app.lot.depth
        && s.guesses === app.lot.guesses && (!e || e.count === app.lot.solutionCount),
      solverMs: Number(solverMs.toFixed(2)),
      tableMs: Number(tableMs.toFixed(2)),
    };
  },
  load(hash) { go(hash); return app.lot && app.lot.id; },
  lot() {
    if (!app.lot) return null;
    const l = app.lot;
    return {
      id: l.id, tier: l.tier, band: l.band, n: l.n, fleet: l.fleet.slice(),
      rows: l.rows.slice(), cols: l.cols.slice(), cells: l.cells.slice(),
      solutionCount: l.solutionCount, depth: l.depth, guesses: l.guesses, route: l.route,
    };
  },
  // The certified navy for the chart on screen, decomposed by the same `board.hullsOf` the
  // rules read: this is what @pointer drags, so the finger follows the bake rather than a
  // hand-typed route.
  plan() {
    const b = createBoard(app.lot.n);
    for (const c of app.lot.cells) set(b, c % app.lot.n, Math.floor(c / app.lot.n), SHIP);
    return hullsOf(b);
  },
  // Lay the whole printed navy through the gesture layer, then black in what is left.
  playAll() {
    let laid = 0;
    for (const h of this.plan()) if (commitDrag(h.x, h.y, h.len, h.axis)) laid++;
    let watered = 0;
    for (let y = 0; y < app.lot.n; y++) {
      for (let x = 0; x < app.lot.n; x++) if (cellStateAt(x, y) === UNKNOWN && commitWater(x, y)) watered++;
    }
    return { laid, watered, done: app.game.done };
  },
  board() { return dumpGame(app.game); },
  summary() { return summarize(boardOf(app.game)); },
  cells() { return Array.from(boardOf(app.game).cells); },
  hulls() { return app.game.hulls.map((h) => ({ ...h })); },
  status() { return statusOf(app.game); },
  parse(text) { return parseBoard(app.lot.n, text) ? serialize(parseBoard(app.lot.n, text)) : null; },
  // Where a square is on the screen, and the two ends of the drag that would lay a hull: what
  // an automated finger presses, as opposed to the maths in js/core.
  cellPoint(x, y) { return view.cellPoint(x, y); },
  linePoints(x, y, len, axis) { return view.linePoints(x, y, len, axis); },
  pointAt(clientX, clientY) { return view.pointAt(clientX, clientY); },
  geometry() { return view.geometry(); },
  states: { UNKNOWN, WATER, SHIP, MARK },
  // Programmatic gestures: the same functions the view calls, so an injected call proves the
  // commit path and nothing about where a finger can reach.
  drag: (x, y, len, axis) => commitDrag(x, y, len, axis),
  tap: (x, y) => commitTap(x, y),
  water: (x, y) => commitWater(x, y),
  query: (x, y) => commitQuery(x, y),
  undoOnce() { el.undo.click(); return app.game.hulls.length; },
  hintOnce() { return hintOnce(); },
  reset() { restart(); return app.game.hulls.length; },
  // 开关也走同一条路：测试点的是按钮背后的函数，不是按钮的文案。
  setPaused(on) { return setPaused(on === undefined ? !app.paused : on); },
  toggleMute() { return toggleMute(); },
  setHelp(on) { return setHelp(on === undefined ? el.howto.hidden : on); },
  toggleFullscreen() { return toggleFullscreen(); },
  anim() { return view.anim(); },
  sim() { return view.sim(); },
  sound() { return audio.state(); },
  pixels() { return view.pixelsHash(); },
  painted() { return view.painted(); },
  store,
};

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 减弱动效（prefers-reduced-motion）----
//
// 跟住系统设置，而且**运行中改设置要立刻生效**：只读一次 matchMedia 不够，玩家在系统里
// 把开关拨回来，页面还停在上一次读到的答案上。addEventListener 是标准接口，老 Safari 只有
// addListener —— 特性探测，不做 UA 判断。
const motionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReduceMotion(on) { view.setReduceMotion(on); }
if (motionQuery) {
  applyReduceMotion(motionQuery.matches);
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (e) => applyReduceMotion(e.matches));
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener((e) => applyReduceMotion(e.matches));
  }
}
window.fleet.setReduceMotion = applyReduceMotion;
window.fleet.isReducedMotion = () => view.isReducedMotion();
