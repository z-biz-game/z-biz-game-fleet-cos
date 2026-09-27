// The rules, as six separate questions. Each one is exported on its own and each one has
// its own negative in test/rules.test.mjs, because a validator that reports one fused
// "invalid" verdict cannot be shown to actually be watching all six ways to be wrong.
//
// The rule that everything else in this repo leans on:
//
//   Ships are straight, axis-aligned segments, and NO two ships may be adjacent —
//   including diagonally.
//
// The diagonal half is not decoration. `firstContact` returning null is what makes a
// known hull cell darken a 3x3 block in js/core/solve.js; if the corner rule were
// dropped, every fixture in test/fixture.test.mjs and every row of the enumeration table
// in js/core/enumerate.js would describe a different game. Change it and nothing below
// this paragraph is true any more.
//
// A puzzle is `{ n, fleet, rows, cols }`: board size, the list of hull lengths the navy
// owns, and how many hull squares each row / column contains.

import {
  SHIP, NEIGHBOURS8, hullCells, inside, idx, shipCounts, hullsOf, isResolved,
} from './board.js';

export const ERRORS = {
  bounds: 'outOfBounds',
  overlap: 'overlap',
  contact: 'contact',
  rowClue: 'rowClue',
  colClue: 'colClue',
  fleet: 'fleet',
};

export function clueSums(puzzle) {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return { rows: sum(puzzle.rows), cols: sum(puzzle.cols), fleet: sum(puzzle.fleet) };
}

// The cheapest possible gate, and the one that catches a hand-edited clue vector: three
// independent counts of the same pile of hull squares have to agree.
export function cluesConsistent(puzzle) {
  const s = clueSums(puzzle);
  return s.rows === s.cols && s.rows === s.fleet;
}

export function sanePuzzle(puzzle) {
  if (!puzzle || !Number.isInteger(puzzle.n) || puzzle.n < 2) return 'board size';
  if (!Array.isArray(puzzle.fleet) || !puzzle.fleet.length) return 'empty fleet';
  if (!puzzle.fleet.every((L) => Number.isInteger(L) && L >= 1 && L <= puzzle.n)) return 'hull length';
  for (const key of ['rows', 'cols']) {
    const line = puzzle[key];
    if (!Array.isArray(line) || line.length !== puzzle.n) return `${key} length`;
    if (!line.every((c) => Number.isInteger(c) && c >= 0 && c <= puzzle.n)) return `${key} value`;
  }
  if (!cluesConsistent(puzzle)) return 'clue sums disagree with the fleet';
  return null;
}

// --- the six checks -------------------------------------------------------------------

// 1. Every square of every hull inside the chart.
export function firstOutOfBounds(n, hulls) {
  for (let i = 0; i < hulls.length; i++) {
    if (hullCells(hulls[i]).some(([x, y]) => !inside(n, x, y))) return i;
  }
  return -1;
}

// 2. Two hulls claiming the same square.
export function firstOverlap(n, hulls) {
  const seen = new Map();
  for (let i = 0; i < hulls.length; i++) {
    for (const [x, y] of hullCells(hulls[i])) {
      const k = idx(n, x, y);
      if (seen.has(k)) return { i, j: seen.get(k), cell: k };
      seen.set(k, i);
    }
  }
  return null;
}

// 3. Two hulls in the same water: any of the eight neighbours, corners included.
//    Squares of one hull are neighbours of each other, so the comparison is strictly
//    hull-against-a-different-hull.
export function firstContact(n, hulls) {
  const owner = new Map();
  for (let i = 0; i < hulls.length; i++) {
    for (const [x, y] of hullCells(hulls[i])) {
      if (!inside(n, x, y)) continue;
      owner.set(idx(n, x, y), i);
    }
  }
  for (const [cell, i] of owner) {
    const x = cell % n;
    const y = (cell - x) / n;
    for (const [dx, dy] of NEIGHBOURS8) {
      // `inside` first: on a flat row-major index, x + dx running off the left edge wraps
      // onto the previous row's right-hand cell, which is a neighbour of nothing.
      if (!inside(n, x + dx, y + dy)) continue;
      const j = owner.get(idx(n, x + dx, y + dy));
      if (j !== undefined && j !== i) return { i, j };
    }
  }
  return null;
}

