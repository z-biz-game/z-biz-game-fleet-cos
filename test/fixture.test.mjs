// The three hand fixtures. Every expected number below was written on paper first and then
// typed in: the cell sets are hand-decomposed into hulls, and the per-line counts next to
// each hull list are the arithmetic that produced the clue vectors. Nothing here is read
// back out of js/core/*, which is the only reason these tests can catch a regression in the
// rules rather than restate them.
//
// Common to all three: n = 4, fleet = [1,2,3] (six hull squares), so the gate is
//
//     Σ row clues === Σ column clues === 1 + 2 + 3 === 6
//
// and every hull set below is checked by hand against that.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { solve, deduce } from '../js/core/solve.js';
import { countByTable } from '../js/core/enumerate.js';
import { verifyChart } from '../js/core/make.js';
import { clueSums, cluesConsistent, validate, sanePuzzle } from '../js/core/rules.js';
import { hullsOf, SHIP, WATER, UNKNOWN } from '../js/core/board.js';
import { LOTS } from '../js/data/lots.js';

// The grid a hand-copied cell list paints: those squares are hull, every other square is
// water. Written here so the expectations below are derived from the paper fixture, not from
// whatever the code produced.
function handGrid(cells, size = 16) {
  const out = new Array(size).fill(WATER);
  for (const c of cells) out[c] = SHIP;
  return out;
}

// --- fixture 1: closed by pure deduction -------------------------------------------------
// Hand layout (x,y from the top-left):
//   3-hull vertical (0,1)-(0,2)-(0,3)  -> cells 4, 8, 12
//   2-hull horizontal (2,1)-(3,1)      -> cells 6, 7
//   1-hull            (2,3)            -> cell  14
// Rows: r0 0 | r1 4,6,7 = 3 | r2 8 = 1 | r3 12,14 = 2      -> [0,3,1,2]
// Cols: c0 4,8,12 = 3 | c1 0 | c2 6,14 = 2 | c3 7 = 1      -> [3,0,2,1]
// No two hulls touch, corners included: the 3-hull's neighbours are (1,0),(1,1),(1,2) and
// the 2-hull starts at x = 2, so the closest pair is (0,3)-(2,1) - two columns apart.
export const PURE = {
  puzzle: { n: 4, fleet: [1, 2, 3], rows: [0, 3, 1, 2], cols: [3, 0, 2, 1] },
  cells: [4, 6, 7, 8, 12, 14],
  hulls: [
    { x: 0, y: 1, len: 3, axis: 'v' },
    { x: 2, y: 1, len: 2, axis: 'h' },
    { x: 2, y: 3, len: 1, axis: 'h' },
  ],
};

// --- fixture 2: unique, but deduction stalls and one assumption is needed ----------------
// Hand layout:
//   3-hull horizontal (0,0)-(1,0)-(2,0) -> cells 0, 1, 2
//   2-hull vertical   (0,2)-(0,3)       -> cells 8, 12
//   1-hull            (3,2)             -> cell  11
// Rows: r0 0,1,2 = 3 | r1 0 | r2 8,11 = 2 | r3 12 = 1       -> [3,0,2,1]
// Cols: c0 0,8,12 = 3 | c1 1 = 1 | c2 2 = 1 | c3 11 = 1     -> [3,1,1,1]
// Why deduction cannot close it: the line counts alone already pin cells 0,1 (row 0 needs 3
// and column 1, 2 only accept one each), and they leave four squares open - {2,3} for the
// third square of the 3-hull and {10,11} for row 2's second square. Cells 10 and 11 look
// interchangeable to any row/column tally, and picking one only pays off two steps later.
// That is the assumption the solver records as depth 1.
export const GUESS = {
  puzzle: { n: 4, fleet: [1, 2, 3], rows: [3, 0, 2, 1], cols: [3, 1, 1, 1] },
  cells: [0, 1, 2, 8, 11, 12],
};

