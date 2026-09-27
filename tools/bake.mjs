// Build-time chart bake.
//
//     node tools/bake.mjs                 # writes js/data/lots.js and prints the measurement table
//     node tools/bake.mjs --check         # regenerate, compare to the file, write nothing
//
// The table it prints is the repo's evidence: per tier the number of draws, the unique-solution
// acceptance rate, the solution counter's median/max milliseconds, the rejection reasons, and
// which of the two routes produced the second count. Anything under 20% acceptance or over
// 300ms median is printed as it is — this script is the reason the generator is not on the
// tap path, and a reader should be able to see that from its output.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TIERS, BANDS, makeChart, statsOf, verifyChart, bandOfDepth } from '../js/core/make.js';
import { tableFor, clearTables } from '../js/core/enumerate.js';
import { solve } from '../js/core/solve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'js/data/lots.js');
const BAKE_SEED = 'fleet-bake-v1';

const DISPLAY = {
  harbour: { label: '避风港', blurb: '4×4 · 三艘船 · 线索推到底' },
  patrol: { label: '巡逻线', blurb: '5×5 · 三艘船 · 零假设' },
  convoy: { label: '护航', blurb: '5×5 · 三艘船 · 一次假设' },
  blockade: { label: '封锁线', blurb: '6×6 · 四艘船 · 一次假设' },
  sortie: { label: '出击', blurb: '6×6 · 四艘船 · 两次以上假设' },
  battleline: { label: '战列线', blurb: '7×7 · 四艘船 · 两次以上假设' },
};

function fmt(ms) {
  return `${ms}ms`;
}

function bake() {
  const lots = [];
  const report = [];

  for (const tier of TIERS) {
    const band = BANDS.find((b) => b.key === tier.band);
    const tables = [];
    clearTables();
    const t0 = Date.now();
    const table = tableFor(tier.n, tier.fleet, { budget: 600000 });
    const tableMs = Date.now() - t0;
    tables.push({ fleet: tier.fleet.join(','), entries: table.entries.length, truncated: table.truncated, ms: tableMs });

    const times = [];
    const rejections = {};
    const seen = new Set();
    let accepted = 0;
    let draws = 0;
    let deadEnds = 0;
    let serial = 0;
    while (accepted < tier.want && serial < 4000) {
      serial += 1;
      draws += 1;
      // One draw per call, so the rejection counters below are per-draw and the acceptance
      // rate printed for a tier is the rate of the sampler rather than of a retry loop.
      const r = makeChart(tier, `${BAKE_SEED}|${serial}`, { maxAttempts: 1, budget: 600000 });
      for (const k of Object.keys(r.rejections || {})) {
        rejections[k] = (rejections[k] || 0) + r.rejections[k];
      }
      deadEnds += r.rejections && r.rejections.deadEnd ? r.rejections.deadEnd : 0;
      if (!r.ok) continue;
      // A 4×4 sampler redraws the same chart sooner or later; a lot pool with two identical
      // rows is a pool that quietly shrank, so the repeat is rejected rather than shipped.
      const key = `${r.puzzle.n}|${r.puzzle.fleet.join(',')}|${r.puzzle.rows.join(',')}|${r.puzzle.cols.join(',')}`;
      if (seen.has(key)) {
        rejections.duplicate = (rejections.duplicate || 0) + 1;
        continue;
      }
      seen.add(key);
      times.push(r.solverMs + r.enumMs);
      accepted += 1;
      lots.push({
        id: `${tier.key}-${String(accepted).padStart(2, '0')}`,
        tier: tier.key,
        band: tier.band,
        n: r.puzzle.n,
        fleet: r.puzzle.fleet,
        rows: r.puzzle.rows,
        cols: r.puzzle.cols,
        cells: r.solution.cells,
        solutionCount: r.count,
        depth: r.depth,
        guesses: r.guesses,
        nodes: r.nodes,
        route: r.route,
        seed: r.seed,
      });
    }
    if (accepted < tier.want) {
      console.error(`!! tier ${tier.key} filled ${accepted}/${tier.want} in ${serial} draws`);
    }
    const placed = draws - deadEnds;
    const unique = accepted;
    const s = statsOf(times);
    const drawRate = placed ? ((unique / placed) * 100).toFixed(1) : '0.0';
    report.push({
      tier: tier.key,
      n: tier.n,
      fleet: tier.fleet.join('+'),
      band: `${band.label} (depth ${band.max === Infinity ? `>=${band.min}` : band.min})`,
      want: tier.want,
      got: accepted,
      draws,
      placed,
      unique,
      drawRate: `${drawRate}%`,
      median: fmt(s.median),
      max: fmt(s.max),
      table: table.entries.length,
      tableTruncated: table.truncated,
      tableMs,
      rejections,
    });
  }

  return { lots, report };
}

