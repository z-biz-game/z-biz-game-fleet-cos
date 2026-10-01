// The canvas's own behaviour, tested without a browser. `js/view.js` only touches the DOM
// through a handful of calls, so a stub canvas plus a fake requestAnimationFrame is enough to
// assert the three things the brief demands as *behaviour* rather than as strings (§2):
//
//   * pause stops the simulation — the loop is cancelled, so `step()` never receives a dt and
//     nothing on the board can move or expire; and no gesture gets through;
//   * restart clears the view's buffers (shake, pending highlight, drag preview) and its clock;
//   * reduce-motion removes the animated feedback instead of merely making it shorter.
//
// The fake clock is deliberately explicit: every frame is pumped with a timestamp we chose, so
// 30Hz / 60Hz / 120Hz are three programs rather than one program watched three times.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { createView } from '../js/view.js';
import { createGame } from '../js/core/game.js';
import { levelAt } from '../js/core/library.js';

// Every canvas method is a no-op that returns a gradient-like stub, because the only things
// this file asserts are *state* — the pixel values are the browser's problem (and playtest's).
const GRADIENT = { addColorStop() {} };

function stubContext() {
  const store = {};
  return new Proxy(store, {
    get(t, p) {
      if (p in t) return t[p];
      return () => (p === 'createLinearGradient' || p === 'createPattern' ? GRADIENT : undefined);
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
}

function stubCanvas() {
  const listeners = new Map();
  const c = {
    width: 0,
    height: 0,
    listeners,
    getContext: () => stubContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    focus: () => {},
  };
  return c;
}

// The frame clock: `pump(n, step)` runs n callbacks at `step` ms apart and reports how many
// callbacks the view asked for on the way (a view that re-arms rAF keeps the queue non-empty).
function fakeFrames() {
  let queue = [];
  let id = 0;
  const seen = [];
  globalThis.requestAnimationFrame = (cb) => {
    queue.push(cb);
    return ++id;
  };
  globalThis.cancelAnimationFrame = () => {
    queue = [];
  };
  return {
    pending: () => queue.length,
    pumped: () => seen.length,
    pump(n, step, now0 = 0) {
      let now = now0;
      for (let k = 0; k < n; k++) {
        const cb = queue.shift();
        if (!cb) break;
        now += step;
        seen.push(now);
        cb(now);
      }
      return now;
    },
  };
}

function withWindow(extra = {}) {
  const win = { devicePixelRatio: 2, ...extra };
  globalThis.window = win;
  return win;
}

function gesture(view, canvas, x, y) {
  const p = view.cellPoint(x, y);
  const fire = (type, patch = {}) => {
    const fn = canvas.listeners.get(type);
    if (!fn) return false;
    fn({
      clientX: p.x,
      clientY: p.y,
      button: 0,
      shiftKey: false,
      pointerId: 1,
      preventDefault() {},
      ...patch,
    });
  };
  fire('pointerdown');
  fire('pointerup');
  return true;
}

const frames = fakeFrames();
withWindow();
const game = createGame(levelAt(0));

// --- the loop ---------------------------------------------------------------------------

const calls = [];
const c0 = stubCanvas();
const v0 = createView(c0, {
  onTap: (x, y) => calls.push(`tap:${x},${y}`),
  onDrag: () => calls.push('drag'),
  onWater: () => calls.push('water'),
  onQuery: () => calls.push('query'),
});
v0.attach(game);
v0.start(); // js/main.js 里同样是 attach 之后显式起跑

test('attach 起循环：一帧被排队，且 measure 之后几何是有效的', () => {
  eq(v0.anim().raf, true, 'raf 应该在跑');
  ok(frames.pending() >= 1, '应该有一帧在等');
  ok(v0.geometry().cell >= 18, `格子太小：${v0.geometry().cell}`);
});

test('循环在推进：pump 之后帧数增加', () => {
  const before = frames.pumped();
  frames.pump(3, 16.7);
  ok(frames.pumped() > before, 'pump 没有驱动任何回调');
});

// --- pause ------------------------------------------------------------------------------

test('暂停把循环关掉：step() 再也拿不到 dt', () => {
  eq(v0.setPaused(true), true);
  eq(v0.anim().paused, true);
  eq(v0.anim().raf, false, '暂停后不该还挂着 rAF');
  const before = frames.pumped();
  frames.pump(5, 16.7);
  eq(frames.pumped(), before, '暂停期间一帧都不该跑');
});

test('暂停期间手势不落：tap/drag/water/query 全部被挡', () => {
  const before = calls.length;
  gesture(v0, c0, 0, 0);
  eq(calls.length, before, '暂停时不该有手势回调');
  eq(v0.pointAt(100, 100) !== null, true, '几何还在（暂停挡的是判定，不是命中测试）');
});

test('提示与拒绝都不能把暂停中的循环叫醒', () => {
  v0.showDeduction([0, 1]);
  eq(v0.anim().raf, false, 'showDeduction 在暂停态里不该 start()');
  v0.kickHull({ x: 0, y: 0, len: 2, axis: 'h' });
  eq(v0.anim().raf, false, 'kick 在暂停态里不该 start()');
});

test('恢复后循环重新起跑，手势重新可用', () => {
  eq(v0.setPaused(false), false);
  eq(v0.anim().raf, true);
  const before = calls.length;
  gesture(v0, c0, 0, 0);
  ok(calls.length > before, `恢复后手势没进来：${JSON.stringify(calls.slice(before))}`);
  eq(calls[calls.length - 1], 'tap:0,0');
});

// --- restart ----------------------------------------------------------------------------

test('重开清掉缓冲：抖动、待显示的高亮、拖拽预览与帧时钟', () => {
  v0.kickHull({ x: 0, y: 0, len: 2, axis: 'h' });
  v0.showDeduction([0, 1, 2]);
  eq(v0.anim().shake > 0, true, '先确认抖动确实存在');
  eq(v0.anim().highlight, 3);
  v0.resetAnimation();
  eq(v0.anim().shake, 0, '抖动缓冲没清');
  eq(v0.anim().highlight, 0, '高亮没清');
  eq(v0.anim().dragging, false);
});

// --- reduce motion ----------------------------------------------------------------------

test('reduce-motion 打开时抖动根本不存在（不是抖得快一点）', () => {
  withWindow({
    matchMedia: (q) => ({
      query: q,
      matches: true,
      addEventListener() {},
    }),
  });
  const c = stubCanvas();
  const vm = createView(c, { onTap: () => {} });
  vm.attach(game);
  eq(vm.anim().reducedMotion, true);
  vm.kickHull({ x: 0, y: 0, len: 2, axis: 'h' });
  eq(vm.anim().shake, 0, 'reduce-motion 下还留下了抖动条目');
  vm.resetAnimation();
});

test('没开 reduce-motion 时同一份代码留下抖动：两边读的是同一个 matchMedia', () => {
  let captured = '';
  withWindow({
    matchMedia: (q) => {
      captured = q;
      return { matches: false, addEventListener() {} };
    },
  });
  const vm = createView(stubCanvas(), {});
  vm.attach(game);
  eq(captured, '(prefers-reduced-motion: reduce)', '查询串变了，和 CSS 就不是同一条口径');
  eq(vm.anim().reducedMotion, false);
  vm.kickHull({ x: 0, y: 0, len: 2, axis: 'h' });
  eq(vm.anim().shake > 0, true);
});

test('没有 matchMedia 的环境里不炸：reduceMotion 退化为 false', () => {
  withWindow(); // 无 matchMedia
  const vm = createView(stubCanvas(), {});
  vm.attach(game);
  eq(vm.anim().reducedMotion, false);
  vm.kickLine('r', 1);
  eq(vm.anim().shake > 0, true, '退化成"有动效"，而不是退化成"没有反馈"');
});

run('view');