// 6. The navy on the chart is not the navy the clues describe: same total is not enough,
//    the multiset of hull lengths has to match, duplicates and all.
export function fleetMismatch(fleet, hulls) {
  const need = fleet.slice().sort((a, b) => a - b);
  const have = hulls.map((h) => h.len).sort((a, b) => a - b);
  if (need.length !== have.length) return { need, have };
  for (let i = 0; i < need.length; i++) if (need[i] !== have[i]) return { need, have };
  return null;
}

// 4 + 5. Line counts against clues.
export function mismatchingLines(puzzle, board, axis) {
  const { rows, cols } = shipCounts(board);
  const have = axis === 'rows' ? rows : cols;
  const clue = axis === 'rows' ? puzzle.rows : puzzle.cols;
  const bad = [];
  for (let i = 0; i < have.length; i++) if (have[i] !== clue[i]) bad.push(i);
  return bad;
}

// --- one entry point over hulls -------------------------------------------------------

// validate(puzzle, hulls) -> null when the fleet is exactly right, else
// { code, detail }. Ordered so the loudest mistake wins: a hull that is not even on the
// board cannot also be judged on its clue arithmetic.
export function validate(puzzle, hulls) {
  const i = firstOutOfBounds(puzzle.n, hulls);
  if (i >= 0) return { code: ERRORS.bounds, detail: { hull: i } };
  const o = firstOverlap(puzzle.n, hulls);
  if (o) return { code: ERRORS.overlap, detail: o };
  const c = firstContact(puzzle.n, hulls);
  if (c) return { code: ERRORS.contact, detail: c };
  const f = fleetMismatch(puzzle.fleet, hulls);
  if (f) return { code: ERRORS.fleet, detail: f };
  const board = boardOfHulls(puzzle.n, hulls);
  const r = mismatchingLines(puzzle, board, 'rows');
  if (r.length) return { code: ERRORS.rowClue, detail: { lines: r } };
  const k = mismatchingLines(puzzle, board, 'cols');
  if (k.length) return { code: ERRORS.colClue, detail: { lines: k } };
  return null;
}

function boardOfHulls(n, hulls) {
  const cells = new Uint8Array(n * n);
  for (const h of hulls) {
    for (const [x, y] of hullCells(h)) cells[idx(n, x, y)] = SHIP;
  }
  return { n, cells };
}

// --- what the shell asks at every tap --------------------------------------------------

// Single-step legality, and nothing more. This never searches: it asks whether *this*
// hull could be added to the hulls already afloat. The length is checked against what is
// left of the fleet so a five-cell drag on a [1,2,3] chart is refused at the release
// rather than after the player has drawn the whole thing.
export function canPlaceHull(puzzle, hulls, hull) {
  if (!hull || !Number.isInteger(hull.len) || hull.len < 1) return ERRORS.fleet;
  const left = remainingFleet(puzzle.fleet, hulls);
  if (!left.includes(hull.len)) return ERRORS.fleet;
  const trial = hulls.concat([hull]);
  if (firstOutOfBounds(puzzle.n, trial) >= 0) return ERRORS.bounds;
  if (firstOverlap(puzzle.n, trial)) return ERRORS.overlap;
  if (firstContact(puzzle.n, trial)) return ERRORS.contact;
  return null;
}

export function remainingFleet(fleet, hulls) {
  const left = fleet.slice();
  for (const h of hulls) {
    const k = left.indexOf(h.len);
    if (k >= 0) left.splice(k, 1);
  }
  return left;
}

// Live "satisfied / exceeded" readout for the clue strip. `over` counts hull squares in a
// line that already holds its clue: the UI shakes those and refuses to count them, which
// is why the tally has to come from here rather than from a plain count.
export function clueStatus(puzzle, board) {
  const { rows, cols } = shipCounts(board);
  const line = (have, clue) => clue.map((c, i) => ({
    i,
    clue: c,
    have: have[i],
    full: have[i] >= c,
    over: have[i] > c,
  }));
  return { rows: line(rows, puzzle.rows), cols: line(cols, puzzle.cols) };
}

// The completion test. Pure validation, no search: a resolved board whose hulls are the
// fleet and whose lines match the clues IS a solution, and js/core/solve.js has already
// proved there is only one before the lot ships.
export function isSolved(puzzle, board) {
  if (!isResolved(board)) return false;
  const runs = hullsOf(board);
  return validate(puzzle, runs) === null;
}