// Independent re-check of every shipped row straight from its printed puzzle: solve must say 1
// at the printed depth/guesses, and the enumeration route must agree. This runs before the file
// is written so a bad bake cannot land in git even if nobody runs the tests.
function recheck(lots) {
  const problems = [];
  const seen = new Set();
  for (const lot of lots) {
    const key = `${lot.n}|${lot.fleet.join(',')}|${lot.rows.join(',')}|${lot.cols.join(',')}`;
    if (seen.has(key)) problems.push(`${lot.id}: duplicate puzzle in the shipped pool`);
    seen.add(key);
    const puzzle = { n: lot.n, fleet: lot.fleet, rows: lot.rows, cols: lot.cols };
    const s = solve(puzzle, { limit: 2 });
    if (!s.ok || s.count !== lot.solutionCount) problems.push(`${lot.id}: count ${s.count}`);
    if (s.depth !== lot.depth || s.guesses !== lot.guesses) {
      problems.push(`${lot.id}: depth/guesses ${s.depth}/${s.guesses} vs printed ${lot.depth}/${lot.guesses}`);
    }
    // The band label is a reading of the measurement, never a choice: `bandOfDepth` is the same
    // function makeChart filters draws through, so a row cannot be stamped 'pure' at depth 3.
    if (bandOfDepth(lot.depth) !== lot.band) {
      problems.push(`${lot.id}: band '${lot.band}' is not the band of depth ${lot.depth}`);
    }
    const v = verifyChart(puzzle, { budget: 600000 });
    if (!v.ok) problems.push(`${lot.id}: verify ${v.reason} ${v.detail || ''}`);
  }
  return problems;
}

function render(lots) {
  const rows = lots.map((l) => '  ' + JSON.stringify(l)).join(',\n');
  const meta = TIERS.map((t) => {
    const band = BANDS.find((b) => b.key === t.band);
    return `  { key: '${t.key}', label: '${DISPLAY[t.key].label}', band: '${band.label}', blurb: '${DISPLAY[t.key].blurb}', n: ${t.n}, fleet: [${t.fleet.join(', ')}], want: ${t.want} }`;
  }).join(',\n');
  return `// Generated by tools/bake.mjs — do not hand-edit; the file is rewritten by the bake
// and test/lots.test.mjs recomputes every printed field from the puzzle below.
//
// Each row is a chart that survived two independent counts: the propagation solver
// (js/core/solve.js) and the clue-free enumeration table (js/core/enumerate.js) both returned
// solutionCount, and the same cell set. \`depth\`/\`guesses\` are that solver's measured
// assumption stack and dry-reasoning count, not a star rating.

export const BAKE_SEED = '${BAKE_SEED}';

export const TIERS_META = [
${meta},
];

export const LOTS = [
${rows},
];
`;
}

const { lots, report } = bake();

console.log('tier        n  fleet      band            drew  laid  uniq  rate    med    max    table');
for (const r of report) {
  console.log(
    `${r.tier.padEnd(11)} ${String(r.n).padStart(2)}  ${r.fleet.padEnd(9)} ${r.band.padEnd(15)}`
    + ` ${String(r.draws).padStart(4)} ${String(r.placed).padStart(5)} ${String(r.unique).padStart(5)}`
    + ` ${r.drawRate.padStart(6)} ${r.median.padStart(6)} ${r.max.padStart(6)} ${String(r.table).padStart(7)}`
    + (r.tableTruncated ? ' (truncated -> clue-first route)' : ''),
  );
  console.log(`            rejections ${JSON.stringify(r.rejections)}`);
}
const totalDraws = report.reduce((a, r) => a + r.draws, 0);
const totalUnique = report.reduce((a, r) => a + r.unique, 0);
console.log(`totals: ${lots.length} lots from ${totalDraws} draws, ${totalUnique} unique charts accepted (${((totalUnique / totalDraws) * 100).toFixed(1)}%)`);

const problems = recheck(lots);
if (problems.length) {
  console.error('RECHECK FAILED:\n  ' + problems.slice(0, 20).join('\n  '));
  process.exit(1);
}
console.log(`recheck: ${lots.length}/${lots.length} reproduce count/depth/guesses on both routes`);

const body = render(lots);
if (existsSync(OUT) && readFileSync(OUT, 'utf8') === body) {
  console.log(`unchanged: ${OUT}`);
} else if (process.argv.includes('--check')) {
  console.error('js/data/lots.js differs from a fresh bake; run `node tools/bake.mjs`');
  process.exit(1);
} else {
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
}
