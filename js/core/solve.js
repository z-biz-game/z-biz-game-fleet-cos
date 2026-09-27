// The solver, and with it the only difficulty numbers this game prints.
//
// Shape: reason until the chart stops moving, then assume and fall back.
//
//   * `propagate` derives cells from the clues and from the geometry of hulls. Everything it
//     writes down is *sound* — it never deletes a real solution — which is the whole
//     requirement for `count` to be a fact rather than an estimate.
//   * When reasoning runs dry the search picks the square with the fewest things it could
//     still be and branches over those things: "this square belongs to a hull of length L,
//     exactly here" for each candidate, plus "this square is water". Those cases partition
//     every remaining solution — a square is water, or it belongs to exactly one hull, and
//     that hull is exactly one of the candidates — so traversing all of them counts solutions,
//     and stopping at the second one is enough to say "not unique".
//   * The unit of assumption is a *hull*, not a square. Assuming one square at a time made
//     every chart look like it needed a dozen assumptions and flattened the difference between
//     a chart the clues close on their own and one that genuinely needs searching; the first
//     version of this file reported depth 6..13 for every 4x4 chart in existence, which is a
//     number about the search, not about the puzzle.
//
// Two numbers ship with each lot: `depth` is how deep the assumption stack ever went,
// `guesses` how many times reasoning ran dry. A lot the propagation closes on its own reports
// depth 0 — and if 0 were all this function ever returned, no test could tell it apart from a
// constant, which is why test/solve.test.mjs pins a hand-derived 0, a hand-derived 1 and a
// hand-derived >=2 on three different charts.
//
// The leaf test is `rules.isSolved`, written without reference to this file and shared with
// the shell's own completion check: the search does not grade its own homework, and
// js/core/enumerate.js agreeing with it chart by chart is what the shipped pool is certified
// against.
//
// No DOM, no window, no clock: the same puzzle always answers the same.

import { UNKNOWN, WATER, SHIP, hullsOf } from './board.js';
import { sanePuzzle, isSolved } from './rules.js';

const CONFLICT = 1;
const STEADY = 0;
const NO = 0; // segment verdicts
const EXTENDS = 1; // possible, but it merges into a known run: not itself a whole hull
const EXACT = 2; // possible as a whole hull, ends included

// Every straight segment of a fleet length that fits on the board, plus the reverse index
// "cell -> segments through it". Pure geometry over (n, fleet): the clues are not consulted
// here, and neither are they in js/core/enumerate.js — which is why the two routes disagree
// the moment either one has a bug.
export function segmentsOf(n, fleet) {
  const lengths = Array.from(new Set(fleet)).sort((a, b) => a - b);
  const all = [];
  for (const len of lengths) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x + len <= n; x++) all.push({ axis: 'h', x, y, len, cells: span(n, x, y, len, 'h') });
    }
    if (len === 1) continue; // a one-cell hull has no orientation; the diagonal rule still bites it
    for (let x = 0; x < n; x++) {
      for (let y = 0; y + len <= n; y++) all.push({ axis: 'v', x, y, len, cells: span(n, x, y, len, 'v') });
    }
  }
  const byCell = [];
  for (let i = 0; i < n * n; i++) byCell.push([]);
  all.forEach((s, id) => {
    for (const c of s.cells) byCell[c].push(id);
  });
  return { all, byCell, lengths, maxL: lengths[lengths.length - 1] };
}

function span(n, x, y, len, axis) {
  const out = new Uint8Array(len);
  for (let k = 0; k < len; k++) out[k] = axis === 'h' ? y * n + x + k : (y + k) * n + x;
  return out;
}

function makeState(puzzle, segs, limit) {
  const n = puzzle.n;
  return {
    n,
    fleet: puzzle.fleet.slice(),
    rows: puzzle.rows,
    cols: puzzle.cols,
    grid: new Uint8Array(n * n),
    cand: new Int32Array(n * n),
    branches: new Int32Array(n * n),
    segs,
    limit,
    count: 0,
    solutions: [],
    truncated: false,
    stats: { depth: 0, guesses: 0, nodes: 0, clue: 0, segment: 0 },
  };
}

