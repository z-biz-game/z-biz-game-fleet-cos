// The validator, one negative per rule. Six independent ways to be wrong, and each is
// triggered on its own with hand-written expectations: a fused "invalid" boolean would let
// five of the six ride on the sixth.
//
// Coordinates are (x, y) from the top-left; `idx = y * n + x`. The 4x4 boards below are
// drawn by hand.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  ERRORS, clueSums, cluesConsistent, sanePuzzle, validate, canPlaceHull, remainingFleet,
  clueStatus, isSolved, firstOutOfBounds, firstOverlap, firstContact, fleetMismatch,
  mismatchingLines,
} from '../js/core/rules.js';
import { createBoard, set, paintHulls, hullsOf, SHIP, WATER, UNKNOWN } from '../js/core/board.js';

const P4 = { n: 4, fleet: [1, 2, 3], rows: [0, 3, 1, 2], cols: [3, 0, 2, 1] };
const LEGAL = [
  { x: 0, y: 1, len: 3, axis: 'v' },
  { x: 2, y: 1, len: 2, axis: 'h' },
  { x: 2, y: 3, len: 1, axis: 'h' },
];

test('the legal hand layout passes every check', () => {
  eq(validate(P4, LEGAL), null);
  eq(firstOutOfBounds(4, LEGAL), -1);
  eq(firstOverlap(4, LEGAL), null);
  eq(firstContact(4, LEGAL), null);
  eq(fleetMismatch(P4.fleet, LEGAL), null);
});

// --- negative 1: out of bounds ------------------------------------------------------------
test('negative 1: a hull running off the chart', () => {
  const hulls = [{ x: 2, y: 0, len: 3, axis: 'h' }]; // cells x 2,3,4 on a 4-wide board
  eq(firstOutOfBounds(4, hulls), 0);
  eq(validate(P4, hulls), { code: ERRORS.bounds, detail: { hull: 0 } });
});

// --- negative 2: overlap ------------------------------------------------------------------
test('negative 2: two hulls on the same square', () => {
  const hulls = [
    { x: 0, y: 1, len: 3, axis: 'v' },
    { x: 0, y: 2, len: 2, axis: 'h' }, // (0,2) already belongs to the first
  ];
  eq(firstOverlap(4, hulls), { i: 1, j: 0, cell: 8 });
  eq(validate(P4, hulls).code, ERRORS.overlap);
});

// --- negative 3: contact, side and corner ---------------------------------------------------
test('two hulls two columns apart are not in contact', () => {
  const hulls = [
    { x: 0, y: 0, len: 2, axis: 'v' }, // cells (0,0),(0,1)
    { x: 2, y: 2, len: 1, axis: 'h' }, // (2,2) is two rows below (0,1) and two columns over
  ];
  eq(firstContact(4, hulls), null);
});

test('negative 3b: two hulls sharing an edge', () => {
  const hulls = [
    { x: 0, y: 0, len: 2, axis: 'v' }, // (0,0),(0,1)
    { x: 1, y: 0, len: 1, axis: 'h' }, // (1,0) - a side neighbour of (0,0)
  ];
  eq(firstContact(4, hulls), { i: 0, j: 1 });
  eq(validate(P4, hulls).code, ERRORS.contact);
});

test('negative 3c: two hulls touching on a corner only', () => {
  const hulls = [
    { x: 0, y: 0, len: 2, axis: 'h' }, // (0,0),(1,0)
    { x: 2, y: 1, len: 1, axis: 'h' }, // (2,1) - diagonal neighbour of (1,0)
  ];
  eq(firstContact(4, hulls), { i: 0, j: 1 });
  eq(validate(P4, hulls).code, ERRORS.contact);
});

test('negative 3d: a corner touch at the left edge is not a row wrap', () => {
  // (0,1) and (3,0) sit next to each other in the flat cell array but two columns apart on
  // the chart. A neighbour test that forgets `inside` reports this as contact.
  const hulls = [
    { x: 0, y: 0, len: 1, axis: 'h' }, // (0,0)
    { x: 3, y: 1, len: 1, axis: 'h' }, // (3,1) - diagonal of (2,0), not of (0,0)
  ];
  eq(firstContact(4, hulls), null, 'row-major wrap must not invent adjacency');
  const other = [
    { x: 0, y: 1, len: 1, axis: 'h' }, // (0,1) = cell 4
    { x: 2, y: 0, len: 1, axis: 'h' }, // (2,0) = cell 2, two columns away
  ];
  eq(firstContact(4, other), null);
});

