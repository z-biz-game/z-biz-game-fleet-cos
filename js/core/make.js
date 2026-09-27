// Build-time chart making, and the only place a chart is ever *judged*.
//
// A chart is a fleet laid down by a seeded RNG, read back as row/column hull counts. Nothing
// about it is trusted until two things agree: the solver (`solve.js`, clues-first propagation
// with hull-granularity assumptions) says `count === 1`, and the independent brute route
// (`enumerate.js`, which never reads a clue while it builds its table) says the same and names
// the same cells. One leg is a claim; two legs that share no code path are evidence.
//
// Difficulty is not a label anyone chooses. It is `depth` — the deepest assumption stack the
// solver had to use — printed next to the chart. A chart that cannot be finished without
// assumptions is not shipped in the band that promises no assumptions.
//
// All of this runs at build time (tools/bake.mjs). A tap on a cell never searches; see
// js/core/game.js.

import { rngFrom } from './rng.js';
import { paintHulls, shipCounts } from './board.js';
import { sanePuzzle, clueSums, cluesConsistent } from './rules.js';
import { solve } from './solve.js';
import { countByTable } from './enumerate.js';

// Bands, named after what the solver had to do, not after a feeling.
export const BANDS = [
  { key: 'pure', label: '纯推理', min: 0, max: 0, blurb: '零假设：线索与斜角禁入推到底就能收尾' },
  { key: 'guess1', label: '+1 假设', min: 1, max: 1, blurb: '一次假设：推理枯竭一次，栈深 1' },
  { key: 'guess2', label: '+2 假设', min: 2, max: Infinity, blurb: '两次以上假设：栈深 ≥ 2' },
];

// The generation ladder. `n`/`fleet` are what the generator gets, `band` is what the band
// filter accepts, `want` is how many charts bake keeps. Display-side copy lives in
// js/data/lots.js so the UI never imports a generator.
export const TIERS = [
  { key: 'harbour', n: 4, fleet: [1, 2, 3], band: 'pure', want: 16 },
  { key: 'patrol', n: 5, fleet: [2, 3, 4], band: 'pure', want: 16 },
  { key: 'convoy', n: 5, fleet: [1, 2, 3], band: 'guess1', want: 16 },
  { key: 'blockade', n: 6, fleet: [2, 3, 4, 5], band: 'guess1', want: 16 },
  { key: 'sortie', n: 6, fleet: [1, 2, 3, 4], band: 'guess2', want: 16 },
  { key: 'battleline', n: 7, fleet: [2, 3, 4, 5], band: 'guess2', want: 16 },
];

export function bandOf(key) {
  return BANDS.find((b) => b.key === key) || null;
}

// Measured difficulty of a chart, from the solver alone.
export function bandOfDepth(depth) {
  const b = BANDS.find((x) => depth >= x.min && depth <= x.max);
  return b ? b.key : null;
}

// Random legal fleet for one tier. Longest hull first, uniformly over the positions that are
// still open — a rejection sampler, so it can never produce an illegal navy, and every
// rejection is a reason we count rather than a repair we hide.
export function randomFleetPlacement(n, fleet, rand) {
  const order = fleet
    .map((len, i) => ({ len, i }))
    .sort((a, b) => b.len - a.len || a.i - b.i);
  const taken = new Set();
  const banned = new Set();
  const hulls = [];
  for (const { len } of order) {
    const options = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x + len <= n; x++) {
        const cells = [];
        for (let k = 0; k < len; k++) cells.push(y * n + x + k);
        if (cells.some((c) => taken.has(c) || banned.has(c))) continue;
        options.push({ x, y, len, axis: 'h', cells });
      }
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y + len <= n; y++) {
        const cells = [];
        for (let k = 0; k < len; k++) cells.push((y + k) * n + x);
        if (cells.some((c) => taken.has(c) || banned.has(c))) continue;
        if (len === 1) continue; // a one-cell hull has no orientation; the h loop made it
        options.push({ x, y, len, axis: 'v', cells });
      }
    }
    if (!options.length) return null;
    const hull = options[rand.int(options.length)];
    hulls.push({ x: hull.x, y: hull.y, len: hull.len, axis: hull.axis });
    for (const c of hull.cells) taken.add(c);
    const add = (c) => {
      if (!taken.has(c)) banned.add(c);
    };
    for (const c of hull.cells) {
      const x = c % n;
      const y = (c - x) / n;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          add(ny * n + nx);
        }
      }
    }
  }
  return hulls.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (b.len - a.len));
}

