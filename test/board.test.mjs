// The cell model: five states, one hull reader, and the text form the save file and the
// `#/lot/<id>` link both use.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  UNKNOWN, WATER, SHIP, MARK, idx, inside, get, set, createBoard, cloneBoard, sameBoard,
  hullCells, hullCellsIndexed, paintHulls, shipCounts, countState, cellsInState, hullsOf,
  serialize, parseBoard, isResolved,
} from '../js/core/board.js';
import { firstContact, firstOverlap, validate } from '../js/core/rules.js';

function grid(n, spec) {
  const b = createBoard(n, UNKNOWN);
  for (const [key, ch] of Object.entries(spec)) {
    const [x, y] = key.split(',').map(Number);
    set(b, x, y, { '.': UNKNOWN, '~': WATER, '#': SHIP, '?': MARK }[ch]);
  }
  return b;
}

test('states are four distinct codes and the default is unknown', () => {
  eq([UNKNOWN, WATER, SHIP, MARK], [0, 1, 2, 3]);
  const b = createBoard(4);
  eq(countState(b, UNKNOWN), 16);
  eq(countState(b, WATER), 0);
  eq(countState(createBoard(3, WATER), WATER), 9);
});

test('idx and inside agree on a 4x4', () => {
  eq(idx(4, 0, 0), 0);
  eq(idx(4, 3, 0), 3);
  eq(idx(4, 0, 3), 12);
  eq(idx(4, 3, 3), 15);
  eq([inside(4, 0, 0), inside(4, 3, 3), inside(4, 4, 0), inside(4, -1, 2)], [true, true, false, false]);
  eq(get(createBoard(4, WATER), 4, 0), undefined, 'reading off the chart is undefined, not a wrap');
  eq(set(createBoard(4), 9, 9, SHIP), false, 'writing off the chart is refused');
});

test('hullCells walks a segment and refuses a malformed one', () => {
  eq(hullCells({ x: 1, y: 2, len: 3, axis: 'h' }), [[1, 2], [2, 2], [3, 2]]);
  eq(hullCells({ x: 3, y: 0, len: 2, axis: 'v' }), [[3, 0], [3, 1]]);
  eq(hullCells({ x: 0, y: 0, len: 1, axis: 'h' }), [[0, 0]]);
  eq(hullCells({ x: 0, y: 0, len: 0, axis: 'h' }), [], 'a zero-length hull is not a hull');
  eq(hullCells({ x: 0, y: 0, len: 2, axis: 'd' }), [], 'no diagonals in this game');
  eq(hullCells(null), []);
  eq(hullCellsIndexed(4, { x: 3, y: 0, len: 2, axis: 'h' }), null, 'running off the chart yields null');
  eq(hullCellsIndexed(4, { x: 3, y: 0, len: 1, axis: 'h' }), [3]);
});

test('paintHulls and shipCounts: the hand tally a clue is built from', () => {
  const board = paintHulls(4, [
    { x: 0, y: 1, len: 3, axis: 'v' },
    { x: 2, y: 1, len: 2, axis: 'h' },
    { x: 2, y: 3, len: 1, axis: 'h' },
  ]);
  eq(shipCounts(board), { rows: [0, 3, 1, 2], cols: [3, 0, 2, 1] });
  eq(countState(board, SHIP), 6);
  eq(countState(board, UNKNOWN), 10, 'painting ships does not paint the water');
  eq(cellsInState(board, SHIP), [4, 6, 7, 8, 12, 14]);
});

test('hullsOf reads maximal straight runs in row-major order', () => {
  eq(hullsOf(grid(4, { '0,0': '#', '1,0': '#', '2,0': '#' })), [{ x: 0, y: 0, len: 3, axis: 'h' }]);
  eq(hullsOf(grid(4, { '0,0': '#', '0,1': '#', '0,2': '#' })), [{ x: 0, y: 0, len: 3, axis: 'v' }]);
  eq(hullsOf(grid(4, { '2,2': '#' })), [{ x: 2, y: 2, len: 1, axis: 'h' }],
    'a lone square is a 1-hull, and its axis is a formality');
  eq(hullsOf(grid(4, { '0,0': '#', '2,0': '#', '1,1': '#' })), [
    { x: 0, y: 0, len: 1, axis: 'h' },
    { x: 2, y: 0, len: 1, axis: 'h' },
    { x: 1, y: 1, len: 1, axis: 'h' },
  ], 'gaps split runs');
  eq(hullsOf(createBoard(4, WATER)), []);
});

test('a bent drawing splits into two runs that touch, and the corner rule rejects it', () => {
  const bent = grid(4, { '0,0': '#', '1,0': '#', '1,1': '#' });
  eq(hullsOf(bent), [{ x: 0, y: 0, len: 2, axis: 'h' }, { x: 1, y: 1, len: 1, axis: 'h' }]);
  eq(firstContact(4, hullsOf(bent)), { i: 0, j: 1 });
  eq(validate({ n: 4, fleet: [1, 2], rows: [2, 1, 0, 0], cols: [1, 2, 0, 0] }, hullsOf(bent)).code,
    'contact', 'no separate is-it-an-L test exists, and none is needed');
});

test('a plus sign is caught as overlap by the same reader', () => {
  const plus = grid(5, { '1,0': '#', '0,1': '#', '1,1': '#', '2,1': '#', '1,2': '#' });
  const runs = hullsOf(plus);
  eq(runs, [{ x: 1, y: 0, len: 3, axis: 'v' }, { x: 0, y: 1, len: 3, axis: 'h' }],
    'the scan claims the vertical run first because it starts higher');
  eq(firstOverlap(5, runs), { i: 1, j: 0, cell: 6 });
});

test('serialize / parseBoard round-trip every state, and refuse junk', () => {
  const b = grid(3, { '0,0': '#', '1,1': '~', '2,2': '?', '2,0': '#' });
  // Row 0 is (# . #), row 1 (. ~ .), row 2 (. . ?).
  eq(serialize(b), '#.#/.~./..?');
  const back = parseBoard(3, serialize(b));
  ok(sameBoard(back, b), 'a round trip must be exact');
  eq(parseBoard(3, '#./.../~/..'), null, 'a short row is junk');
  eq(parseBoard(3, '#./../...'), null, 'four rows on a 3x3 is junk');
  eq(parseBoard(3, '#./../..='), null, 'an unknown glyph is junk');
  eq(serialize(createBoard(2, WATER)), '~~/~~');
});

test('isResolved treats a pencil mark as an open question', () => {
  eq(isResolved(createBoard(2, WATER)), true);
  eq(isResolved(createBoard(2, UNKNOWN)), false);
  eq(isResolved(grid(2, { '0,0': '?', '0,1': '~', '1,0': '~', '1,1': '#' })), false,
    'a "?" is the player thinking, not a claim about the water');
});

test('cloneBoard and sameBoard: a clone is equal but not shared', () => {
  const a = grid(3, { '0,0': '#' });
  const b = cloneBoard(a);
  ok(sameBoard(a, b));
  set(b, 0, 0, WATER);
  eq(get(a, 0, 0), SHIP, 'writing to the clone must not reach the original');
  eq(sameBoard(a, b), false);
});

run();
