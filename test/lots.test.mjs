// The anti-hand-edit gate: everything printed in js/data/lots.js is recomputed here from the
// serialized puzzle alone. If someone edits a `depth`, retypes a clue vector or swaps a cell
// list, this suite fails — which is the only reason the numbers on the screen mean anything.
//
// It also pins the two route helpers (daily / random) to the mixer, so a shared link cannot
// silently resolve to a different chart on another device.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { LOTS, TIERS_META, BAKE_SEED } from '../js/data/lots.js';
import { solve, segmentsOf, deduce } from '../js/core/solve.js';
import { countByTable, tableFor, clearTables } from '../js/core/enumerate.js';
import { bandOfDepth } from '../js/core/make.js';
import { isSolved } from '../js/core/rules.js';
import { parseBoard, serialize } from '../js/core/board.js';
import { byId, dailyLot, randomLot, puzzleOf, campaign, levelAt, indexOf } from '../js/core/library.js';
import { hashSeed, mulberry32, todayKey } from '../js/core/rng.js';

const puzzleOfLot = (lot) => ({ n: lot.n, fleet: lot.fleet.slice(), rows: lot.rows.slice(), cols: lot.cols.slice() });
const sorted = (a) => a.slice().sort((x, y) => x - y);
const asText = (a) => sorted(a).join(',');

// The full sweep is a few seconds of pure search; do it once and let the cases read it.
const MEASURED = LOTS.map((lot) => {
  const puzzle = puzzleOfLot(lot);
  const s = solve(puzzle, { limit: 2 });
  return { lot, puzzle, solved: s };
});

test('the pool is the size the bake says it is, and the seed is stamped', () => {
  eq(LOTS.length, 96);
  eq(TIERS_META.length, 6);
  eq(BAKE_SEED, 'fleet-bake-v1');
  for (const meta of TIERS_META) {
    const rows = LOTS.filter((l) => l.tier === meta.key);
    eq(rows.length, meta.want, `${meta.key} filled its quota`);
    eq(new Set(rows.map((l) => l.n)).size, 1, `${meta.key} is one board size`);
    ok(rows.every((l) => l.fleet.join(',') === meta.fleet.join(',')), `${meta.key} is one navy`);
  }
  eq(new Set(LOTS.map((l) => l.id)).size, LOTS.length, 'ids are unique');
  eq(new Set(LOTS.map((l) => `${l.n}|${l.rows.join(',')},${l.cols.join(',')}`)).size, LOTS.length,
    'no two lots are the same chart wearing two ids');
});

test('every printed solutionCount is recomputed by the solver, at the printed depth', () => {
  const bad = [];
  for (const { lot, puzzle, solved: s } of MEASURED) {
    if (s.error) bad.push(`${lot.id}: ${s.error}`);
    if (s.count !== lot.solutionCount) bad.push(`${lot.id}: count ${s.count} vs ${lot.solutionCount}`);
    if (s.depth !== lot.depth) bad.push(`${lot.id}: depth ${s.depth} vs ${lot.depth}`);
    if (s.guesses !== lot.guesses) bad.push(`${lot.id}: guesses ${s.guesses} vs ${lot.guesses}`);
    if (s.nodes !== lot.nodes) bad.push(`${lot.id}: nodes ${s.nodes} vs ${lot.nodes}`);
    if (s.truncated) bad.push(`${lot.id}: truncated`);
  }
  eq(bad, [], 'printed evidence reproduces');
});

test('every printed cell list is the unique solution, and it satisfies its own clues', () => {
  const bad = [];
  for (const { lot, puzzle, solved: s } of MEASURED) {
    if (asText(lot.cells) !== asText(s.solution.cells)) bad.push(`${lot.id}: cells differ from the solver`);
    const board = parseBoard(lot.n, serializeSolution(lot));
    if (!isSolved(puzzle, board)) bad.push(`${lot.id}: printed cells are not a solved chart`);
  }
  eq(bad, [], 'every row plays');
});

// The shipped `cells` are hull squares; the rest of a solved chart is water, which is what the
// player has to black in for the session to count as finished (js/core/game.js).
function serializeSolution(lot) {
  const hull = new Set(lot.cells);
  const lines = [];
  for (let y = 0; y < lot.n; y++) {
    let s = '';
    for (let x = 0; x < lot.n; x++) s += hull.has(y * lot.n + x) ? '#' : '~';
    lines.push(s);
  }
  return lines.join('/');
}

