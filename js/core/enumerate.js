// The second leg: an independent count of the same answer.
//
// js/core/solve.js reasons — clues first, geometry as it goes, a guess when it stalls. If
// that file had a hole in it (an unsound deduction that quietly discards a second solution)
// it would still answer "unique" with a straight face, and "unique" is the only claim this
// game makes about its charts. So nothing ships on that verdict alone.
//
// This file does not look at a clue while it builds its table. It lays the whole navy out on
// an empty board, one hull at a time, taking every position that neither overlaps nor touches
// (corners included) what is already down, and records the row/column hull-counts each
// finished arrangement produces. Matching a chart against that table is then one comparison
// per entry: the answer arrives by brute enumeration, sharing no propagation, no guessing and
// no segment geometry with the solver.
//
// `budget` bounds the table. A bounded table sets `truncated`, and then `countByTable` falls
// back to walking the same placements clue-first — a different memory profile, the same
// independence. Which route each shipped lot took is printed by tools/bake.mjs.

// Every straight run of `len` cells on an n x n board, derived from the board rather than
// imported from the solver: two routes that share their geometry share their geometry bugs.
// A one-cell hull has no orientation, so it is generated once — and it is still bound by the
// diagonal rule, which is what makes a submarine the tightest squeeze on the chart.
export function placementsFor(n, len) {
  const out = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x + len <= n; x++) {
      const cells = [];
      for (let k = 0; k < len; k++) cells.push(y * n + x + k);
      out.push({ axis: 'h', x, y, len, cells });
    }
  }
  if (len === 1) return out;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y + len <= n; y++) {
      const cells = [];
      for (let k = 0; k < len; k++) cells.push((y + k) * n + x);
      out.push({ axis: 'v', x, y, len, cells });
    }
  }
  return out;
}

// Pack a row/column count pair into one number so a clue match is a single comparison.
// Base n+1 over 2n digits: exact for n <= 8 (9^16 < 2^53). Exported for the collision test in
// test/enumerate.test.mjs, which is the only way to show the packing is not silently lossy.
export function packCount(rows, cols) {
  const base = rows.length + 1;
  let v = 0;
  for (let i = 0; i < rows.length; i++) v = v * base + rows[i];
  for (let i = 0; i < cols.length; i++) v = v * base + cols[i];
  return v;
}

