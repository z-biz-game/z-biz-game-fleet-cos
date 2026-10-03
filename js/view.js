// Canvas renderer + pointer handling. This file owns pixels and gestures and decides nothing:
// js/core/game.js is the only place a hull may or may not be laid, and js/core/rules.js is the
// only place a clue is judged. The view *asks* for a move and reads the clue tally back from
// those same pure functions purely for styling — there is exactly one implementation of each
// rule in this repo, never a second copy in here.
//
// Everything drawn is generated: the chart, the clue strip, the hull plates, the water. No
// image files, no fonts, no sprites. What the picture has to get right is the reading of a
// Battleship Solitaire puzzle: the numbers live *outside* the grid, the navy is a set of
// straight plates that never touch (corners included), and a line that has run over its number
// must not look satisfied. Getting that visible is gameplay, not decoration.
//
// Gestures (all of them reported to `main.js`, none of them judged here):
//   * drag from a cell along a row or column -> lay a hull of the dragged length
//   * tap an empty cell -> the shortest hull still in the dock (how a submarine gets drawn)
//   * tap a cell that carries a hull -> lift that hull
//   * right click / long press -> cycle the pencil '?'
//   * shift + click -> water, where the rules allow it

import { SHIP, WATER, MARK, hullCells } from './core/board.js';
import { boardOf } from './core/game.js';
import { clueStatus } from './core/rules.js';

