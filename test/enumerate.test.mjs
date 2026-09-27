// The second leg, on its own terms: an enumeration of every legal navy on the board that
// never looks at a clue, the table it produces, and the reconciliation that makes the
// solver's "unique" claim into evidence.
//
// Hand counts below are derived on paper from the rule set (straight segments, no touching,
// corners included), not from this code. The 3x3 [1,1] count is the one that pins the rule:
// 16 pairs is "no touching including diagonally"; the orthogonal-only reading of the same
// sentence gives 24.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  placementsFor, enumerate, filterTable, tableFor, clearTables, countByTable, packCount,
} from '../js/core/enumerate.js';
import { solve } from '../js/core/solve.js';

const chartsOf = (table) => table.entries.map((e) => ({
  n: table.n,
  fleet: table.fleet,
  rows: e.rows,
  cols: e.cols,
}));

test('placementsFor counts straight segments by hand', () => {
  // A 2-hull on 4x4: 3 positions per row x 4 rows = 12 horizontal, 12 vertical.
  eq(placementsFor(4, 2).length, 24);
  // A 1-hull has no orientation, so it is generated once - 16 squares, 16 placements.
  eq(placementsFor(4, 1).length, 16);
  eq(placementsFor(4, 1).filter((p) => p.axis === 'v').length, 0,
    'a doubled 1-hull would make every submarine count twice');
  // A 3-hull on 5x5: 3 per row x 5 = 15 each way.
  eq(placementsFor(5, 3).length, 30);
  eq(placementsFor(3, 3).length, 6, 'on its own board a 3-hull fits 3 rows and 3 columns');
});

test('the empty-board navy counts are hand-derivable', () => {
  // 3x3, two submarines: C(9,2) = 36 pairs, minus the 12 edge-adjacent and the 8 corner-
  // adjacent pairs, leaves 16. Each pair is one cell set and two placement orders.
  const nine = enumerate(3, [1, 1]);
  eq(nine.entries.length, 16, '16 = 36 pairs - 20 touching pairs (orthogonal and diagonal)');
  eq(nine.arrangements, 32, 'the two identical hulls are the same chart in two orders');
  // 4x4, two submarines: C(16,2) = 120, minus 12 horizontal + 12 vertical + 18 diagonal = 42
  // touching pairs, leaves 78.
  eq(enumerate(4, [1, 1]).entries.length, 78);
  // 2x2: every pair of distinct squares touches (4 edges + 2 diagonals = 6 = C(4,2)), so no
  // two submarines fit at all.
  const two = enumerate(2, [1, 1]);
  eq(two.entries.length, 0);
  eq(two.truncated, false, 'an empty table is a complete answer, not a timeout');
  // A single hull has no neighbour to exclude, so the table is just the segment count.
  eq(enumerate(4, [2]).entries.length, 24);
  // A 3-hull on 4x4 fits 2 positions per row (4x2 = 8) and 8 vertically.
  eq(enumerate(4, [3]).entries.length, 16);
});

test('a fleet with equal lengths is deduped by cell set, not by order', () => {
  const t = enumerate(4, [1, 2, 3]);
  eq(t.entries.length, t.arrangements, 'three different lengths can never be reordered');
  const s = enumerate(4, [1, 1, 2]);
  ok(s.arrangements > s.entries.length, 'the pair of submarines must double the arrangement count');
  eq(s.arrangements, 2 * s.entries.length);
});

test('packCount is exact where the table uses it', () => {
  // rows [0,3,1,2], cols [3,0,2,1] on n=4, base 5:
  // ((((0*5+0)*5+3)*5+1)*5+2) = 82 after the rows, then *5+3, *5+0, *5+2, *5+1.
  eq(packCount([0, 3, 1, 2], [3, 0, 2, 1]), 51636);
  eq(packCount([0, 3, 1, 2], [3, 0, 2, 2]) !== packCount([0, 3, 1, 2], [3, 0, 2, 1]), true,
    'one square of difference must change the key');
  // The largest clue vector a 4x4 can hold, to show the base leaves no carry.
  eq(packCount([4, 4, 4, 4], [4, 4, 4, 4]) > packCount([0, 0, 0, 0], [0, 0, 0, 0]), true);
});

test('filterTable returns the entries whose lines match, and stops at the limit', () => {
  const table = tableFor(4, [1, 2, 3], { budget: 600000 });
  const e = table.entries[0];
  const hit = filterTable(table, e.rows, e.cols, 2);
  ok(hit.count >= 1, 'an entry always matches its own clue vector');
  eq(hit.solutions.length >= 1, true);
  const none = filterTable(table, [4, 0, 1, 1], [4, 0, 1, 1], 2);
  eq(none.count, 0, 'a row of four on a [1,2,3] navy is impossible');
  const capped = filterTable(table, [0, 0, 0, 0], [0, 0, 0, 0], 2);
  eq(capped.count, 0);
});

