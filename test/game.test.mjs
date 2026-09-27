// A play session: what counts as a move, what is refused, and what the shell is allowed to
// read out of it. The certified navy is the one from test/fixture.test.mjs fixture 1, drawn by
// hand here as a sequence of gestures so the assertions stay paper-checkable:
//
//   3v (0,1)-(0,3) | 2h (2,1)-(3,1) | 1 at (2,3)   on a 4x4, clues
//   rows [0,3,1,2] cols [3,0,2,1]
//
// Read as a grid (`#` hull, `~` water), that navy is
//
//   ~~~~      y0: nothing afloat
//   #~##      y1: (0,1) from the 3-hull, (2,1)(3,1) from the 2-hull
//   #~~~      y2: (0,2)
//   #~#~      y3: (0,3) and the submarine at (2,3)
//
// which is the string the assertions below compare against. Five of them used to carry
// hand-written expectations that did not describe this board (a 4x6 grid of dots, a
// separator-less 16-character dump, two error codes no file emits, and a refusal at a square
// where the rules accept the hull). They were wrong, not the code: see the notes on each line.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  createGame, cellState, boardOf, placeHull, liftHull, hullAt, undo, resetGame, markWater,
  cycleMark, tapPlace, statusOf, fleetLeft, checkDone, progress, dumpGame, restoreGame,
} from '../js/core/game.js';
import { UNKNOWN, WATER, SHIP, MARK, serialize, summarize } from '../js/core/board.js';
import { LOTS } from '../js/data/lots.js';

const LOT = {
  id: 'hand-fixture-1',
  tier: 'harbour',
  n: 4,
  fleet: [1, 2, 3],
  rows: [0, 3, 1, 2],
  cols: [3, 0, 2, 1],
  cells: [4, 6, 7, 8, 12, 14],
};

test('a fresh game is all unknown and nothing is claimed', () => {
  const g = createGame(LOT);
  eq([g.n, g.done, g.marks, g.errors], [4, false, 0, 0]);
  eq(g.hulls, []);
  eq(cellState(g, 0, 0), UNKNOWN);
  // Four rows of four dots: sixteen undecided squares, and `serialize` separates rows with '/'.
  // The literal here used to be four rows of *six* dots, which is a 4x6 chart no n=4 board
  // can print whatever the implementation did.
  eq(serialize(boardOf(g)), '..../..../..../....');
  eq(fleetLeft(g), [1, 2, 3]);
});

test('drawing the certified navy and then the water finishes the chart', () => {
  const g = createGame(LOT);
  eq(placeHull(g, 0, 1, 3, 'v').ok, true);
  eq(cellState(g, 0, 2), SHIP);
  eq(fleetLeft(g), [1, 2]);
  eq(placeHull(g, 2, 1, 2, 'h').ok, true);
  eq(fleetLeft(g), [1]);
  eq(checkDone(g), false, 'six hull squares on a sixteen-square chart is not yet a finished board');
  eq(placeHull(g, 2, 3, 1, 'h').ok, true);
  eq(fleetLeft(g), [], 'the dock is empty');
  eq(checkDone(g), false, 'the water still has to be marked - the standard convention');
  // Every remaining square now sits on a line that has met its clue, so all ten are water.
  let marked = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (markWater(g, x, y)) marked += 1;
  eq(marked, 10, 'the six hull squares are not water, the rest are');
  eq(progress(g).done, true);
  // The dump above, read straight off the navy this test just drew. The expectation here used
  // to be '~#~~~###~#..~#~#~#'.replace(/g/g, ''): no row separators, and a '.' the alphabet has
  // no glyph for once every square is settled - it could not have matched any board.
  eq(serialize(boardOf(g)), '~~~~/#~##/#~~~/#~#~', 'the finished grid, read by hand');
});