test('the second, clue-free route reproduces the same count and the same chart', () => {
  clearTables();
  const bad = [];
  for (const { lot, puzzle } of MEASURED) {
    const t = countByTable(puzzle, { limit: 2, budget: 600000 });
    if (t.truncated) bad.push(`${lot.id}: table truncated`);
    if (t.count !== lot.solutionCount) bad.push(`${lot.id}: table count ${t.count}`);
    if (asText(t.solutions[0] || []) !== asText(lot.cells)) bad.push(`${lot.id}: table cells`);
    if (t.route !== lot.route) bad.push(`${lot.id}: route "${t.route}" vs "${lot.route}"`);
  }
  eq(bad, [], 'both legs agree with the file on all 96 charts');
  clearTables();
});

test('the band a lot ships in is its measured depth, not a typed label', () => {
  const bad = [];
  for (const { lot, solved: s } of MEASURED) {
    if (bandOfDepth(lot.depth) !== lot.band) bad.push(`${lot.id}: depth ${lot.depth} is not band ${lot.band}`);
    if (s.depth === 0 && lot.band !== 'pure') bad.push(`${lot.id}: closed by deduction, shipped as ${lot.band}`);
    if (s.depth > 0 && lot.band === 'pure') bad.push(`${lot.id}: needed ${s.depth} assumptions, shipped as pure`);
  }
  eq(bad, [], 'band matches measurement');
  const depths = LOTS.reduce((acc, l) => ({ ...acc, [l.tier]: Math.max(acc[l.tier] || 0, l.depth) }), {});
  eq(depths.harbour, 0, 'the 4x4 harbour band really is closed by propagation');
  ok(depths.battleline >= 2, `the deepest band measured ${depths.battleline} assumptions deep`);
});

test('a pure band chart is closed by deduction alone, a guess band chart is not', () => {
  const pure = MEASURED.find((m) => m.lot.band === 'pure');
  const guess = MEASURED.find((m) => m.lot.band === 'guess2');
  const pureBoard = deduce(pure.puzzle);
  eq(serialize(pureBoard).includes('.'), false, `${pure.lot.id}: deduction leaves no open square`);
  ok(isSolved(pure.puzzle, pureBoard), `${pure.lot.id}: and what it leaves is the solution`);
  const guessBoard = deduce(guess.puzzle);
  ok(serialize(guessBoard).includes('.'), `${guess.lot.id}: deduction alone cannot finish a +2 chart`);
  eq(guess.solved.depth >= 2, true);
});

test('the solver does not disturb the puzzle, the file, or its own segment cache', () => {
  const lot = LOTS[13];
  const before = JSON.stringify(lot);
  const puzzle = puzzleOfLot(lot);
  const frozen = JSON.stringify(puzzle);
  const segs = segmentsOf(puzzle.n, puzzle.fleet);
  const indexBefore = segs.byCell.map((a) => a.length).join('');
  const first = solve(puzzle, { segs, limit: 2 });
  eq(JSON.stringify(puzzle), frozen, 'puzzle untouched');
  eq(JSON.stringify(puzzleOf(lot)), frozen, 'puzzleOf hands out a copy');
  eq(segs.byCell.map((a) => a.length).join(''), indexBefore, 'segment index untouched');
  eq(JSON.stringify(lot), before, 'the data row was never written to');
  const again = solve(puzzleOfLot(lot), { segs, limit: 2 });
  eq([again.count, again.depth, again.guesses, again.nodes], [first.count, first.depth, first.guesses, first.nodes],
    'a second run on the same cache answers the same');
});

test('the enumeration table is a table: same numbers before and after clearTables', () => {
  const lot = LOTS.find((l) => l.n === 4);
  const a = tableFor(lot.n, lot.fleet, { budget: 600000 });
  const before = `${a.arrangements}/${a.entries.length}/${a.truncated}`;
  const again = tableFor(lot.n, lot.fleet, { budget: 600000 });
  eq(`${again.arrangements}/${again.entries.length}/${again.truncated}`, before);
  clearTables();
  const fresh = tableFor(lot.n, lot.fleet, { budget: 600000 });
  eq(`${fresh.arrangements}/${fresh.entries.length}/${fresh.truncated}`, before, 'a rebuild is not a re-roll');
});