// Where could a hull lie along this segment, given what is already settled?
//
// The run is absorbed first: known hull cells contiguous with the segment along its axis are
// the same ship, so the ship under discussion is the whole run, and that run has to be able to
// grow to one of the fleet's lengths. Then the flanking rows (or columns) must be clear of
// other hulls — that one loop is where the diagonal rule lives, and it is also what turns an
// over-long run and a bent drawing into a contradiction without a separate pass for either.
//
// NO / EXTENDS / EXACT. EXACT means the segment by itself is a whole hull: nothing already
// known extends it, so the two squares beyond its ends are water — which is what makes it
// usable as an assumption.
function segmentVerdict(st, seg) {
  const { grid, n, segs } = st;
  const isH = seg.axis === 'h';
  const fixed = isH ? seg.y : seg.x;
  let a = isH ? seg.x : seg.y;
  let b = a + seg.len - 1;
  const at = (k) => (isH ? grid[fixed * n + k] : grid[k * n + fixed]);

  for (let k = a; k <= b; k++) if (at(k) === WATER) return NO;
  const selfA = a;
  const selfB = b;
  while (a - 1 >= 0 && at(a - 1) === SHIP) a--;
  while (b + 1 < n && at(b + 1) === SHIP) b++;
  const runLen = b - a + 1;
  if (runLen > segs.maxL) return NO;

  for (let k = a - 1; k <= b + 1; k++) {
    if (k < 0 || k >= n) continue;
    for (const off of [-1, 1]) {
      const lane = fixed + off;
      if (lane < 0 || lane >= n) continue;
      if (isH ? grid[lane * n + k] === SHIP : grid[k * n + lane] === SHIP) return NO;
    }
  }

  let slack = 0;
  for (let k = a - 1; k >= 0 && at(k) === UNKNOWN; k--) slack++;
  for (let k = b + 1; k < n && at(k) === UNKNOWN; k++) slack++;
  let ok = false;
  for (const L of segs.lengths) {
    if (L >= runLen && L <= runLen + slack) { ok = true; break; }
  }
  if (!ok) return NO;
  return runLen === seg.len && selfA === a && selfB === b ? EXACT : EXTENDS;
}

// The water that has to appear around a hull the moment it is committed: every square in the
// eight-neighbourhood of the segment, axial ends included. Sound because it is the diagonal
// rule read from the other side — no second hull may touch this one anywhere — and necessary:
// blacking in only the two axial ends lets a later branch grow a *different* hull out of the
// same committed cell, and the identical chart then arrives down two paths and is counted
// twice. That is how this file shipped a `count: 2` on a unique chart for one round of
// development; the chart-by-chart reconciliation in test/enumerate.test.mjs is what catches it.
function segmentMargins(st, seg) {
  const { n, grid } = st;
  const own = new Set(seg.cells);
  const out = [];
  for (const c of seg.cells) {
    const x = c % n;
    const y = (c - x) / n;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const i = ny * n + nx;
        if (own.has(i) || grid[i] !== UNKNOWN) continue;
        if (!out.includes(i)) out.push(i);
      }
    }
  }
  return out;
}

// Returns null on contradiction, 0 when the line gives nothing away, else how many squares it
// just blacked in.
function lineStatus(st, axis, i) {
  const { grid, n } = st;
  const clue = axis === 'rows' ? st.rows[i] : st.cols[i];
  let ship = 0;
  const unknowns = [];
  for (let k = 0; k < n; k++) {
    const cell = axis === 'rows' ? grid[i * n + k] : grid[k * n + i];
    if (cell === SHIP) ship++;
    else if (cell === UNKNOWN) unknowns.push(k);
  }
  if (ship > clue || ship + unknowns.length < clue) return null;
  if (ship !== clue) return 0;
  for (const k of unknowns) {
    if (axis === 'rows') grid[i * n + k] = WATER;
    else grid[k * n + i] = WATER;
  }
  return unknowns.length;
}