// --- fixture 3: deliberately ambiguous ---------------------------------------------------
// Fixture 2 with a square of crossing information erased: the two column clues that read the
// (column 0 / row 0) and (column 3 / row 0) crossings move by one each (c0 3 -> 2, c3 1 -> 2)
// so the totals still agree. With clue sums pinned by the public fleet list, erasing a
// *single* line is information-neutral (the erased number is the fleet total minus the other
// three), so a genuinely weaker chart has to move two lines - and the two navies below are
// then hand-checkable against it:
//   A = {0,1,2,8,11,15} -> 3h (0,0)-(2,0) | 1 at (0,2) | 2v (3,2)-(3,3)
//   B = {1,2,3,8,11,12} -> 3h (1,0)-(3,0) | 1 at (3,2) | 2v (0,2)-(0,3)
// Both give rows [3,0,2,1] and cols [2,1,1,2], and neither pair of hulls touches.
export const AMBIGUOUS = {
  puzzle: { n: 4, fleet: [1, 2, 3], rows: [3, 0, 2, 1], cols: [2, 1, 1, 2] },
  solutions: [
    { cells: [0, 1, 2, 8, 11, 15], hulls: '3h@(0,0) 2v@(3,2) 1@(0,2)' },
    { cells: [1, 2, 3, 8, 11, 12], hulls: '3h@(1,0) 2h@(0,3) 1@(3,2)' },
  ],
};

// --- the arithmetic gate -----------------------------------------------------------------

test('fixture 1 clue sums: Σrows === Σcols === Σfleet === 6', () => {
  eq(clueSums(PURE.puzzle), { rows: 6, cols: 6, fleet: 6 });
  ok(cluesConsistent(PURE.puzzle), 'fixture 1 must pass the sums gate');
});

test('fixture 2 clue sums: 6 === 6 === 6', () => {
  eq(clueSums(GUESS.puzzle), { rows: 6, cols: 6, fleet: 6 });
  ok(cluesConsistent(GUESS.puzzle));
});

test('fixture 3 clue sums: 6 === 6 === 6', () => {
  eq(clueSums(AMBIGUOUS.puzzle), { rows: 6, cols: 6, fleet: 6 });
  ok(cluesConsistent(AMBIGUOUS.puzzle), 'an ambiguous chart must still be internally consistent');
});

test('fixture 1 hand layout reproduces its own clue vectors', () => {
  // Build the grid from the hand-copied cells instead of from a generator.
  const cells = new Uint8Array(16);
  for (const c of PURE.cells) cells[c] = SHIP;
  const { rows, cols } = { rows: [0, 0, 0, 0], cols: [0, 0, 0, 0] };
  for (let i = 0; i < 16; i++) {
    if (cells[i] !== SHIP) continue;
    rows[(i / 4) | 0] += 1;
    cols[i % 4] += 1;
  }
  eq(rows, PURE.puzzle.rows, 'hand-counted rows');
  eq(cols, PURE.puzzle.cols, 'hand-counted cols');
  eq(hullsOf({ n: 4, cells }), PURE.hulls, 'hand-copied cells must decompose into the hand-copied hulls');
  eq(validate(PURE.puzzle, hullsOf({ n: 4, cells })), null, 'the hand layout must be legal');
});

test('fixture 2 hand cells satisfy their clues and are legal', () => {
  const cells = new Uint8Array(16);
  for (const c of GUESS.cells) cells[c] = SHIP;
  const rows = [0, 0, 0, 0];
  const cols = [0, 0, 0, 0];
  for (let i = 0; i < 16; i++) {
    if (cells[i] !== SHIP) continue;
    rows[(i / 4) | 0] += 1;
    cols[i % 4] += 1;
  }
  eq(rows, GUESS.puzzle.rows);
  eq(cols, GUESS.puzzle.cols);
  eq(validate(GUESS.puzzle, hullsOf({ n: 4, cells })), null);
});

test('fixture 3 lists two hand-decomposed navies and both satisfy the same clues', () => {
  for (const navy of AMBIGUOUS.solutions) {
    const cells = new Uint8Array(16);
    for (const c of navy.cells) cells[c] = SHIP;
    const rows = [0, 0, 0, 0];
    const cols = [0, 0, 0, 0];
    for (let i = 0; i < 16; i++) {
      if (cells[i] !== SHIP) continue;
      rows[(i / 4) | 0] += 1;
      cols[i % 4] += 1;
    }
    eq(rows, AMBIGUOUS.puzzle.rows, `${navy.hulls} rows`);
    eq(cols, AMBIGUOUS.puzzle.cols, `${navy.hulls} cols`);
    eq(validate(AMBIGUOUS.puzzle, hullsOf({ n: 4, cells })), null, `${navy.hulls} must be legal`);
  }
  ok(AMBIGUOUS.solutions[0].cells.join() !== AMBIGUOUS.solutions[1].cells.join(),
    'the two navies must be different cell sets, or the fixture proves nothing');
});