test('an illegal hull is refused, counted, and leaves no trace on the board', () => {
  const g = createGame(LOT);
  placeHull(g, 0, 1, 3, 'v');
  const before = serialize(boardOf(g));
  eq(placeHull(g, 1, 1, 2, 'h'), { ok: false, code: 'contact' });
  eq(g.errors, 1, 'the refusal is counted so the UI can shake');
  eq(serialize(boardOf(g)), before, 'an illegal drop must not half-draw anything');
  eq(g.hulls.length, 1);
  eq(placeHull(g, 0, 2, 2, 'h'), { ok: false, code: 'overlap' });
  // (3,0)+(4,0) leaves the chart: rules.js calls that ERRORS.bounds, whose string is
  // 'outOfBounds'. This line asked for 'bounds', a code nothing in the repo emits.
  eq(placeHull(g, 3, 0, 2, 'h'), { ok: false, code: 'outOfBounds' });
  eq(placeHull(g, 1, 1, 4, 'h'), { ok: false, code: 'fleet' }, 'no 4-hull in this navy');
  eq(g.errors, 4);
  eq(g.hulls.length, 1, 'four refusals, one hull');
});

test('the fleet cannot be overdrawn: a second 2-hull is a fleet error', () => {
  const g = createGame(LOT);
  placeHull(g, 0, 1, 3, 'v');
  placeHull(g, 2, 1, 2, 'h');
  eq(placeHull(g, 0, 0, 2, 'h'), { ok: false, code: 'fleet' });
  eq(fleetLeft(g), [1]);
});

test('water is only markable where no clue still needs a square', () => {
  const g = createGame(LOT);
  // Row 0 and column 1 both read 0, so their crossing is closed water from the start.
  eq(markWater(g, 1, 0), true);
  eq(cellState(g, 1, 0), WATER);
  eq(markWater(g, 1, 0), false, 'marking the same square twice is not a second move');
  // (1,1) sits on row 1 (clue 3, empty) - a stray click there must not black in a possible hull.
  eq(markWater(g, 1, 1), false);
  eq(cellState(g, 1, 1), UNKNOWN);
  placeHull(g, 0, 1, 3, 'v');
  placeHull(g, 2, 1, 2, 'h');
  placeHull(g, 2, 3, 1, 'h');
  eq(markWater(g, 1, 2), true, 'row 2 and column 1 are both satisfied now');
  eq(markWater(g, 3, 2), true, 'column 3 holds its single square, row 2 has two');
});

test('a pencil mark is not a claim about the water', () => {
  const g = createGame(LOT);
  eq(cycleMark(g, 3, 3), true);
  eq(cellState(g, 3, 3), MARK);
  eq(g.marks, 1);
  eq(cycleMark(g, 3, 3), true);
  eq(cellState(g, 3, 3), UNKNOWN);
  eq(g.marks, 0);
  placeHull(g, 0, 1, 3, 'v');
  cycleMark(g, 2, 1);
  eq(cellState(g, 2, 1), MARK);
  placeHull(g, 2, 1, 2, 'h');
  eq(cellState(g, 2, 1), SHIP, 'a keel laid over a "?" settles the question');
  eq(g.marks, 0);
});

test('undo and lift walk the session back exactly', () => {
  const g = createGame(LOT);
  placeHull(g, 0, 1, 3, 'v');
  placeHull(g, 2, 1, 2, 'h');
  markWater(g, 1, 0);
  eq(undo(g), true);
  eq(cellState(g, 1, 0), UNKNOWN, 'undo of a water mark');
  eq(undo(g), true);
  eq(g.hulls.length, 1);
  eq(undo(g), true);
  eq(g.hulls.length, 0);
  eq(undo(g), false, 'nothing left to undo');
  placeHull(g, 0, 1, 3, 'v');
  placeHull(g, 2, 1, 2, 'h');
  eq(hullAt(g, 3, 1), 1, 'the second hull owns (3,1)');
  eq(liftHull(g, 3, 1), true);
  eq(g.hulls.length, 1);
  eq(liftHull(g, 3, 1), false, 'nothing there to lift');
  resetGame(g);
  eq([g.hulls.length, g.marks, g.errors], [0, 0, 0]);
});