const PAD = 18;
const GUT = 0.92; // clue gutter, in cells
const LONG_PRESS = 450; // ms a held finger waits before it becomes a pencil mark
const MOVE_SLOP = 6; // px of jitter that still counts as a tap

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function createView(canvas, handlers = {}) {
  // `willReadFrequently` because tools/playtest.mjs reads the bitmap back to prove that a legal
  // drag changes the picture and a refused one does not; without it Chrome logs a warning on
  // every readback, which would drown the console-clean check.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const on = handlers;
  let game = null;
  let geom = { cell: 32, x0: 40, y0: 40, gut: 30, w: 320, h: 320 };
  let drag = null; // { x, y, len, axis, moved }
  let press = null; // { x, y, sx, sy, id, timer, fired }
  const shake = new Map(); // 'r1' | 'c3' | 'x,y' -> 0..1, decays after a refusal
  let hint = null; // { cells, until } — what the clue strip alone already proves
  let raf = 0;
  let last = 0;
  let warm = 0; // the first frames always repaint, so the canvas is never blank

  // ---- 减弱动效（prefers-reduced-motion）----
  // 两处装饰：① 提示圈 t = ((now % 1200) / 1200 + 1) % 1 喂给线宽与透明度；② 被拒的
  // 那条线索 jx = Math.sin(s * 30) * s * cell * 0.18 —— 数字左右抖。
  // 判据：被拒的格子同时被画成红色（上面那段 fillRect rgba(226,86,77,·)，随 s 衰减），
  // 红色是"刚才这几格填错了"的画面证据；抖动只是叠在上面的装饰。所以只停 jx，
  // **红色高亮与提示圈本体一律留着**。与 hashi / nine-rings / slide15 同口径。
  let reduceMotion = false;
  const hintPhase = () => (reduceMotion ? 0.5 : ((performance.now() % 1200) / 1200 + 1) % 1);

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(200, Math.round(box.width));
    const H = Math.max(200, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!game) return;
    const n = game.n;
    // The board plus one clue gutter on the top and the left has to fit in both directions.
    const cell = Math.floor(Math.min((W - PAD * 2) / (n + GUT + 0.3), (H - PAD * 2) / (n + GUT + 0.3)));
    const size = Math.max(18, cell);
    const gut = Math.round(size * GUT);
    const span = gut + size * n;
    geom = {
      cell: size,
      gut,
      x0: Math.round((W - span) / 2) + gut,
      y0: Math.round((H - span) / 2) + gut,
      w: W,
      h: H,
    };
    draw();
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  // Canvas-local -> client pixels: the mapping the hit test reads, run backwards, so an
  // automated finger presses where a square actually is.
  function toClient(ux, uy) {
    const box = canvas.getBoundingClientRect();
    return { x: Math.round(box.left + ux), y: Math.round(box.top + uy) };
  }

  function cellCentre(x, y) {
    const { cell, x0, y0 } = geom;
    return { x: x0 + (x + 0.5) * cell, y: y0 + (y + 0.5) * cell };
  }

  function pointAt(clientX, clientY) {
    const { cell, x0, y0 } = geom;
    const n = game ? game.n : 0;
    const lx = clientX - x0;
    const ly = clientY - y0;
    if (!n || lx < 0 || ly < 0) return null;
    const x = Math.floor(lx / cell);
    const y = Math.floor(ly / cell);
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    return { x, y };
  }

  function fromEvent(ev) {
    const p = localPoint(ev);
    return pointAt(p.x, p.y);
  }

  // The hull a drag from (ax, ay) to (bx, by) describes: the dominant axis decides the
  // orientation, and a drag that never left its square has no length yet (that is a tap).
  function dragShape(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    if (!dx && !dy) return null;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: dx < 0 ? bx : ax, y: ay, len: Math.abs(dx) + 1, axis: 'h' };
    }
    return { x: ax, y: dy < 0 ? by : ay, len: Math.abs(dy) + 1, axis: 'v' };
  }

  function kick(key) {
    shake.set(key, 1);
    if (!raf) start();
  }

  function down(ev) {
    if (!game || game.done || ev.button === 2) return;
    const c = fromEvent(ev);
    if (!c) return; // the gutter and the margins are not squares, and cost nothing
    ev.preventDefault();
    const p = localPoint(ev);
    if (ev.shiftKey) {
      if (on.onWater) on.onWater(c.x, c.y);
      draw();
      return;
    }
    press = { x: c.x, y: c.y, sx: p.x, sy: p.y, id: ev.pointerId, fired: false };
    drag = null;
    // Without the capture the canvas only ever sees a pointerup that lands inside it. A finger
    // that drags off the chart and releases there leaves `press` armed, and 450 ms later the
    // long-press timer paints a pencil mark on a square nobody was aiming at — the gesture is
    // not lost, it is *misfiled*. Capture means the release always comes home to `up()`.
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(ev.pointerId); } catch { /* old pointer ids */ } }
    press.timer = setTimeout(() => {
      if (!press) return;
      press.fired = true;
      if (on.onQuery) on.onQuery(press.x, press.y);
      draw();
    }, LONG_PRESS);
  }

  function move(ev) {
    if (!press || !game) return;
    const p = localPoint(ev);
    if (!press.fired && Math.hypot(p.x - press.sx, p.y - press.sy) < MOVE_SLOP) return;
    const c = pointAt(p.x, p.y);
    if (!c) return;
    if (c.x === press.x && c.y === press.y) return;
    if (!press.fired) {
      clearTimeout(press.timer);
      press.fired = true; // the finger left the square: it is drawing a hull, not marking a note
    }
    const shape = dragShape(press.x, press.y, c.x, c.y);
    if (!shape) return;
    if (!drag || drag.x !== shape.x || drag.y !== shape.y || drag.len !== shape.len || drag.axis !== shape.axis) draw();
    drag = shape;
  }

  function up(ev) {
    if (!press) return;
    clearTimeout(press.timer);
    const c = fromEvent(ev) || { x: press.x, y: press.y };
    const shape = drag && drag.len > 1 ? drag : null;
    const wasTap = !press.fired && (!shape || shape.len <= 1) && c.x === press.x && c.y === press.y;
    press = null;
    drag = null;
    if (shape && on.onDrag) {
      on.onDrag(shape.x, shape.y, shape.len, shape.axis);
    } else if (wasTap && on.onTap) {
      on.onTap(c.x, c.y);
    }
    draw();
  }

  function menu(ev) {
    ev.preventDefault();
    if (!game || game.done) return;
    const c = fromEvent(ev);
    if (c && on.onQuery) on.onQuery(c.x, c.y);
  }

  function status() {
    return game ? clueStatus(game.puzzle, boardOf(game)) : null;
  }

  // --- drawing ---------------------------------------------------------------------------

  function plate(x, y, len, axis, alpha, colour) {
    const { cell } = geom;
    const c0 = cellCentre(x, y);
    const pad = Math.max(3, cell * 0.13);
    const w = axis === 'h' ? cell * len - pad * 2 : cell - pad * 2;
    const h = axis === 'v' ? cell * len - pad * 2 : cell - pad * 2;
    const left = c0.x - cell / 2 + pad;
    const top = c0.y - cell / 2 + pad;
    const r = Math.min(w, h) * 0.45;
    ctx.save();
    ctx.globalAlpha = alpha;
    const grad = ctx.createLinearGradient(0, top, 0, top + h);
    grad.addColorStop(0, colour[0]);
    grad.addColorStop(0.45, colour[1]);
    grad.addColorStop(1, colour[2]);
    ctx.fillStyle = grad;
    roundRect(ctx, left, top, w, h, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10, 14, 20, 0.55)';
    ctx.lineWidth = Math.max(1, cell * 0.04);
    roundRect(ctx, left, top, w, h, r);
    ctx.stroke();
    // Portholes, one per square, so a 4-plate reads as four squares and not as a bar.
    ctx.fillStyle = 'rgba(12, 18, 26, 0.55)';
    for (let k = 0; k < len; k++) {
      const cc = cellCentre(axis === 'h' ? x + k : x, axis === 'v' ? y + k : y);
      ctx.beginPath();
      ctx.arc(cc.x, cc.y, Math.max(1.5, cell * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawClues(st) {
    const { cell, gut, x0, y0, w, h } = geom;
    const n = game.n;
    const size = Math.max(11, Math.min(gut * 0.62, cell * 0.62));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${size}px "SF Mono", Menlo, Consolas, monospace`;
    const put = (txt, cx, cy, cls, key) => {
      const s = shake.get(key) || 0;
      const jx = s > 0 && !reduceMotion ? Math.sin(s * 30) * s * cell * 0.18 : 0;
      ctx.fillStyle = cls === 'over' ? '#e2564d' : cls === 'full' ? '#d8a13c' : '#77839a';
      ctx.fillText(txt, cx + jx, cy);
    };
    for (let i = 0; i < n; i++) {
      const r = st.rows[i];
      const c = st.cols[i];
      // Column clues above the chart, row clues to its left: the reading a player brings to
      // Battleship Solitaire, and the one `rules.clueStatus` is written against.
      put(String(c.clue), x0 + (i + 0.5) * cell, y0 - gut * 0.33, c.over ? 'over' : c.full ? 'full' : 'open', `c${i}`);
      put(String(r.clue), x0 - gut * 0.33, y0 + (i + 0.5) * cell, r.over ? 'over' : r.full ? 'full' : 'open', `r${i}`);
    }
    // File and rank letters, so a shared position can be talked about ("B4").
    ctx.font = `400 ${Math.max(9, size * 0.62)}px "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(119, 131, 154, 0.5)';
    for (let i = 0; i < n; i++) {
      ctx.fillText(String.fromCharCode(65 + i), x0 + (i + 0.5) * cell, y0 - gut * 0.78);
      ctx.fillText(String(i + 1), x0 - gut * 0.78, y0 + (i + 0.5) * cell);
    }
    ctx.restore();
  }

  function drawGrid() {
    const { cell, x0, y0 } = geom;
    const n = game.n;
    ctx.save();
    ctx.strokeStyle = 'rgba(160, 190, 220, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath();
      ctx.moveTo(x0 + i * cell, y0);
      ctx.lineTo(x0 + i * cell, y0 + n * cell);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0, y0 + i * cell);
      ctx.lineTo(x0 + n * cell, y0 + i * cell);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawNotes() {
    const { cell, x0, y0 } = geom;
    const n = game.n;
    const board = boardOf(game);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = board.cells[y * n + x];
        const c = cellCentre(x, y);
        if (v === WATER) {
          ctx.fillStyle = 'rgba(120, 170, 220, 0.13)';
          ctx.beginPath();
          ctx.arc(c.x, c.y, Math.max(2, cell * 0.09), 0, Math.PI * 2);
          ctx.fill();
        } else if (v === MARK) {
          ctx.fillStyle = 'rgba(200, 214, 235, 0.5)';
          ctx.font = `500 ${cell * 0.5}px "SF Mono", Menlo, monospace`;
          ctx.fillText('?', c.x, c.y + cell * 0.02);
        } else if (v === SHIP) {
          // nothing: the plates are drawn as one capsule per hull below
        } else {
          const s = shake.get(`${x},${y}`) || 0;
          if (s > 0) {
            ctx.fillStyle = `rgba(226, 86, 77, ${(s * 0.5).toFixed(3)})`;
            ctx.fillRect(x0 + x * cell + 1, y0 + y * cell + 1, cell - 2, cell - 2);
          }
        }
      }
    }
    ctx.restore();
  }

  function drawHulls() {
    for (const h of game.hulls) {
      const cells = hullCells(h);
      if (!cells.length) continue;
      plate(h.x, h.y, h.len, h.axis, 1, ['#c9d6e5', '#8fa1b6', '#5c6b7d']);
    }
  }

  function drawDrag() {
    if (!drag) return;
    plate(drag.x, drag.y, drag.len, drag.axis, 0.42, ['#9fe8c8', '#5fbf95', '#2f7a5c']);
    const { cell } = geom;
    const end = cellCentre(drag.axis === 'h' ? drag.x + drag.len - 1 : drag.x, drag.axis === 'v' ? drag.y + drag.len - 1 : drag.y);
    ctx.save();
    ctx.fillStyle = '#0f1319';
    ctx.strokeStyle = '#5fbf95';
    ctx.lineWidth = 1.5;
    const r = Math.max(9, cell * 0.28);
    ctx.beginPath();
    ctx.arc(end.x, end.y - cell * 0.5, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#9fe8c8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${r}px "SF Mono", Menlo, monospace`;
    ctx.fillText(String(drag.len), end.x, end.y - cell * 0.5);
    ctx.restore();
  }

  function drawHint(now) {
    if (!hint) return;
    const { cell } = geom;
    const t = hintPhase();
    ctx.save();
    ctx.lineWidth = Math.max(2, cell * 0.07);
    ctx.strokeStyle = `rgba(120, 220, 255, ${(0.85 - t * 0.55).toFixed(3)})`;
    for (const c of hint.cells) {
      const cc = cellCentre(c % game.n, Math.floor(c / game.n));
      roundRect(ctx, cc.x - cell / 2 + 2, cc.y - cell / 2 + 2, cell - 4, cell - 4, cell * 0.18);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw(now = 0) {
    const { cell, w, h } = geom;
    ctx.clearRect(0, 0, w, h);
    if (!game) return;
    const st = status();

    ctx.fillStyle = '#151b24';
    roundRect(ctx, 10, 10, w - 20, h - 20, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.09)';
    ctx.lineWidth = 1;
    roundRect(ctx, 10, 10, w - 20, h - 20, 14);
    ctx.stroke();
    void cell;

    drawGrid();
    drawNotes();
    drawHulls();
    drawDrag();
    drawClues(st);
    drawHint(now);
  }

  function step(dt) {
    let busy = false;
    for (const [k, v] of shake) {
      const next = v - dt * 2.4;
      if (next > 0.002) {
        shake.set(k, next);
        busy = true;
      } else if (v !== 0) {
        // Snap *and* repaint, so the last frame of a shake is exactly the settled picture
        // rather than one that is 0.001 off. That is what makes "the refused drag left nothing
        // behind" a checkable statement (tools/playtest.mjs @pointer compares pixel
        // fingerprints across a refusal).
        shake.delete(k);
        busy = true;
      }
    }
    if (hint && performance.now() > hint.until) {
      hint = null;
      busy = true;
    }
    return busy;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.064, (now - (last || now)) / 1000);
    last = now;
    const busy = step(dt);
    if (busy || hint || warm < 4) {
      warm++;
      draw(now);
    }
  }

  function start() {
    if (!raf) {
      last = 0;
      warm = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => {
    if (press) clearTimeout(press.timer);
    press = null;
    drag = null;
    draw();
  });
  canvas.addEventListener('contextmenu', menu);

  // The canvas's box is decided by CSS, and a `window` resize event is not enough to follow it:
  // a phone rotating, the panel's text reflowing or a devtools split all change the box without
  // changing the window. Since the hit test maps client pixels through the geometry measured
  // from that box, measuring late means drawing a hull on the wrong square — so watch the box.
  // (Guarded: this file is also loaded by `node --check`.)
  if (typeof ResizeObserver === 'function') {
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; } // the initial callback is the layout we already measured
      measure();
    });
    ro.observe(canvas);
  }

  return {
    // The gate the runtime pref flip lands on: idempotent, repaints so a clue stops mid-jitter
    // on the frame the setting changes rather than at the end of the decay.
    setReduceMotion(v) {
      const on = !!v;
      if (on === reduceMotion) return reduceMotion;
      reduceMotion = on;
      if (reduceMotion) draw(performance.now());
      return reduceMotion;
    },
    isReducedMotion: () => reduceMotion,
    attach(next) {
      game = next;
      hint = null;
      drag = null;
      shake.clear();
      measure();
    },
    detach() {
      game = null;
    },
    // Client-space centre of a square, and the two ends of the drag that would lay a hull:
    // what an automated finger needs, as opposed to the maths in js/core.
    cellPoint(x, y) {
      if (!game || x < 0 || y < 0 || x >= game.n || y >= game.n) return null;
      const c = cellCentre(x, y);
      const board = boardOf(game);
      return {
        ...toClient(c.x, c.y),
        local: { x: c.x, y: c.y },
        cell: [x, y],
        size: geom.cell,
        state: board.cells[y * game.n + x],
      };
    },
    linePoints(x, y, len, axis) {
      if (!game || len < 1) return null;
      const ex = axis === 'h' ? x + len - 1 : x;
      const ey = axis === 'v' ? y + len - 1 : y;
      if (ex < 0 || ey < 0 || ex >= game.n || ey >= game.n) return null;
      const a = cellCentre(x, y);
      const b = cellCentre(ex, ey);
      return { from: { ...toClient(a.x, a.y), cell: [x, y] }, to: { ...toClient(b.x, b.y), cell: [ex, ey] }, len, axis };
    },
    // Client pixels -> board square, or null for the gutter and the margins. The centre is
    // computed here rather than by calling `cellPoint` above: the returned object's methods are
    // not in this module's lexical scope, and `cellPoint(...)` here would be a ReferenceError
    // the first time a test asked for a round trip.
    //
    // Client coordinates have to be put through the canvas's own box first: the internal
    // `pointAt` works in canvas-local space (like `cellCentre`), so passing a `clientX` straight
    // down into it asked the chart where (313, 483) was *relative to the chart's origin* and
    // answered two squares low and one to the right.
    pointAt(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      const c = pointAt(clientX - box.left, clientY - box.top);
      if (!c) return null;
      const centre = cellCentre(c.x, c.y);
      return { ...c, ...toClient(centre.x, centre.y), cell: [c.x, c.y], size: geom.cell };
    },
    // The squares a refusal is about, so the shake can be aimed at them.
    kickHull(hull) {
      if (!hull) return;
      for (const [x, y] of hullCells(hull)) kick(`${x},${y}`);
    },
    kickLine(kind, i) {
      kick(`${kind}${i}`);
    },
    // What the clue strip already proves, painted without any assumption.
    showDeduction(cells) {
      hint = { cells: cells || [], until: performance.now() + 3200 };
      start();
      draw(performance.now());
    },
    clearDeduction() {
      hint = null;
    },
    measure,
    redraw: draw,
    pixelsHash() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      // Stride 97 (about 390 bytes) is dense enough that a 4x4 chart's 16 outline squares all
      // land in the sample, which is what makes "this gesture changed the picture" a statement
      // about pixels rather than about luck. It costs a few thousand adds, not a repaint.
      for (let i = 0; i + 2 < d.length; i += 4 * 97) sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 2147483647;
      return sum;
    },
    painted() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    },
    geometry() {
      return { ...geom, n: game ? game.n : 0 };
    },
    start,
    stop,
  };
}