// The chart a placement implies: every row and column reports its hull-square count.
export function chartOf(n, fleet, hulls) {
  const { rows, cols } = shipCounts(paintHulls(n, hulls));
  return { n, fleet: fleet.slice(), rows, cols };
}

// verifyChart(puzzle, opts) -> { ok, reason, puzzle, count, depth, guesses, solution, route,
//                                tableCount, sameSolution, seconds, solverMs, enumMs }
// Both legs, every shipped chart. `budget` is forwarded to the enumeration so a caller can see
// the fallback route instead of silently getting a bigger table than the machine wants.
export function verifyChart(puzzle, opts = {}) {
  const bad = sanePuzzle(puzzle);
  if (bad) return { ok: false, reason: 'malformed', error: bad };
  const sums = clueSums(puzzle);
  if (!cluesConsistent(puzzle)) {
    return { ok: false, reason: 'sumMismatch', sums, detail: `Σrows ${sums.rows} vs Σcols ${sums.cols} vs Σfleet ${sums.fleet}` };
  }

  const t0 = Date.now();
  const s = solve(puzzle, { limit: 2 });
  const solverMs = Date.now() - t0;
  if (s.truncated) return { ok: false, reason: 'truncated', solverMs };
  if (s.count === 0) return { ok: false, reason: 'noSolution', solverMs };
  if (s.count >= 2) return { ok: false, reason: 'notUnique', solverMs, count: s.count };

  const t1 = Date.now();
  const second = countByTable(puzzle, { budget: opts.budget, limit: 2 });
  const enumMs = Date.now() - t1;
  if (second.truncated) return { ok: false, reason: 'tableTruncated', solverMs, enumMs };
  if (second.count !== s.count) {
    return { ok: false, reason: 'routesDisagree', count: s.count, tableCount: second.count, solverMs, enumMs };
  }
  const a = s.solution.cells.join(',');
  // The enumeration reports hulls longest-first, the solver scans the grid row-major, so the
  // two cell lists agree as sets long before they agree as text. Compare them as sets.
  const b = second.solutions.length
    ? second.solutions[0].slice().sort((x, y) => x - y).join(',')
    : null;
  if (b !== a) {
    return { ok: false, reason: 'routesDisagreeSolution', solverMs, enumMs, detail: `${a} | ${b}` };
  }

  return {
    ok: true,
    reason: null,
    puzzle,
    solution: s.solution,
    count: s.count,
    tableCount: second.count,
    sameSolution: true,
    route: second.route,
    depth: s.depth,
    guesses: s.guesses,
    nodes: s.nodes,
    inferences: s.inferences,
    deduced: s.deduced,
    solverMs,
    enumMs,
  };
}

// makeChart(tier, seed, opts) -> { ok, reason, attempts, rejections, ...verifyChart fields }
// One seeded walk through the rejection sampler. `maxAttempts` bounds it; every discarded draw
// is recorded under the reason that killed it, which is what bake.mjs prints.
export function makeChart(tier, seed, opts = {}) {
  const maxAttempts = opts.maxAttempts || 400;
  const band = bandOf(tier.band);
  const rejections = {};
  const times = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rand = rngFrom(`${seed}|${tier.key}|${attempt}`);
    const hulls = randomFleetPlacement(tier.n, tier.fleet, rand);
    if (!hulls) {
      rejections.deadEnd = (rejections.deadEnd || 0) + 1;
      continue;
    }
    const puzzle = chartOf(tier.n, tier.fleet, hulls);
    const t0 = Date.now();
    const v = verifyChart(puzzle, opts);
    times.push(Date.now() - t0);
    if (!v.ok) {
      rejections[v.reason] = (rejections[v.reason] || 0) + 1;
      continue;
    }
    if (v.depth < band.min) {
      rejections.tooEasy = (rejections.tooEasy || 0) + 1;
      continue;
    }
    if (v.depth > band.max) {
      rejections.tooHard = (rejections.tooHard || 0) + 1;
      continue;
    }
    return {
      ...v,
      tier: tier.key,
      band: tier.band,
      attempts: attempt + 1,
      rejections,
      times,
      seed: `${seed}|${tier.key}|${attempt}`,
    };
  }
  return { ok: false, reason: 'exhausted', attempts: maxAttempts, rejections, times };
}

// Median/max of a list of durations — bake.mjs prints these, the contract says measured.
export function statsOf(list) {
  if (!list.length) return { median: 0, max: 0, n: 0 };
  const s = list.slice().sort((a, b) => a - b);
  return { n: s.length, median: s[(s.length - 1) >> 1], max: s[s.length - 1] };
}