test('a tap lays the shortest hull still in the dock, which is how a submarine is drawn', () => {
  const g = createGame(LOT);
  eq(tapPlace(g, 2, 3), { ok: true, hull: { x: 2, y: 3, len: 1, axis: 'h' } });
  eq(cellState(g, 2, 3), SHIP);
  eq(fleetLeft(g), [2, 3]);
  // tapPlace takes `Math.min(...remainingFleet)`, so with [2,3] afloat-able it lays the 2-hull -
  // and (2,1)+(3,1) is a legal drop here (nothing is adjacent, the dock holds a 2). This line
  // used to expect {ok:false, code:'fleet'}, a verdict tapPlace can only ever return on an
  // *empty* dock: it picks its length out of remainingFleet, so that length is always in it.
  eq(tapPlace(g, 2, 1), { ok: true, hull: { x: 2, y: 1, len: 2, axis: 'h' } }, 'the shortest hull in the dock, not the longest');
  eq(fleetLeft(g), [3]);
  eq(g.hulls.length, 2, 'both taps counted');
  placeHull(g, 0, 1, 3, 'v');
  eq(tapPlace(g, 1, 1), { ok: false, code: 'fleet' }, 'the dock is empty once the navy is afloat');
  eq(g.hulls.length, 3, 'and the refusal laid nothing');
});

test('statusOf reports exceeded lines that must not be counted as satisfied', () => {
  const g = createGame(LOT);
  // Column 0 wants three; the 3-hull delivers exactly three and column 1 stays at zero.
  placeHull(g, 0, 1, 3, 'v');
  const st = statusOf(g);
  eq(st.cols.map((c) => c.have), [3, 0, 0, 0]);
  eq(st.cols[0], { i: 0, clue: 3, have: 3, full: true, over: false });
  eq(st.rows[1], { i: 1, clue: 3, have: 1, full: false, over: false });
  const p = progress(g);
  eq([p.hulls, p.marks, p.errors, p.over, p.done], [1, 0, 0, 0, false]);
  eq(p.fleetLeft, [1, 2]);
});

test('an exceeded clue still reports over, and the over count is what the UI refuses to add', () => {
  const g = createGame(LOT);
  placeHull(g, 0, 1, 3, 'v');
  placeHull(g, 2, 1, 2, 'h');
  // The last 1-hull may legally go to (3,3) - `canPlaceHull` weighs bounds, overlap, contact and
  // the navy, and never reads a clue - but column 3 already holds the one square its clue asks
  // for, so the line comes back `over` while still reading `full`. The (1,3) this test used to
  // try is in diagonal contact with the 3-hull's (0,3), and the dock still held a 1-hull, so
  // 'fleet' was the wrong verdict twice over - and the two tallies below it were read off a
  // board this test had never built.
  eq(placeHull(g, 3, 3, 1, 'h'), { ok: true, hull: { x: 3, y: 3, len: 1, axis: 'h' } });
  const st = statusOf(g);
  eq(st.rows.map((r) => r.have), [0, 3, 1, 2], 'every row now holds its number');
  eq(st.rows.map((r) => r.full), [true, true, true, true]);
  eq(st.rows.map((r) => r.over), [false, false, false, false]);
  eq(st.cols.map((c) => c.have), [3, 0, 1, 2]);
  eq(st.cols.map((c) => c.over), [false, false, false, true]);
  eq(st.cols[3], { i: 3, clue: 1, have: 2, full: true, over: true }, 'full and over at once');
  eq(progress(g).over, 1, 'one line is running over, and the panel says so');
  eq(progress(g).done, false, 'a chart with an over-running line is not finished');
  eq(progress(g).errors, 0, 'a legal drop that overshoots is not a rule violation');
});

