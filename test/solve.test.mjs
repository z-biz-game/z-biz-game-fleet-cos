// The counter and the difficulty measurement. The fixtures in test/fixture.test.mjs ask what
// the solver answers about three hand charts; this file asks how it answers: the cap, the
// budget, the monotone relationship between `depth` and `guesses`, the geometry it shares
// with nothing, and the fact that it is a function of the puzzle and of nothing else.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { solve, deduce, segmentsOf } from '../js/core/solve.js';
import { countByTable } from '../js/core/enumerate.js';
import { placementsFor } from '../js/core/enumerate.js';
import { hullsOf, serialize, createBoard, set, SHIP, WATER } from '../js/core/board.js';
import { sanePuzzle } from '../js/core/rules.js';

const PURE = { n: 4, fleet: [1, 2, 3], rows: [0, 3, 1, 2], cols: [3, 0, 2, 1] };
const GUESS = { n: 4, fleet: [1, 2, 3], rows: [3, 0, 2, 1], cols: [3, 1, 1, 1] };

// Three submarines on a 5x5, each in one of rows {0,2,4} and one of columns {0,2,4}, exactly
// one per used row and column: that is a permutation matrix on 3 symbols, so 3! = 6 navies.
// None of them touch, because any two of rows {0,2,4} are at least two apart.
const SIX_WAYS = { n: 5, fleet: [1, 1, 1], rows: [1, 0, 1, 0, 1], cols: [1, 0, 1, 0, 1] };

// 2x2, two submarines, one per row and column: every pair of squares on a 2x2 touches, so
// the chart is unsolvable and the counter has to say 0 rather than shrug.
const IMPOSSIBLE = { n: 2, fleet: [1, 1], rows: [1, 1], cols: [1, 1] };

test('segmentsOf is the geometry the clues are read against, counted by hand', () => {
  eq(segmentsOf(4, [1, 2, 3]).all.length, 56, '16 + 24 + 16 segments');
  eq(segmentsOf(4, [1, 1, 2]).all.length, 40, 'a repeated length is generated once');
  eq(segmentsOf(4, [1, 2, 3]).lengths, [1, 2, 3]);
  eq(segmentsOf(4, [1, 2, 3]).maxL, 3);
  eq(segmentsOf(5, [3]).all.length, 30);
});

test('the solver segment list and the enumerator placement list are the same geometry', () => {
  // Two independent derivations of "every straight segment of these lengths", compared cell by
  // cell. If one of them ever grows an orientation case the other does not, this is the trip
  // wire - the reconciliation tests downstream would only see the difference as a wrong count.
  for (const [n, len] of [[4, 1], [4, 2], [4, 3], [5, 1], [5, 4], [6, 2]]) {
    const a = segmentsOf(n, [len]).all.map((s) => Array.from(s.cells).sort((x, y) => x - y).join(','));
    const b = placementsFor(n, len).map((p) => p.cells.slice().sort((x, y) => x - y).join(','));
    eq(a.sort(), b.sort(), `n=${n} len=${len}`);
  }
});

test('every square has its segments indexed, and the index is symmetric', () => {
  const segs = segmentsOf(4, [1, 2, 3]);
  eq(segs.byCell.length, 16);
  // Cell 0 is a corner: the 1-hull on it, a 2-hull to the right and down, a 3-hull to the
  // right and down - 5 segments.
  eq(segs.byCell[0].length, 5);
  // And each segment appears in byCell exactly once per square it covers.
  let through = 0;
  for (const list of segs.byCell) through += list.length;
  eq(through, segs.all.reduce((a, s) => a + s.cells.length, 0));
});

test('the counter stops at 2 and never claims a number it did not reach', () => {
  const capped = solve(SIX_WAYS, { limit: 2 });
  eq(capped.count, 2, 'two is the answer to "is this chart unique?"');
  eq(capped.solutions.length, 2, 'it stops collecting as well as counting');
  const uncapped = countByTable(SIX_WAYS, { limit: 8, budget: 600000 });
  eq(uncapped.count, 6, 'the enumeration, asked properly, says six - so the cap is real work');
  eq(solve(SIX_WAYS, { limit: 1 }).count, 1, 'a limit of 1 stops at the first solution');
});