test('clue pruning never invents an arrangement', () => {
  const full = enumerate(4, [1, 2, 3], { budget: 600000 });
  const target = full.entries[7];
  const pruned = enumerate(4, [1, 2, 3], {
    clue: { rows: target.rows, cols: target.cols },
    budget: 600000,
  });
  ok(pruned.entries.length <= full.entries.length, 'a filter can only shrink');
  for (const e of pruned.entries) {
    eq(e.rows.join(','), target.rows.join(','), 'every survivor matches the clue rows');
    eq(e.cols.join(','), target.cols.join(','));
  }
  eq(pruned.entries.some((e) => e.cells.join(',') === target.cells.join(',')), true,
    'the arrangement the clue was taken from must survive');
});

test('a bounded table says so instead of saying no', () => {
  const t = enumerate(4, [1, 2, 3], { budget: 10 });
  eq(t.truncated, true);
  eq(t.entries.length, 10, 'the budget is the number of entries it managed to record');
  const p = chartsOf(enumerate(4, [2], { budget: 600000 }))[0];
  const fallback = countByTable(p, { budget: 5, limit: 2 });
  eq(fallback.route, 'clue-first enumeration',
    'a table too small to finish falls back to the other memory profile, not to silence');
  eq(fallback.count, solve(p, { limit: 2 }).count);
});

// --- the reconciliation ---------------------------------------------------------------------

function reconcile(n, fleet, stride, opts = {}) {
  const table = tableFor(n, fleet, { budget: opts.budget || 600000 });
  ok(!table.truncated, `the ${n}x${n} [${fleet}] table must be complete to be a second opinion`);
  const checked = [];
  const bad = [];
  for (let i = 0; i < table.entries.length; i++) {
    if (i % stride !== 0) continue;
    const e = table.entries[i];
    const puzzle = { n, fleet: fleet.slice(), rows: e.rows, cols: e.cols };
    const a = solve(puzzle, { limit: 2 });
    const b = countByTable(puzzle, { limit: 2, budget: opts.budget || 600000 });
    checked.push(i);
    if (a.count !== b.count) {
      bad.push(`${puzzle.rows.join('')}|${puzzle.cols.join('')}: solver ${a.count} table ${b.count}`);
      continue;
    }
    if (a.count === 1) {
      const sa = a.solution.cells.join(',');
      const sb = b.solutions[0].slice().sort((x, y) => x - y).join(',');
      if (sa !== sb) bad.push(`${puzzle.rows.join('')}|${puzzle.cols.join('')}: cells ${sa} vs ${sb}`);
    }
  }
  return { checked: checked.length, table: table.entries.length, bad };
}

test('4x4 [1,2,3]: every one of the 176 charts is reconciled on both routes', () => {
  const r = reconcile(4, [1, 2, 3], 1);
  eq(r.table, 176);
  eq(r.checked, 176, 'a 4x4 sweep is 20ms, so there is no excuse for sampling it');
  eq(r.bad, []);
});

test('4x4 [1,1]: the deduped-submarine charts are reconciled too', () => {
  const r = reconcile(4, [1, 1], 1);
  eq(r.checked, 78);
  eq(r.bad, [], 'equal-length fleets must not confuse the second route either');
});

test('5x5 [2,3,4]: one chart in five reconciles (151 of 752, 20.1%)', () => {
  const r = reconcile(5, [2, 3, 4], 5);
  eq(r.table, 752);
  eq(r.checked, 151, 'stride 5 over 752 entries = ceil(752/5)');
  eq(r.bad, []);
});

test('6x6 [2,3,4,5]: one chart in a hundred reconciles (62 of 6144, 1.0%)', () => {
  const r = reconcile(6, [2, 3, 4, 5], 100);
  eq(r.table, 6144);
  eq(r.checked, 62);
  eq(r.bad, []);
});

test('the table cache is a cache: same numbers, and clearTables rebuilds', () => {
  const a = tableFor(4, [1, 2, 3], { budget: 600000 });
  const b = tableFor(4, [1, 2, 3], { budget: 600000 });
  ok(a === b, 'a second request must be the same object');
  clearTables();
  const c = tableFor(4, [1, 2, 3], { budget: 600000 });
  ok(c !== a, 'after a clear the table is rebuilt');
  eq(c.entries.length, a.entries.length);
});

test('enumeration does not mutate the fleet or the clue it was handed', () => {
  const fleet = [1, 2, 3];
  const clue = { rows: [0, 3, 1, 2], cols: [3, 0, 2, 1] };
  const before = JSON.stringify({ fleet, clue });
  enumerate(4, fleet, { clue, budget: 600000 });
  countByTable({ n: 4, fleet, rows: clue.rows, cols: clue.cols }, { budget: 600000 });
  eq(JSON.stringify({ fleet, clue }), before);
});

run();