test('a save round-trips: dump the draft, reload it, and the session comes back identical', () => {
  const g = createGame(LOT);
  placeHull(g, 0, 1, 3, 'v');
  placeHull(g, 2, 1, 2, 'h');
  eq(markWater(g, 1, 0), true, 'row 0 and column 1 both read 0, so that square is closed water');
  eq(cycleMark(g, 3, 3), true);
  const text = dumpGame(g);
  // Read off the board: 3v down column 0 from y1, 2h across (2,1)-(3,1), water at (1,0),
  // a pencil '?' at (3,3), and nothing else settled.
  eq(text, '.~../#.##/#.../#..?');
  eq(summarize(boardOf(g)), { n: 4, cells: text.replace(/\//g, '|'), ships: 5 }, 'the compact form is the same grid');

  const back = createGame(LOT);
  ok(restoreGame(back, text), 'the draft loads');
  eq(dumpGame(back), text, 'restored grid == saved grid');
  eq(back.hulls, [{ x: 0, y: 1, len: 3, axis: 'v' }, { x: 2, y: 1, len: 2, axis: 'h' }],
    'hulls come back as hulls, not as six loose ship squares');
  eq(back.marks, 2, 'the water and the pencil mark are still annotations');
  eq([back.done, back.errors], [false, 0]);
  eq(restoreGame(createGame(LOT), text.replace(/\//g, '|')) === null, false,
    'the | separated shape board.summarize prints loads too');
  eq(restoreGame(back, 'not a chart at all'), null, 'junk is refused...');
  eq(dumpGame(back), text, '...and leaves the session alone');

  // A finished chart restores as finished, which is what tells the shell to drop the draft.
  const full = createGame(LOT);
  placeHull(full, 0, 1, 3, 'v');
  placeHull(full, 2, 1, 2, 'h');
  placeHull(full, 2, 3, 1, 'h');
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) markWater(full, x, y);
  eq(dumpGame(full), '~~~~/#~##/#~~~/#~#~');
  const revived = createGame(LOT);
  ok(restoreGame(revived, dumpGame(full)));
  eq([revived.done, revived.hulls.length], [true, 3]);
});

test('every shipped lot is winnable by the certified navy through the gesture layer', () => {
  // The pool is only worth shipping if the play model accepts the printed solution: lay the
  // hulls the bake certified, mark the rest water, and the session must report done.
  const hullsOfCells = (n, cells) => {
    const rest = new Set(cells);
    const hulls = [];
    for (const start of cells.slice().sort((a, b) => a - b)) {
      if (!rest.has(start)) continue;
      const x = start % n;
      const y = (start - x) / n;
      for (const axis of ['h', 'v']) {
        const len = [];
        for (let k = 0; ; k++) {
          const cx = axis === 'h' ? x + k : x;
          const cy = axis === 'h' ? y : y + k;
          if (cx >= n || cy >= n || !rest.has(cy * n + cx)) break;
          len.push(cy * n + cx);
        }
        if (len.length >= 2) {
          for (const c of len) rest.delete(c);
          hulls.push({ x, y, len: len.length, axis });
          break;
        }
      }
      if (rest.has(start)) {
        rest.delete(start);
        hulls.push({ x, y, len: 1, axis: 'h' });
      }
    }
    return hulls;
  };
  const sample = LOTS.filter((l, i) => i % 7 === 0);
  let failures = 0;
  for (const lot of sample) {
    const g = createGame(lot);
    for (const h of hullsOfCells(lot.n, lot.cells)) {
      const r = placeHull(g, h.x, h.y, h.len, h.axis);
      if (!r || !r.ok) failures += 1;
    }
    for (let y = 0; y < lot.n; y++) for (let x = 0; x < lot.n; x++) markWater(g, x, y);
    if (!progress(g).done) failures += 1;
  }
  ok(sample.length >= 14, `${sample.length} sampled lots is too thin a sweep to mean anything`);
  eq(failures, 0, `${sample.length} sampled lots must all be winnable by their printed navy`);
});

run();
