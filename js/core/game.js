// One play session: the hulls afloat, the annotations the player made, and what the clues
// say about them right now.
//
// This is the only place player state is mutated, and it is still a pure-JS module with no
// DOM in it — `js/view.js` hands over cells and this file decides whether a mark or a hull
// may go there. Two consequences that matter for the rest of the repo:
//
//   * Every mutator returns null on refusal, so the shell can tell "the player pressed the
//     water" from "the move counted". An illegal hull is *not* recorded and bumps `errors`.
//   * The board the rules speak about is derived (`boardOf`) from two layers: `notes`
//     (water / '?') and `hulls`. A hull is never smeared into the grid, so lifting one
//     cannot leave a phantom square behind, and undo is one array push.

import {
  UNKNOWN, WATER, SHIP, MARK, idx, inside, hullCells, serialize, parseBoard, hullsOf,
} from './board.js';
import { canPlaceHull, clueStatus, isSolved, remainingFleet } from './rules.js';

const HISTORY = 120;

export function createGame(lot) {
  const n = lot.n;
  return {
    lot,
    puzzle: { n, fleet: lot.fleet.slice(), rows: lot.rows.slice(), cols: lot.cols.slice() },
    n,
    notes: new Uint8Array(n * n),
    hulls: [],
    history: [],
    marks: 0,
    errors: 0,
    done: false,
  };
}

export function cellState(game, x, y) {
  if (!inside(game.n, x, y)) return undefined;
  const i = idx(game.n, x, y);
  for (let k = 0; k < game.hulls.length; k++) {
    const cells = hullCells(game.hulls[k]);
    if (cells.some(([cx, cy]) => cx === x && cy === y)) return SHIP;
  }
  return game.notes[i];
}

// The grid the rules read. O(n^2 + hulls) per call, which at n <= 8 is cheaper to call
// than to cache correctly.
export function boardOf(game) {
  const { n, notes, hulls } = game;
  const cells = Uint8Array.from(notes);
  for (const h of hulls) {
    for (const [x, y] of hullCells(h)) {
      if (inside(n, x, y)) cells[idx(n, x, y)] = SHIP;
    }
  }
  return { n, cells };
}

function remember(game) {
  game.history.push({ hulls: game.hulls.slice(), notes: Uint8Array.from(game.notes), marks: game.marks });
  if (game.history.length > HISTORY) game.history.shift();
}

export function undo(game) {
  const prev = game.history.pop();
  if (!prev) return false;
  game.hulls = prev.hulls;
  game.notes = prev.notes;
  game.marks = prev.marks;
  game.done = false;
  return true;
}

export function resetGame(game) {
  game.hulls = [];
  game.notes = new Uint8Array(game.n * game.n);
  game.history = [];
  game.marks = 0;
  game.errors = 0;
  game.done = false;
  return game;
}

// What the shell writes into `store.saveProgress`: the settled grid, in the same alphabet the
// data file and the tests use, so a save is reviewable with the same eyes as a fixture.
export function dumpGame(game) {
  return serialize(boardOf(game));
}

// The reload half of that. Ship squares are re-read as hulls with `board.hullsOf`, which is
// exact here for the one reason the diagonal rule exists: two hulls may never touch, so a
// maximal straight run of ship cells *is* one hull and a save cannot merge two of them.
// Pencil marks and water come back as notes; anything that is neither comes back undecided.
// '|' row separators are tolerated too (board.summarize prints that shape). Garbage returns
// null rather than a half-restored chart.
export function restoreGame(game, text) {
  const board = parseBoard(game.n, String(text).replace(/\|/g, '/'));
  if (!board) return null;
  remember(game);
  game.notes = Uint8Array.from(board.cells, (v) => (v === SHIP ? UNKNOWN : v));
  game.hulls = hullsOf(board);
  game.marks = countNotes(game);
  game.errors = 0;
  game.done = checkDone(game);
  return game;
}