test('a bent drawing is refused as contact, not as a special case', () => {
  // An L written as two touching runs: the same corner rule that catches two ships catches it.
  const cells = new Uint8Array(16);
  for (const c of [0, 1, 5]) cells[c] = SHIP;
  const runs = hullsOf({ n: 4, cells });
  eq(runs, [{ x: 0, y: 0, len: 2, axis: 'h' }, { x: 1, y: 1, len: 1, axis: 'h' }]);
  eq(firstContact(4, runs), { i: 0, j: 1 });
});

// --- negative 4: row clue ------------------------------------------------------------------
test('negative 4: a row whose hull squares disagree with its clue', () => {
  // 3h (0,1)-(2,1) | 2h (2,3)-(3,3) | 1 at (0,3): the right navy in the wrong place.
  // Hand tally of rows: 0,3,0,3 against clues 0,3,1,2 -> rows 2 and 3 are the offenders
  // (row 2 claims 1 and holds nothing, row 3 claims 2 and holds three).
  const hulls = [
    { x: 0, y: 1, len: 3, axis: 'h' },
    { x: 2, y: 3, len: 2, axis: 'h' },
    { x: 0, y: 3, len: 1, axis: 'h' },
  ];
  const board = paintHulls(4, hulls);
  eq(mismatchingLines(P4, board, 'rows'), [2, 3], 'row 2 claims 1 and holds none');
  eq(validate(P4, hulls).code, ERRORS.rowClue);
  eq(validate(P4, hulls).detail, { lines: [2, 3] });
});

// --- negative 5: column clue ----------------------------------------------------------------
test('negative 5: a column whose hull squares disagree with its clue', () => {
  // 3v (0,1)-(0,3) | 2h (2,1)-(3,1) | 1 at (3,3). Hand tally:
  // rows 0,3,1,2 = the clues exactly, so only the columns can be wrong:
  // cols 3,0,1,2 against clues 3,0,2,1 -> columns 2 and 3 are off.
  const hulls = [
    { x: 0, y: 1, len: 3, axis: 'v' },
    { x: 2, y: 1, len: 2, axis: 'h' },
    { x: 3, y: 3, len: 1, axis: 'h' },
  ];
  const board = paintHulls(4, hulls);
  eq(mismatchingLines(P4, board, 'rows'), [], 'the rows must be clean or this tests nothing');
  eq(mismatchingLines(P4, board, 'cols'), [2, 3]);
  eq(validate(P4, hulls).code, ERRORS.colClue);
});

// --- negative 6: fleet -----------------------------------------------------------------------
test('negative 6: the wrong navy', () => {
  eq(fleetMismatch([1, 2, 3], [{ x: 0, y: 0, len: 3, axis: 'h' }]).have, [3], 'a missing 1 and 2');
  eq(fleetMismatch([1, 2, 3], [
    { x: 0, y: 0, len: 2, axis: 'h' },
    { x: 0, y: 2, len: 2, axis: 'h' },
    { x: 2, y: 3, len: 2, axis: 'h' },
  ]), { need: [1, 2, 3], have: [2, 2, 2] }, 'three 2s is not one 1, one 2 and one 3');
  const hulls = [
    { x: 0, y: 1, len: 3, axis: 'v' },
    { x: 2, y: 1, len: 2, axis: 'v' },
  ];
  eq(validate(P4, hulls).code, ERRORS.fleet);
});

test('check order: the loudest mistake wins', () => {
  // A hull off the board is also, technically, a fleet and clue mismatch.
  const hulls = [{ x: 3, y: 0, len: 3, axis: 'h' }];
  eq(validate(P4, hulls).code, ERRORS.bounds);
});

// --- the arithmetic gate ----------------------------------------------------------------------
test('clue sums and the sanity gate', () => {
  eq(clueSums(P4), { rows: 6, cols: 6, fleet: 6 });
  ok(cluesConsistent(P4));
  eq(clueSums({ ...P4, rows: [0, 3, 1, 1] }), { rows: 5, cols: 6, fleet: 6 });
  eq(sanePuzzle({ ...P4, rows: [0, 3, 1, 1] }), 'clue sums disagree with the fleet');
  eq(sanePuzzle({ ...P4, cols: [3, 0, 2] }), 'cols length');
  eq(sanePuzzle({ ...P4, cols: [3, 0, 2, 5] }), 'cols value');
  eq(sanePuzzle({ ...P4, fleet: [0, 3, 3] }), 'hull length');
  eq(sanePuzzle({ n: 3, fleet: [4], rows: [1, 1, 1], cols: [1, 1, 1] }), 'hull length');
  eq(sanePuzzle(P4), null);
});