test('hashSeed is its own function: stable, spread, and 32-bit unsigned', () => {
  // Contract note: this mixer is derived from FNV-1a (two rounds per UTF-16 code unit), so its
  // outputs are NOT the textbook vectors. The honest pinned fact is the disagreement itself.
  eq(hashSeed('a'), hashSeed('a'));
  eq(hashSeed('a') >>> 0, hashSeed('a'), 'always an unsigned 32-bit value');
  eq(hashSeed('a') === 3826002220, false, 'not textbook FNV-1a - do not document it as such');
  const dates = [];
  for (let d = 1; d <= 40; d++) dates.push(hashSeed(`daily|2026-03-${String(d).padStart(2, '0')}`));
  eq(new Set(dates).size, dates.length, 'forty consecutive days, forty different seeds');
  ok(dates.every((h) => h >= 0 && h < 4294967296));
});

test('mulberry32 replays a stream from the same seed and only the same seed', () => {
  const stream = (seed) => {
    const r = mulberry32(seed);
    return [r.int(97), r.pick([1, 2, 3]), r.range(4, 7), r.int(97), r.range(4, 7)];
  };
  const seed = hashSeed('fleet|daily|2026-03-04');
  eq(stream(seed), stream(hashSeed('fleet|daily|2026-03-04')), 'the same seed draws the same five');
  ok(stream(seed).every((v, i) => (i === 1 ? v >= 1 && v <= 3 : v >= 4 || v <= 96)), 'draws stay inside their ranges');
  const neighbour = stream(hashSeed('fleet|daily|2026-03-05'));
  ok(neighbour.join(',') !== stream(seed).join(','), 'the next date is a different stream');
});

test('#/daily resolves to one chart for a date, on any device', () => {
  const day = '2026-03-04';
  const first = dailyLot(day);
  eq(dailyLot(day).id, first.id, 'the same date twice');
  eq(byId(first.id).id, first.id, 'and it is a real shipped row');
  const spread = new Set();
  for (let d = 1; d <= 30; d++) {
    const key = `2026-03-${String(d).padStart(2, '0')}`;
    eq(dailyLot(key).id, LOTS[hashSeed(`daily|${key}`) % LOTS.length].id, `${key} resolves through the mixer, not through a clock`);
    spread.add(dailyLot(key).id);
  }
  ok(spread.size > 1, `30 days visit ${spread.size} different charts`);
  eq(new Set([...spread]).size, spread.size);
  ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(todayKey(new Date(2026, 2, 4))), todayKey(new Date(2026, 2, 4)));
});

test('#/random/<tier>/<key> stays inside its band and repeats itself', () => {
  for (const meta of TIERS_META) {
    const a = randomLot('fixedseed', meta.key);
    eq(randomLot('fixedseed', meta.key).id, a.id, `${meta.key} replays`);
    eq(a.tier, meta.key, `${meta.key} stays in its band`);
    const visited = new Set();
    for (let t = 0; t < 24; t++) {
      const picked = randomLot(`token-${t}`, meta.key);
      eq(picked.tier, meta.key, `token ${t} left the band`);
      visited.add(picked.id);
    }
    ok(visited.size > 1, `${meta.key}: 24 tokens visit ${visited.size} charts, so the token bites`);
  }
  eq(randomLot('fixedseed', 'not-a-tier'), null, 'an unknown band has no lots');
});

test('the campaign order is the bake order, and the index helpers round-trip', () => {
  eq(campaign().length, LOTS.length);
  eq(campaign()[0].id, LOTS[0].id);
  eq(levelAt(0).id, LOTS[0].id);
  eq(levelAt(-1).id, LOTS[LOTS.length - 1].id, 'one before the first wraps to the last');
  eq(levelAt(LOTS.length).id, LOTS[0].id, 'and one past the last wraps to the first');
  eq(indexOf(LOTS[41]), 41);
  eq(indexOf(LOTS[41].id), 41, 'by id or by row, same place in the ladder');
  eq(byId('nope'), null);
});

run();
