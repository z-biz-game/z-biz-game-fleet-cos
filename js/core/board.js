// The cell grid: what one square of the chart currently is.
//
// Four states, not three. `ship | water | unknown` is the model the rules speak about;
// the fourth one (`mark`, drawn as a '?') is a pencil annotation the player puts on an
// unknown square to say "a hull could sit here, I have not decided". Rules and solver
// treat MARK exactly like UNKNOWN — see `isFillable()` — which is what lets the validator
// and the counter ignore it without a special case in every one of their branches.
//
// Everything in this file is a pure function over `{ n, cells }` where `cells` is a
// Uint8Array of n*n entries in row-major order. No DOM, no window.

export const UNKNOWN = 0;
export const WATER = 1;
export const SHIP = 2;
export const MARK = 3;

// The eight neighbours, including the four diagonals. The diagonal half of this table is
// the whole reason the rules in rules.js are what they are: in Battleship Solitaire two
// ships that merely touch at a corner are still two ships in the same water, so a single
// known hull cell rules out a 3x3 block, not a 5x1 cross.
export const NEIGHBOURS8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

// serialize()/parse() alphabet. `.` is an undecided square so a dump of an empty board
// reads as a grid of dots rather than as a grid of question marks about question marks.
const GLYPH = ['.', '~', '#', '?'];
const CODE = { '.': UNKNOWN, '~': WATER, '#': SHIP, '?': MARK };

export function createBoard(n, state = UNKNOWN) {
  const cells = new Uint8Array(n * n);
  if (state !== UNKNOWN) cells.fill(state);
  return { n, cells };
}

export function idx(n, x, y) {
  return y * n + x;
}

export function inside(n, x, y) {
  return x >= 0 && y >= 0 && x < n && y < n;
}

export function get(board, x, y) {
  return inside(board.n, x, y) ? board.cells[y * board.n + x] : undefined;
}

// Mutating on purpose: the solver hot-loop would allocate a grid per deduction otherwise.
// Callers that must not disturb the caller's board clone first (`cloneBoard`).
export function set(board, x, y, state) {
  if (!inside(board.n, x, y)) return false;
  board.cells[y * board.n + x] = state;
  return true;
}

export function cloneBoard(board) {
  return { n: board.n, cells: Uint8Array.from(board.cells) };
}

export function sameBoard(a, b) {
  if (a.n !== b.n) return false;
  for (let i = 0; i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) return false;
  return true;
}

// A hull is a straight segment: `{ x, y, len, axis }` with axis 'h' or 'v', anchored at
// its top-left cell. `cells` is the one place that knows how to walk it, so an out-of-axis
// len or a negative coordinate cannot leak a half-shaped ship into the validators.
export function hullCells(hull) {
  const out = [];
  if (!hull || !Number.isInteger(hull.len) || hull.len < 1) return out;
  if (hull.axis !== 'h' && hull.axis !== 'v') return out;
  if (!Number.isInteger(hull.x) || !Number.isInteger(hull.y)) return out;
  for (let k = 0; k < hull.len; k++) {
    out.push(hull.axis === 'h' ? [hull.x + k, hull.y] : [hull.x, hull.y + k]);
  }
  return out;
}

export function hullCellsIndexed(n, hull) {
  const out = [];
  for (const [x, y] of hullCells(hull)) {
    if (!inside(n, x, y)) return null;
    out.push(idx(n, x, y));
  }
  return out;
}

export function paintHulls(n, hulls, board = createBoard(n)) {
  for (const h of hulls) {
    for (const [x, y] of hullCells(h)) set(board, x, y, SHIP);
  }
  return board;
}

// Ship cells per row and per column — the quantity a clue counts.
export function shipCounts(board) {
  const { n, cells } = board;
  const rows = new Array(n).fill(0);
  const cols = new Array(n).fill(0);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (cells[y * n + x] !== SHIP) continue;
      rows[y] += 1;
      cols[x] += 1;
    }
  }
  return { rows, cols };
}

export function countState(board, state) {
  let c = 0;
  for (let i = 0; i < board.cells.length; i++) if (board.cells[i] === state) c++;
  return c;
}

export function cellsInState(board, state) {
  const out = [];
  for (let i = 0; i < board.cells.length; i++) if (board.cells[i] === state) out.push(i);
  return out;
}

// The hulls a grid of ship cells describes, as maximal straight runs, scanned in row-major
// order. There is deliberately no "is this an L?" test here: a bent drawing splits into two
// runs that touch, and `rules.firstContact` — the same check that governs two real ships —
// rejects it. One rule, one place that implements it.
export function hullsOf(board) {
  const { n, cells } = board;
  const used = new Uint8Array(n * n);
  const hulls = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (cells[i] !== SHIP || used[i]) continue;
      const right = x + 1 < n && cells[i + 1] === SHIP;
      const down = y + 1 < n && cells[i + n] === SHIP;
      if (right) {
        let e = x + 1;
        while (e + 1 < n && cells[y * n + e + 1] === SHIP) e++;
        for (let k = x; k <= e; k++) used[y * n + k] = 1;
        hulls.push({ x, y, len: e - x + 1, axis: 'h' });
      } else if (down) {
        let e = y + 1;
        while (e + 1 < n && cells[(e + 1) * n + x] === SHIP) e++;
        for (let k = y; k <= e; k++) used[k * n + x] = 1;
        hulls.push({ x, y, len: e - y + 1, axis: 'v' });
      } else {
        used[i] = 1;
        hulls.push({ x, y, len: 1, axis: 'h' });
      }
    }
  }
  return hulls;
}

export function serialize(board) {
  const { n, cells } = board;
  const lines = [];
  for (let y = 0; y < n; y++) {
    let s = '';
    for (let x = 0; x < n; x++) s += GLYPH[cells[y * n + x]];
    lines.push(s);
  }
  return lines.join('/');
}

export function parseBoard(n, text) {
  const parts = String(text).split('/');
  const board = createBoard(n);
  if (parts.length !== n) return null;
  for (let y = 0; y < n; y++) {
    if (parts[y].length !== n) return null;
    for (let x = 0; x < n; x++) {
      const c = CODE[parts[y][x]];
      if (c === undefined) return null;
      board.cells[y * n + x] = c;
    }
  }
  return board;
}

// A board is "resolved" when nothing is left to the player's judgement. MARK counts as
// unresolved because a pencil mark is not a statement about the water.
export function isResolved(board) {
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === UNKNOWN || board.cells[i] === MARK) return false;
  }
  return true;
}

export function summarize(board) {
  const cells = serialize(board).replace(/\//g, '|');
  return { n: board.n, cells, ships: countState(board, SHIP) };
}