// --- what a tap asks ----------------------------------------------------------------------------
test('canPlaceHull: single-step legality only, never a search', () => {
  eq(canPlaceHull(P4, [], LEGAL[0]), null);
  eq(canPlaceHull(P4, [LEGAL[0]], LEGAL[1]), null);
  eq(canPlaceHull(P4, [LEGAL[0], LEGAL[1]], LEGAL[2]), null);
  eq(canPlaceHull(P4, [], LEGAL[0]), null);
  eq(canPlaceHull(P4, [LEGAL[0]], { x: 0, y: 2, len: 2, axis: 'h' }), ERRORS.overlap);
  eq(canPlaceHull(P4, [LEGAL[0]], { x: 1, y: 1, len: 2, axis: 'h' }), ERRORS.contact);
  eq(canPlaceHull(P4, [], { x: 3, y: 0, len: 2, axis: 'h' }), ERRORS.bounds);
  eq(canPlaceHull(P4, [], { x: 0, y: 0, len: 4, axis: 'h' }), ERRORS.fleet, 'no 4-hull in a [1,2,3] navy');
  eq(canPlaceHull(P4, [LEGAL[0], LEGAL[1]], { x: 1, y: 0, len: 2, axis: 'h' }), ERRORS.fleet,
    'the 2-hull is already afloat, and the fleet check comes before the geometry check');
  eq(canPlaceHull(P4, [], { x: 0, y: 0, len: 1, axis: 'h' }), null);
});

test('remainingFleet counts duplicates against occurrences, not against lengths', () => {
  eq(remainingFleet([1, 1, 2], [{ x: 0, y: 0, len: 1, axis: 'h' }]), [1, 2]);
  eq(remainingFleet([1, 1, 2], []), [1, 1, 2]);
  eq(remainingFleet([2, 2], [{ x: 0, y: 0, len: 2, axis: 'h' }]), [2]);
});

test('clueStatus: satisfied, exceeded and the zero line', () => {
  const board = createBoard(4, WATER);
  set(board, 0, 1, SHIP);
  set(board, 0, 2, SHIP);
  set(board, 0, 3, SHIP);
  const st = clueStatus(P4, board);
  // One square of the 3-hull per row: rows hold 0,1,1,1 against clues 0,3,1,2.
  eq(st.rows.map((r) => `${r.clue}/${r.have}`).join(' '), '0/0 3/1 1/1 2/1');
  eq(st.rows[1].full, false);
  eq(st.rows[3].full, false);
  eq(st.rows[0].full, true, 'a 0 clue is satisfied the moment the line is drawn');
  eq(st.cols[0], { i: 0, clue: 3, have: 3, full: true, over: false });
  const over = createBoard(4, WATER);
  for (let x = 0; x < 4; x++) set(over, x, 0, SHIP);
  eq(clueStatus(P4, over).rows[0], { i: 0, clue: 0, have: 4, full: true, over: true });
});

test('isSolved: a complete legal board, and nothing less', () => {
  // The convention, and it is the standard one: the chart is only finished when every square
  // is decided, so a player who has laid the whole navy still has to mark the water.
  const won = createBoard(4, WATER);
  for (const h of LEGAL) {
    for (let k = 0; k < h.len; k++) {
      set(won, h.axis === 'h' ? h.x + k : h.x, h.axis === 'h' ? h.y : h.y + k, SHIP);
    }
  }
  eq(isSolved(P4, won), true, 'ships plus water everywhere = solved');
  eq(isSolved(P4, paintHulls(4, LEGAL)), false, 'ships alone leave unknown squares');
  const blank = createBoard(4, UNKNOWN);
  eq(isSolved(P4, blank), false, 'an empty chart is not solved');
  const holes = paintHulls(4, LEGAL.slice(0, 2));
  eq(isSolved(P4, holes), false, 'an unresolved square is not solved');
  eq(isSolved(P4, paintHulls(4, [LEGAL[0], LEGAL[1]])), false);
});

test('rules do not mutate their arguments', () => {
  const before = JSON.stringify(P4);
  const hulls = LEGAL.map((h) => ({ ...h }));
  const beforeHulls = JSON.stringify(hulls);
  validate(P4, hulls);
  clueStatus(P4, paintHulls(4, hulls));
  canPlaceHull(P4, hulls, { x: 2, y: 3, len: 1, axis: 'h' });
  mismatchingLines(P4, paintHulls(4, hulls), 'rows');
  eq(JSON.stringify(P4), before);
  eq(JSON.stringify(hulls), beforeHulls);
});

run();