test('an unsolvable chart is reported as zero, not as an error', () => {
  eq(sanePuzzle(IMPOSSIBLE), null, 'the clue vectors do agree with the fleet');
  const s = solve(IMPOSSIBLE, { limit: 2 });
  eq(s.count, 0);
  eq(s.ok, false);
  eq(s.solution, null);
  eq(countByTable(IMPOSSIBLE, { budget: 600000 }).count, 0, 'both routes call it empty');
});

test('depth is bounded by guesses, and both are zero exactly when deduction closes the chart', () => {
  const a = solve(PURE, { limit: 2 });
  eq([a.depth, a.guesses, a.nodes], [0, 0, 1], 'no assumption, so the search never branches');
  eq(a.inferences > 0, true, 'the pure run still has to report the squares it deduced');
  const b = solve(GUESS, { limit: 2 });
  ok(b.depth >= 1);
  ok(b.guesses >= b.depth, 'each level of the stack was entered by a guess');
  ok(b.nodes > b.depth, 'a branching search visits more nodes than its deepest line');
});

test('the answer is a function of the puzzle alone', () => {
  const runs = [solve(GUESS, { limit: 2 }), solve(GUESS, { limit: 2 })];
  eq(runs.map((r) => [r.count, r.depth, r.guesses, r.solution.cells.join(',')].join('|')),
    ['1|1|1|0,1,2,8,11,12', '1|1|1|0,1,2,8,11,12']);
  eq(serialize({ n: 4, cells: deduce(GUESS).cells }), serialize({ n: 4, cells: deduce(GUESS).cells }));
});

test('a starved budget says truncated instead of reporting uniqueness', () => {
  const s = solve(GUESS, { limit: 2, budget: 1 });
  eq(s.truncated, true);
  eq(s.ok, false, 'a search that never finished cannot claim a solution');
  const big = solve(GUESS, { limit: 2, budget: 100000 });
  eq(big.truncated, false);
});

test('deduce makes only sound marks: whatever it paints agrees with the one solution', () => {
  const s = solve(PURE, { limit: 2 });
  const d = deduce(PURE);
  const solution = new Set(s.solution.cells);
  for (let i = 0; i < d.cells.length; i++) {
    if (d.cells[i] !== SHIP) continue;
    ok(solution.has(i), `deduced ship at cell ${i} must be part of the certified navy`);
  }
  const board = createBoard(4, WATER);
  for (let i = 0; i < d.cells.length; i++) if (d.cells[i] === SHIP) set(board, i % 4, (i / 4) | 0, SHIP);
  const runs = hullsOf(board);
  ok(runs.length >= 1, 'deduction paints something on a chart it can close');
  eq(validateLineCounts(board), true);
});

test('deduce never paints a square the solver knows is water', () => {
  const s = solve(GUESS, { limit: 2 });
  const shipSet = new Set(s.solution.cells);
  const d = deduce(GUESS);
  for (let i = 0; i < d.cells.length; i++) {
    if (d.cells[i] !== SHIP) continue;
    ok(shipSet.has(i), `cell ${i} was deduced as hull but is not in the solution`);
  }
});

test('the solver does not touch the puzzle or the segment cache it was handed', () => {
  const puzzle = { n: 4, fleet: [1, 2, 3], rows: [0, 3, 1, 2], cols: [3, 0, 2, 1] };
  const before = JSON.stringify(puzzle);
  const segs = segmentsOf(4, [1, 2, 3]);
  const segBefore = JSON.stringify(segs.all);
  solve(puzzle, { limit: 2, segs });
  deduce(puzzle);
  eq(JSON.stringify(puzzle), before);
  eq(JSON.stringify(segs.all), segBefore);
});

test('an illegal clue vector is answered with an error, not with a search', () => {
  const s = solve({ n: 4, fleet: [1, 2, 3], rows: [1, 1, 1, 1], cols: [2, 1, 1, 2] }, { limit: 2 });
  eq(s.ok, false);
  eq(s.error, 'clue sums disagree with the fleet');
  eq(s.count, 0);
});


// The other half of soundness: the squares deduce painted must not overshoot any clue.
function validateLineCounts(board) {
  const rows = [0, 0, 0, 0];
  const cols = [0, 0, 0, 0];
  for (let i = 0; i < 16; i++) {
    if (board.cells[i] !== SHIP) continue;
    rows[(i / 4) | 0] += 1;
    cols[i % 4] += 1;
  }
  return rows.every((v, i) => v <= PURE.rows[i]) && cols.every((v, i) => v <= PURE.cols[i]);
}

run();