// `cand` is this round's "some legal hull could still cross here", so `open` is a superset of
// the squares that can really be hull: the equality below can only fire when every one of them
// is needed, which is what makes forcing them sound.
function openLineForce(st, axis, i) {
  const { grid, n, cand } = st;
  const clue = axis === 'rows' ? st.rows[i] : st.cols[i];
  let ship = 0;
  const open = [];
  for (let k = 0; k < n; k++) {
    const j = axis === 'rows' ? i * n + k : k * n + i;
    if (grid[j] === SHIP) ship++;
    else if (grid[j] === UNKNOWN && cand[j] > 0) open.push(j);
  }
  if (ship > clue || ship + open.length < clue) return null;
  if (open.length !== clue - ship || !open.length) return 0;
  for (const j of open) grid[j] = SHIP;
  return open.length;
}

function keepCommon(a, b) {
  const out = [];
  for (const c of a) if (b.includes(c)) out.push(c);
  return out;
}

// Work the chart until it stops changing: line saturation, empty-space clipping, diagonal
// exclusion, over-long-run trimming. Returns CONFLICT when the chart cannot be finished from
// here.
function propagate(st) {
  const { grid, n, segs, stats } = st;
  for (;;) {
    let changed = false;

    for (let i = 0; i < n; i++) {
      const r = lineStatus(st, 'rows', i);
      if (r === null) return CONFLICT;
      if (r) { changed = true; stats.clue += r; }
    }
    for (let i = 0; i < n; i++) {
      const c = lineStatus(st, 'cols', i);
      if (c === null) return CONFLICT;
      if (c) { changed = true; stats.clue += c; }
    }

    // A square no legal hull can cross is water; a square that every hull through it shares is
    // hull. One pass, which also leaves `cand`/`branches` as this node's guess ranking.
    const force = [];
    for (let i = 0; i < n * n; i++) {
      const cell = grid[i];
      if (cell === WATER) { st.cand[i] = 0; st.branches[i] = 0; continue; }
      let ids = 0;
      let exact = 0;
      let inter = null;
      for (const id of segs.byCell[i]) {
        const seg = segs.all[id];
        const verdict = segmentVerdict(st, seg);
        if (verdict === NO) continue;
        ids++;
        if (verdict === EXACT) exact++;
        if (cell !== SHIP) continue;
        inter = inter === null ? seg.cells : keepCommon(inter, seg.cells);
      }
      if (cell === UNKNOWN) {
        st.cand[i] = ids;
        st.branches[i] = exact + 1; // +1 for "this square is water"
        if (ids === 0) {
          grid[i] = WATER;
          changed = true;
          stats.segment++;
        }
      } else if (ids === 0) {
        return CONFLICT;
      } else if (inter) {
        for (const c of inter) if (grid[c] === UNKNOWN) force.push(c);
      }
    }
    for (const c of force) {
      if (grid[c] === UNKNOWN) {
        grid[c] = SHIP;
        changed = true;
        stats.segment++;
      }
    }
    // 3. The dual of line saturation: if a line needs k more hull squares and only k of its
    //    open squares can still be crossed by any legal hull, those squares are hull. Without
    //    this the propagation almost never closes a chart and `depth` stops measuring anything.
    for (let i = 0; i < n; i++) {
      for (const axis of ['rows', 'cols']) {
        const r = openLineForce(st, axis, i);
        if (r === null) return CONFLICT;
        if (r) { changed = true; stats.clue += r; }
      }
    }
    if (!changed) return STEADY;
  }
}

// Fewest-branches-first, so a wrong assumption dies in one node rather than six.
function pickGuess(st) {
  const { grid, n } = st;
  let best = -1;
  let bestBranches = Infinity;
  let bestCand = Infinity;
  for (let i = 0; i < n * n; i++) {
    if (grid[i] !== UNKNOWN) continue;
    const b = st.branches[i];
    if (b < bestBranches || (b === bestBranches && st.cand[i] < bestCand)) {
      bestBranches = b;
      bestCand = st.cand[i];
      best = i;
    }
  }
  return best;
}

