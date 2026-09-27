// The shipped chart pool. The game reads levels from here and never generates them, and that
// is a measured decision: a chart is only shippable after two independent routes agree it has
// exactly one solution, which costs milliseconds at build time and would be an unacceptable
// stall on a tap. See tools/bake.mjs for the numbers.
//
// Every row carries the printed evidence (`solutionCount`, `depth`, `guesses`, `route`) that
// tools/bake.mjs measured. test/lots.test.mjs recomputes it from the serialized puzzle and
// fails if the file and the code disagree, so these fields are a claim the repo can check
// rather than a comment.

import { LOTS, TIERS_META } from '../data/lots.js';
import { hashSeed } from './rng.js';

export const TIERS = TIERS_META;
export const ALL = LOTS;

function byKey(list, key) {
  return key ? list.filter((l) => l.tier === key) : list;
}

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

export function lotsIn(key) {
  return byKey(ALL, key);
}

export function byId(id) {
  return ALL.find((l) => l.id === id) || null;
}

// The puzzle object the rules and the solver read; the lot row carries its own evidence.
export function puzzleOf(lot) {
  return { n: lot.n, fleet: lot.fleet.slice(), rows: lot.rows.slice(), cols: lot.cols.slice() };
}

// Campaign order = bake order = band order, so the ladder a player climbs is the ladder the
// solver measured, not a sort someone typed by hand.
export function campaign() {
  return ALL;
}

export function levelAt(index) {
  return ALL[((index % ALL.length) + ALL.length) % ALL.length];
}

export function indexOf(lot) {
  return ALL.findIndex((l) => l.id === (typeof lot === 'string' ? lot : lot.id));
}

// Endless play inside one band. A seed picks, so a shared link and a daily both reproduce.
export function randomLot(seed, tierKey) {
  const list = byKey(ALL, tierKey);
  if (!list.length) return null;
  return list[hashSeed(`random|${tierKey || 'all'}|${seed}`) % list.length];
}

// `#/daily`: the date string is the whole seed, so any device lands on the same chart.
export function dailyLot(dateKey) {
  return ALL[hashSeed(`daily|${dateKey}`) % ALL.length];
}