// --- what the solver and the counter owe these fixtures -----------------------------------

test('fixture 1 has exactly one solution and needs no assumption (depth 0)', () => {
  const s = solve(PURE.puzzle, { limit: 2 });
  eq(s.count, 1);
  eq(s.depth, 0);
  eq(s.guesses, 0);
  eq(s.solution.cells, PURE.cells, 'the solver must find the hand-copied navy');
});

test('fixture 1 is closed by deduction alone', () => {
  const d = deduce(PURE.puzzle);
  eq(Array.from(d.cells), handGrid(PURE.cells),
    'deduction alone must paint exactly the hand-copied navy');
});

test('fixture 2 needs one assumption, so depth is not a decorative constant', () => {
  const s = solve(GUESS.puzzle, { limit: 2 });
  eq(s.count, 1, 'unique');
  ok(s.guesses >= 1, 'pure reasoning must not be able to finish this chart');
  eq(s.depth, 1);
  eq(s.solution.cells, GUESS.cells);
  // Deduction alone must visibly stall - that is the same claim from the other side.
  const d = deduce(GUESS.puzzle);
  eq(d.cells.map((c, i) => (c === UNKNOWN ? i : -1)).filter((i) => i >= 0), [2, 3, 10, 11],
    'the four squares the hand argument leaves open are 2, 3, 10, 11');
});

test('fixture 3 is counted at 2 and the counter never claims more', () => {
  const s = solve(AMBIGUOUS.puzzle, { limit: 2 });
  eq(s.count, 2, 'the counter must not say unique about this chart');
  eq(s.solutions.map((x) => x.cells.join(',')).sort(),
    AMBIGUOUS.solutions.map((x) => x.cells.join(',')).sort(),
    'both hand-decomposed navies must be the ones the counter finds');
});

test('fixture 3 is rejected by the shipping gate', () => {
  const v = verifyChart(AMBIGUOUS.puzzle, { budget: 600000 });
  eq(v.ok, false);
  eq(v.reason, 'notUnique');
});

test('fixture 3 appears nowhere in the shipped pool', () => {
  const key = (p) => `${p.n}|${p.rows.join(',')}|${p.cols.join(',')}`;
  const want = key(AMBIGUOUS.puzzle);
  ok(!LOTS.some((l) => key(l) === want), 'an ambiguous chart must never be baked');
});

test('the two independent routes agree on all three fixtures', () => {
  for (const p of [PURE.puzzle, GUESS.puzzle, AMBIGUOUS.puzzle]) {
    const a = solve(p, { limit: 2 });
    const b = countByTable(p, { limit: 2, budget: 600000 });
    eq(b.count, a.count, `count for ${p.cols.join(',')}`);
    eq(b.solutions[0].slice().sort((x, y) => x - y), a.solution.cells, 'same solution cells');
  }
});

test('solving does not mutate the puzzle it was handed', () => {
  const before = JSON.stringify(PURE.puzzle);
  const copy = JSON.parse(before);
  solve(copy, { limit: 2 });
  deduce(copy);
  countByTable(copy, { budget: 600000 });
  eq(copy, JSON.parse(before), 'puzzle must be untouched by all three routes');
  const hulls = PURE.hulls.slice();
  validate(PURE.puzzle, hulls);
  eq(hulls, PURE.hulls, 'validate must not touch the hull list');
});

test('a malformed chart is refused before any search', () => {
  eq(sanePuzzle({ n: 4, fleet: [1, 2, 3], rows: [3, 0, 2, 1], cols: [2, 1, 1, 1] }),
    'clue sums disagree with the fleet');
  eq(solve({ n: 4, fleet: [1, 2, 3], rows: [3, 0, 2, 1], cols: [2, 1, 1, 1] }, { limit: 2 }).ok, false);
  eq(sanePuzzle({ n: 1, fleet: [1], rows: [1], cols: [1] }), 'board size');
  eq(sanePuzzle({ n: 4, fleet: [], rows: [0, 0, 0, 0], cols: [0, 0, 0, 0] }), 'empty fleet');
});

run();