// The candidate hulls through one square: every segment that could sit there complete.
// Regenerated at the guess node rather than cached — it is a handful of segments, and caching
// them across propagation rounds is the kind of stale-state bug this file must not have.
function candidatesAt(st, cell) {
  const out = [];
  for (const id of st.segs.byCell[cell]) {
    const seg = st.segs.all[id];
    if (segmentVerdict(st, seg) === EXACT) out.push(seg);
  }
  out.sort((p, q) => q.len - p.len || p.cells[0] - q.cells[0]);
  return out;
}

function shipCells(st) {
  const out = [];
  for (let i = 0; i < st.grid.length; i++) if (st.grid[i] === SHIP) out.push(i);
  return out.sort((a, b) => a - b);
}

function puzzleOf(st) {
  return { n: st.n, fleet: st.fleet, rows: st.rows, cols: st.cols };
}

function search(st, depth, budget) {
  st.stats.nodes++;
  if (st.stats.nodes > budget) {
    st.truncated = true;
    return;
  }
  const saved = Uint8Array.from(st.grid);
  if (propagate(st) === CONFLICT) {
    st.grid.set(saved);
    return;
  }
  if (st.count >= st.limit) {
    st.grid.set(saved);
    return;
  }

  const cell = pickGuess(st);
  if (cell < 0) {
    const board = { n: st.n, cells: st.grid };
    if (isSolved(puzzleOf(st), board)) {
      st.count++;
      if (st.solutions.length < st.limit) {
        st.solutions.push({ hulls: hullsOf(board), cells: shipCells(st) });
      }
    }
    st.grid.set(saved);
    return;
  }

  if (depth + 1 > st.stats.depth) st.stats.depth = depth + 1;
  st.stats.guesses++;
  for (const seg of candidatesAt(st, cell)) {
    st.grid.set(saved);
    for (const c of seg.cells) st.grid[c] = SHIP;
    for (const c of segmentMargins(st, seg)) st.grid[c] = WATER;
    search(st, depth + 1, budget);
    if (st.count >= st.limit || st.truncated) break;
  }
  if (st.count < st.limit && !st.truncated) {
    st.grid.set(saved);
    st.grid[cell] = WATER;
    search(st, depth + 1, budget);
  }
  st.grid.set(saved);
}

// solve(puzzle, opts) ->
//   { ok, count, solution, solutions, depth, guesses, inferences, nodes, truncated, error }
// `count` caps at opts.limit (default 2): 0 = no solution, 1 = unique, 2 = "at least two",
// deliberately no more precise than the verdict needs. `budget` caps visited nodes; a search
// that runs out says `truncated` rather than pretending the chart has no second solution.
export function solve(puzzle, opts = {}) {
  const bad = sanePuzzle(puzzle);
  if (bad) {
    return {
      ok: false, count: 0, error: bad, depth: 0, guesses: 0, inferences: 0,
      nodes: 0, solutions: [], truncated: false,
    };
  }
  const st = makeState(puzzle, opts.segs || segmentsOf(puzzle.n, puzzle.fleet), opts.limit || 2);
  search(st, 0, opts.budget || 200000);
  return {
    ok: st.count > 0,
    count: st.count,
    solution: st.solutions[0] || null,
    solutions: st.solutions,
    depth: st.stats.depth,
    guesses: st.stats.guesses,
    inferences: st.stats.clue + st.stats.segment,
    deduced: { clue: st.stats.clue, segment: st.stats.segment },
    nodes: st.stats.nodes,
    truncated: st.truncated,
    error: null,
  };
}

// The chart the propagation reaches with no assumptions at all — what the clues give you for
// free, in board.js's cell encoding. No search runs here, so the shell may call it on a tap.
export function deduce(puzzle) {
  const bad = sanePuzzle(puzzle);
  if (bad) return null;
  const st = makeState(puzzle, segmentsOf(puzzle.n, puzzle.fleet), 1);
  if (propagate(st) === CONFLICT) return null;
  return { n: puzzle.n, cells: Array.from(st.grid) };
}