// Lay a hull. `len` cells from (x, y) along `axis`. Refusals return the rule code so the
// hint line can name the reason instead of just going quiet.
export function placeHull(game, x, y, len, axis) {
  if (game.done) return null;
  const hull = { x, y, len, axis };
  const code = canPlaceHull(game.puzzle, game.hulls, hull);
  if (code) {
    game.errors += 1;
    game.done = checkDone(game);
    return { ok: false, code };
  }
  remember(game);
  game.hulls.push(hull);
  // Squares the hull settles on must stop carrying a pencil mark: a stale '?' under a
  // keel would make the board read as unresolved forever.
  for (const [cx, cy] of hullCells(hull)) {
    const i = idx(game.n, cx, cy);
    if (game.notes[i] !== UNKNOWN) {
      game.notes[i] = UNKNOWN;
      game.marks = countNotes(game);
    }
  }
  game.done = checkDone(game);
  return { ok: true, hull };
}

export function hullAt(game, x, y) {
  return game.hulls.findIndex((h) => hullCells(h).some(([cx, cy]) => cx === x && cy === y));
}

// Lift the hull under a cell — the gesture for "that one was a mistake".
export function liftHull(game, x, y) {
  const i = hullAt(game, x, y);
  if (i < 0) return false;
  remember(game);
  game.hulls.splice(i, 1);
  game.done = false;
  return true;
}

function countNotes(game) {
  let c = 0;
  for (let i = 0; i < game.notes.length; i++) if (game.notes[i] !== UNKNOWN) c++;
  return c;
}

// Left click: water on a square no clue still needs, nothing elsewhere. A square whose row
// or column has not filled up yet could still hide a hull, so refusing to black it in on a
// stray click is the difference between annotation and vandalism.
export function markWater(game, x, y) {
  if (game.done) return false;
  if (!inside(game.n, x, y)) return false;
  if (hullAt(game, x, y) >= 0) return false;
  const st = clueStatus(game.puzzle, boardOf(game));
  if (!(st.rows[y].full && st.cols[x].full)) return false;
  const i = idx(game.n, x, y);
  if (game.notes[i] === WATER) return false;
  remember(game);
  game.notes[i] = WATER;
  game.marks = countNotes(game);
  game.done = checkDone(game);
  return true;
}

// Right click / long press: the pencil '?' for "a hull could sit here". Cycles back to
// unknown rather than needing a third gesture.
export function cycleMark(game, x, y) {
  if (game.done) return false;
  if (!inside(game.n, x, y)) return false;
  if (hullAt(game, x, y) >= 0) return false;
  const i = idx(game.n, x, y);
  remember(game);
  game.notes[i] = game.notes[i] === MARK ? UNKNOWN : MARK;
  game.marks = countNotes(game);
  return true;
}

// A tap that is not on closed water lays the shortest hull still in the dock. This is how
// a submarine (length 1) gets onto the chart: there is no drag to draw it with.
export function tapPlace(game, x, y) {
  const left = remainingFleet(game.puzzle.fleet, game.hulls);
  if (!left.length) return { ok: false, code: 'fleet' };
  const len = Math.min(...left);
  return placeHull(game, x, y, len, 'h');
}

export function statusOf(game) {
  return clueStatus(game.puzzle, boardOf(game));
}

export function fleetLeft(game) {
  return remainingFleet(game.puzzle.fleet, game.hulls);
}

// Is the chart finished? A wrong-but-complete chart cannot happen: `validate` checks the
// fleet, the contacts and every clue, and solve.js certified that exactly one such chart
// exists before this lot shipped.
export function checkDone(game) {
  return isSolved(game.puzzle, boardOf(game));
}

export function progress(game) {
  const board = boardOf(game);
  const st = clueStatus(game.puzzle, board);
  return {
    hulls: game.hulls.length,
    fleetLeft: fleetLeft(game),
    marks: game.marks,
    errors: game.errors,
    rowsFull: st.rows.filter((r) => r.full).length,
    colsFull: st.cols.filter((c) => c.full).length,
    over: st.rows.filter((r) => r.over).length + st.cols.filter((c) => c.over).length,
    done: game.done,
    dump: serialize(board),
  };
}