// enumerate(n, fleet, opts) -> { n, fleet, entries, arrangements, truncated }
// With `opts.clue = { rows, cols }` the walk also refuses a placement that would overshoot a
// line, which is the filter applied on the fly instead of after the table exists.
export function enumerate(n, fleet, opts = {}) {
  const budget = opts.budget === undefined ? 400000 : opts.budget;
  const clue = opts.clue || null;
  const sizes = new Map();
  for (const L of fleet) sizes.set(L, (sizes.get(L) || 0) + 1);
  // Longest hull first: it blocks the most water, so the tree thins out earliest.
  const lens = Array.from(sizes.keys()).sort((a, b) => b - a);
  const slotBoards = [];
  for (const L of lens) {
    const board = placementsFor(n, L);
    for (let k = 0; k < sizes.get(L); k++) slotBoards.push(board);
  }

  const entries = [];
  const seen = new Set();
  let truncated = false;
  let arrangements = 0;
  const occ = new Uint8Array(n * n); // 1 where a hull lies
  const ban = new Uint8Array(n * n); // how many hull cells touch this one, corners included
  const rows = new Array(n).fill(0);
  const cols = new Array(n).fill(0);

  function touch(cell, delta) {
    const x = cell % n;
    const y = (cell - x) / n;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const k = ny * n + nx;
        if (occ[k]) continue;
        ban[k] += delta;
      }
    }
  }

  function leaf() {
    arrangements++;
    const cells = [];
    for (let i = 0; i < n * n; i++) if (occ[i]) cells.push(i);
    const rc = packCount(rows, cols);
    // Two equal-length hulls swapped describe one chart, and the chart is what gets counted:
    // the clues cannot tell two submarines apart, so neither may this table.
    const key = `${rc}:${cells.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (entries.length >= budget) {
      truncated = true;
      return;
    }
    entries.push({ rc, rows: rows.slice(), cols: cols.slice(), cells });
  }

  function place(slot) {
    if (truncated) return;
    if (slot === slotBoards.length) {
      leaf();
      return;
    }
    for (const p of slotBoards[slot]) {
      let fits = true;
      for (const c of p.cells) {
        if (occ[c] || ban[c]) { fits = false; break; }
        if (clue) {
          const y = (c - (c % n)) / n;
          const x = c % n;
          if (rows[y] + 1 > clue.rows[y] || cols[x] + 1 > clue.cols[x]) { fits = false; break; }
        }
      }
      if (!fits) continue;
      // Occupy first, then forbid: the hull's own cells are neighbours of each other and must
      // not end up in each other's banned water. Undo mirrors it exactly.
      for (const c of p.cells) occ[c] = 1;
      for (const c of p.cells) {
        touch(c, 1);
        rows[(c - (c % n)) / n] += 1;
        cols[c % n] += 1;
      }
      place(slot + 1);
      for (const c of p.cells) {
        touch(c, -1);
        rows[(c - (c % n)) / n] -= 1;
        cols[c % n] -= 1;
      }
      for (const c of p.cells) occ[c] = 0;
      if (truncated) return;
    }
  }

  place(0);
  return { n, fleet: fleet.slice(), entries, arrangements, truncated };
}

// How many arrangements of the table fill this chart exactly, and up to `limit` of them.
export function filterTable(table, rows, cols, limit = 2) {
  const rc = packCount(rows, cols);
  let count = 0;
  const solutions = [];
  for (const e of table.entries) {
    if (e.rc !== rc) continue;
    let match = true;
    for (let i = 0; i < table.n; i++) {
      if (e.rows[i] !== rows[i] || e.cols[i] !== cols[i]) { match = false; break; }
    }
    if (!match) continue;
    count++;
    if (solutions.length < limit) solutions.push(e.cells.slice());
    if (count >= limit) break;
  }
  return { count, solutions };
}

const cache = new Map();

// Build-or-reuse the clue-free table for (n, fleet): a whole shipped band on one board size is
// reconciled against a single walk over the navy.
export function tableFor(n, fleet, opts = {}) {
  const budget = opts.budget === undefined ? 400000 : opts.budget;
  const key = `${n}:${fleet.slice().sort((a, b) => a - b).join(',')}:${budget}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = enumerate(n, fleet, { ...opts, budget });
  cache.set(key, made);
  return made;
}

export function clearTables() {
  cache.clear();
}

// The count this route gives for one chart, in the shape solve() answers with.
export function countByTable(puzzle, opts = {}) {
  const limit = opts.limit || 2;
  let table = null;
  if (!opts.clueFirst) {
    table = opts.table || tableFor(puzzle.n, puzzle.fleet, opts);
    if (table.truncated) table = null;
  }
  if (!table) {
    const made = enumerate(puzzle.n, puzzle.fleet, {
      clue: { rows: puzzle.rows, cols: puzzle.cols },
      budget: opts.budget || 100000,
    });
    return {
      count: Math.min(made.entries.length, limit),
      solutions: made.entries.slice(0, limit).map((e) => e.cells),
      entries: made.entries.length,
      arrangements: made.arrangements,
      truncated: made.truncated,
      route: 'clue-first enumeration',
    };
  }
  const r = filterTable(table, puzzle.rows, puzzle.cols, limit);
  return {
    count: r.count,
    solutions: r.solutions,
    entries: table.entries.length,
    arrangements: table.arrangements,
    truncated: table.truncated,
    route: 'enumerated table, filtered',
  };
}
