// Tiny zero-dep test harness. Every suite in test/*.test.mjs imports `test/ok/eq` and calls
// `run()`, so each file prints the same shape and verify.sh can aggregate them:
//
//     rows: 12 fail: 0
//
// `rows` counts named cases, not raw assertions — the assertion floor in the spec is about
// cases a reader can see fail, and the count is printed per file so a suite that silently
// stopped running is visible.

const rows = [];

export function test(name, fn) {
  try {
    fn();
    rows.push({ test: name, pass: true });
  } catch (err) {
    rows.push({ test: name, pass: false, detail: String((err && err.message) || err) });
  }
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg = 'not equal') {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function fail(msg) {
  throw new Error(msg);
}

export function run() {
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) {
    console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  }
  console.log(`rows: ${rows.length} fail: ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
}
