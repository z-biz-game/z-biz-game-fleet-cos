// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch). No Playwright,
// no dependencies.
//
// env: CDP_PORT (devtools port, default 9353), BASE_URL (page to attach to, default
//      http://127.0.0.1:5193/)
// usage:
//   node playtest.mjs open   <url>              # reuse-or-create our page and navigate
//   node playtest.mjs nav    <url>
//   node playtest.mjs eval   '<js expression>'   # pass `nonav` to skip the reload
//   node playtest.mjs eval   '@boot'             # | @play | @routes | @save | @reloaded
//   node playtest.mjs drag   2,1,3,h             # one real drag that lays a 3-cell hull
//   node playtest.mjs tap    3,3                 # one real press+release on a square
//   node playtest.mjs shot   <path.png>
//   node playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
const PORT = process.env.CDP_PORT || 9353;
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a fresh
// about:blank tab when pointed at any other origin.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5193/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHIFT = 8; // CDP modifier bitmask: ShiftLeft. Used by the water gesture.

// One real mouse event at a client-space coordinate. Shared by the @pointer suite and the `tap`
// / `drag` commands so the two cannot drift apart in what "a press" means over the wire.
//
// `button` is 'left' on the release too, and that is not decoration: with `button: 'none'` Chrome
// does not synthesise a pointerup at all, so js/view.js's `up()` never runs, the press stays armed,
// its 450 ms long-press timer fires seconds later, and every gesture in @pointer lands as a pencil
// mark on a chart that looks untouched. The tell is a release that produces no `pointerup` in the
// page's own event log — not an assertion failure about the hull.
const mouseAt = (cdp, sessionId, type, x, y, buttons = 0, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0, modifiers,
}, sessionId);

// Press on a square, drag into a second one, then leave the chart entirely and release out
// there — beyond the canvas, so the only thing that can still deliver the pointerup to the view
// is the pointer capture js/view.js takes on the press. Without it the release is dropped, the
// press stays armed, and 450 ms later the long-press timer files a pencil mark on a square
// nobody aimed at: the gesture is not lost, it is misfiled.
async function dragOffChart(cdp, sessionId, runJS, from, step, rest = 700) {
  const a = await runJS(`window.fleet.cellPoint(${from[0]},${from[1]})`);
  const b = await runJS(`window.fleet.cellPoint(${step[0]},${step[1]})`);
  if (!a || !b) return null;
  const out = { x: b.x + 2 * (b.x - a.x), y: b.y + 2 * (b.y - a.y) };
  await mouseAt(cdp, sessionId, 'mouseMoved', a.x, a.y);
  await sleep(20);
  await mouseAt(cdp, sessionId, 'mousePressed', a.x, a.y, 1);
  await sleep(40);
  await mouseAt(cdp, sessionId, 'mouseMoved', b.x, b.y, 1);
  await sleep(24);
  await mouseAt(cdp, sessionId, 'mouseMoved', out.x, out.y, 1);
  await sleep(24);
  await mouseAt(cdp, sessionId, 'mouseReleased', out.x, out.y, 0);
  await sleep(rest); // longer than the view's LONG_PRESS: a leaked press would fire inside this
  return { a, b, out };
}

// Press, walk the pointer through every square of the segment, release at the end. This is the
// shape js/view.js listens for: a drag whose last known square decides the hull's length.
async function dragHull(cdp, sessionId, runJS, spec, hold = 40, rest = 120) {
  const [x, y, len, axis] = spec.split(',');
  // The axis has to arrive as a string: `linePoints(0,1,3,h)` parses, then throws
  // `ReferenceError: h is not defined` inside the page, and the whole @pointer run dies with
  // no RESULT line at all.
  const pts = await runJS(`window.fleet.linePoints(${Number(x)},${Number(y)},${Number(len)},${JSON.stringify(axis)})`);
  if (!pts) return null;
  const steps = [];
  for (let k = 1; k < Number(len); k++) {
    const c = await runJS(`window.fleet.cellPoint(${axis === 'h' ? Number(x) + k : Number(x)},${axis === 'h' ? Number(y) : Number(y) + k})`);
    if (c) steps.push(c);
  }
  await mouseAt(cdp, sessionId, 'mouseMoved', pts.from.x, pts.from.y);
  await sleep(20);
  await mouseAt(cdp, sessionId, 'mousePressed', pts.from.x, pts.from.y, 1);
  await sleep(hold);
  for (const c of steps) {
    await mouseAt(cdp, sessionId, 'mouseMoved', c.x, c.y, 1);
    await sleep(24);
  }
  await mouseAt(cdp, sessionId, 'mouseReleased', pts.to.x, pts.to.y, 0);
  await sleep(rest);
  return pts;
}

// Press and release on the square the page says it is, with an optional hold (a hold past the
// view's LONG_PRESS threshold turns the tap into a pencil mark).
async function tapSquare(cdp, sessionId, runJS, spec, hold = 30, rest = 100, modifiers = 0) {
  const p = await runJS(`window.fleet.cellPoint(${spec})`);
  if (!p) return null;
  await mouseAt(cdp, sessionId, 'mouseMoved', p.x, p.y, 0, modifiers);
  await sleep(20);
  await mouseAt(cdp, sessionId, 'mousePressed', p.x, p.y, 1, modifiers);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', p.x, p.y, 0, modifiers);
  await sleep(rest);
  return p;
}

// A real press on a DOM button, at the point the browser itself says is on top of it. `el.click()`
// proves the handler is wired; it cannot prove a thumb can reach the thing, which is the whole
// lesson of a layout that paints one panel over another.
async function clickEl(cdp, sessionId, runJS, id, rest = 250) {
  const at = await runJS(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await mouseAt(cdp, sessionId, 'mouseMoved', at.x, at.y);
  await sleep(20);
  await mouseAt(cdp, sessionId, 'mousePressed', at.x, at.y, 1);
  await sleep(30);
  await mouseAt(cdp, sessionId, 'mouseReleased', at.x, at.y, 0);
  await sleep(rest);
  return at;
}

// The hit box of every id the caller is about to press, measured the way a finger would: the box
// inside the viewport, big enough to aim at, and the topmost element at its own centre.
async function reachOf(cdp, sessionId, runJS, ids) {
  return runJS(`(() => {
    const out = [];
    for (const id of ${JSON.stringify(ids)}) {
      const el = document.getElementById(id);
      if (!el) { out.push({ id, missing: true }); continue; }
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      out.push({ id, tag: el.tagName, w: Math.round(b.width), h: Math.round(b.height),
        inView: b.width > 0 && b.height > 0 && b.left >= 0 && b.top >= 0
          && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
        top: !!hit && (hit === el || el.contains(hit)) });
    }
    return out;
  })()`);
}

async function main() {
  // A scenario body is a string, and the only thing that parses it is the browser. One mismatched
  // quote therefore arrives as `@boot threw SyntaxError` after a Chrome launch. Check them here,
  // with node, before anything is paid for — and before the port/ownership preflight, so this
  // works with no server and no browser at all.
  if (cmd === 'selftest') {
    const bad = [];
    for (const [name, body] of Object.entries(SCENARIOS)) {
      try { new Function(body); } catch (e) { bad.push(`@${name}: ${e.message}`); }
    }
    console.log(`RESULT ${JSON.stringify({ cmd: 'selftest', pass: bad.length === 0, rows: Object.keys(SCENARIOS).length, fail: bad })}`);
    process.exit(bad.length ? 1 : 0);
  }
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. The page is a module graph fetched over the network: a
  // fixed sleep is long enough for a localhost server and too short for GitHub Pages, where it
  // made an innocent deployment look broken (`window.fleet` still undefined, canvas still the
  // unstyled 300x150 default, and every coordinate the finger aimed at wrong).
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.fleet && window.fleet.state && window.fleet.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'drag' || cmd === 'tap') {
    // One gesture, performed for real, against the page that is already open (no navigation, so
    // the game keeps running between commands). Having these on the command line means the win
    // screenshot a human reviews can be produced by a finger rather than by an injected call.
    const spec = cmd === 'drag' ? (arg || '0,1,3,v') : (arg || '0,0');
    const done = cmd === 'drag'
      ? await dragHull(cdp, sessionId, runJS, spec)
      : await tapSquare(cdp, sessionId, runJS, spec);
    if (!done) {
      console.log(`EVAL THROW: no such square for "${cmd} ${spec}"`);
      process.exit(1);
    }
    const now = await runJS(`(() => { const s = window.fleet.state;
      return s.id + ' hulls=' + s.hulls + ' marks=' + s.marks + ' refused=' + s.errors + ' done=' + s.done + ' ' + window.fleet.board(); })()`);
    console.log(`${cmd} ${spec} -> ${now}`);
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        // Clear the row buffer *before* running. With `nonav` every scenario is evaluated in the
        // same page, so if this suite throws at parse time the fallback below would otherwise
        // hand back the previous suite's rows and verify.sh would print them as if they belonged
        // to this one — a broken suite that looks green.
        await runJS('window.__lastRows = null; 1');
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// The one suite a page-side script cannot run: real input. Everything below goes through
// Chrome's own mouse over CDP, so what gets asserted is the pointer-to-square wiring in
// js/view.js rather than the rule behind it. Hulls are *dragged*, which is the only gesture that
// proves the drag length reaches the rules as the hull length.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const drag = (spec) => dragHull(cdp, sessionId, runJS, spec);
  const tap = (spec, hold, rest, mods) => tapSquare(cdp, sessionId, runJS, spec, hold, rest, mods);
  const read = () => runJS(`(() => { const g = window.fleet; return {
    state: g.state, board: g.board(), hulls: g.hulls(), cells: g.cells(), px: g.pixels(), said: document.getElementById('hintline').textContent,
  }; })()`);

  const ids = await runJS(`['chart','modes','totals','crumbs','readout','dock','hintline','curtain','verdict','tally','again','next','undo','hint','restart','share','shelf','wipe','toast']
    .map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));
  // Existence is not reachability. The sibling hitori gate shipped a campaign shelf that CSS kept
  // visible (`display: grid` outranks the UA `[hidden]` rule), which pushed the buttons below the
  // fold: thirteen pointer rows read as "the click does nothing" while the real bug was layout. So
  // anything this suite presses is measured *before* it is pressed. `#wipe` is left out on purpose
  // — it lives inside a closed <details> and its box is legitimately zero until opened.
  const reach = await reachOf(cdp, sessionId, runJS, ['chart', 'undo', 'hint', 'restart', 'share']);
  rec('every control the mouse is about to press is on screen and hit-testable',
    reach.every((r) => r.inView && r.top && (r.tag !== 'BUTTON' || Math.min(r.w, r.h) >= 24)), reach);

  // harbour-01: 4x4, fleet [1,2,3], rows [0,3,1,2], cols [3,0,2,1], certified cells
  // [4,6,7,8,12,14] -> 3v at (0,1), 2h at (2,1), 1 at (2,3).
  await runJS(`window.fleet.load('#/lot/harbour-01'); 'ok'`);
  await sleep(350);
  const start = await read();
  rec('a shared chart opens on a 4x4 with an empty chart', start.state.id === 'harbour-01' && start.state.n === 4
    && start.board === '..../..../..../....', { id: start.state.id, board: start.board });
  rec('the printed evidence is on screen: one solution, depth 0, guesses 0',
    start.state.solutionCount === 1 && start.state.depth === 0 && start.state.guesses === 0, {
      solutionCount: start.state.solutionCount, depth: start.state.depth, guesses: start.state.guesses,
    });
  rec('the canvas is painted and the geometry is laid out', start.px > 0 && start.cells.length === 16, { px: start.px });
  const plan = await runJS('window.fleet.plan()');
  rec('the certified navy decomposes into three hulls of the docked lengths',
    plan.length === 3 && plan.map((h) => h.len).sort().join(',') === '1,2,3', plan);

  // --- a real drag lays a real hull, and the ship squares land where the bake said they would
  const first = plan.find((h) => h.len === 3);
  const d1 = await drag(`${first.x},${first.y},${first.len},${first.axis}`);
  const after1 = await read();
  rec('dragging 3 squares afloat lays a 3-cell hull', !!d1 && after1.state.hulls === 1
    && after1.cells.filter((c) => c === 2).length === 3, { drag: d1 && [d1.from.cell, d1.to.cell], hulls: after1.state.hulls });
  rec('and the picture changed', after1.px !== start.px, { before: start.px, after: after1.px });
  rec('the panel counts the hull against the dock, not against the chart',
    after1.state.fleetLeft.join(',') === '1,2' && after1.state.errors === 0, { fleetLeft: after1.state.fleetLeft });

  // --- the water click that must be refused: (2,3) is a certified hull square and row 3 still
  // needs one more, so blacking it in would be vandalism, not annotation (js/core/game.js:156-162
  // markWater asks whether *both* lines are already full).
  await tap('2,3', 30, 100, SHIFT);
  const needed = await read();
  rec('shift-click refuses to black in a square a clue still needs',
    needed.board === '..../#.../#.../#...' && /还可能藏船/.test(needed.said),
    { board: needed.board, said: needed.said });
  await sleep(900); // the refusal kicks a shake; the fingerprint row below compares two still frames

  // --- an illegal drag: diagonal contact with the hull just laid. (1,1)-(2,1) touches (0,1).
  const before2 = await read();
  const d2 = await drag('1,1,2,h');
  const after2 = await read();
  rec('a drag into a neighbouring keel is refused', !!d2 && after2.state.hulls === before2.state.hulls
    && after2.state.errors === before2.state.errors + 1, { hulls: after2.state.hulls, errors: after2.state.errors });
  rec('the shell names the rule that refused it', /相邻|斜角/.test(after2.said), after2.said);
  rec('a refusal leaves no ship square behind', after2.board === before2.board, { before: before2.board, after: after2.board });
  await sleep(900); // the shake decays; nothing else was allowed to change
  const settled = await read();
  rec('and the picture comes back to exactly the picture it was', settled.px === before2.px, {
    before: before2.px, after: settled.px });

  // --- the second certified hull, and a finger that leaves the chart
  const second = plan.find((h) => h.len === 2);
  await drag(`${second.x},${second.y},${second.len},${second.axis}`);
  const after3 = await read();
  // No `~` anywhere in this string, on purpose: water is the player's hand, never a side effect of
  // laying a hull — test/game.test.mjs:50-60 pins "the water still has to be marked".
  rec('the 2-hull of the certified navy goes in where the bake said', after3.state.hulls === 2
    && after3.board === '..../#.##/#.../#...', { board: after3.board });
  const before4 = await read();
  const off = await dragOffChart(cdp, sessionId, runJS, [2, 0], [3, 0]);
  const after4 = await read();
  rec('a drag released outside the chart is answered, not left to rot', !!off
    && after4.state.hulls === before4.state.hulls && after4.state.errors === before4.state.errors + 1
    && after4.state.marks === before4.state.marks && /不计入/.test(after4.said),
    { off: off && [off.a.cell, off.b.cell, off.out], errors: after4.state.errors, marks: after4.state.marks, said: after4.said });
  await drag('0,0,4,h');
  const after5 = await read();
  rec('a drag longer than the navy is refused as a fleet error',
    after5.state.hulls === 2 && after5.state.errors === after4.state.errors + 1 && /船坞/.test(after5.said), { said: after5.said });

  // --- a tap lays the shortest hull still in the dock (the only way to draw a submarine)
  await tap('2,3');
  const after6 = await read();
  rec('a tap on open water lays the shortest hull in the dock',
    after6.state.hulls === 3 && after6.state.fleetLeft.length === 0
      && after6.board === '..../#.##/#.../#.#.', { board: after6.board, fleetLeft: after6.state.fleetLeft });
  rec('the chart is not finished yet: the water still has to be marked', after6.state.done === false, after6.state);

  // --- shift+click blacks in water, but only where no clue still needs a square. Addressed by
  // (x, y) and read back out of the row it lives in: `board[5]` is the character after the first
  // '/', which is column 0 — the mistake DESIGN.md §7.2 第 2 条 records for @play.
  await tap('1,0', 30, 100, SHIFT);
  const after7 = await read();
  rec('shift-click marks water where both lines are closed',
    after7.board.split('/')[0][1] === '~' && after7.state.marks === after6.state.marks + 1,
    { board: after7.board, marks: after7.state.marks });
  await tap('0,0', 30, 100, SHIFT);
  const after8 = await read();
  rec('and the same click is allowed once the line above it has met its clue',
    after8.board.split('/')[0][0] === '~' && after8.state.marks === after7.state.marks + 1,
    { board: after8.board, marks: after8.state.marks });

  // --- long press is the pencil mark
  await tap('3,3', 700, 200);
  const after9 = await read();
  rec('a held press leaves a pencil mark, not a hull', after9.board.includes('?')
    && after9.state.hulls === 3 && after9.state.marks >= 1, { board: after9.board, marks: after9.state.marks });
  await tap('3,3', 700, 200);
  const after10 = await read();
  rec('and a second held press擦s it away again', !after10.board.includes('?'), { board: after10.board });

  // --- a tap on a hull lifts it
  await tap('2,1');
  const after11 = await read();
  rec('a tap on a hull lifts that hull back out', after11.state.hulls === 2
    && after11.state.fleetLeft.join(',') === '2', { hulls: after11.state.hulls, fleetLeft: after11.state.fleetLeft });
  await drag('2,1,2,h');
  const after12 = await read();
  // Against after10, not after6: two squares have been watered and a pencil mark has come and
  // gone since the first pass, and a lift-and-replace must give all of that back untouched.
  rec('and laying it again returns the chart to exactly what it was before the lift',
    after12.board === after10.board && after12.state.hulls === 3 && after12.state.marks === after10.state.marks,
    { before: after10.board, after: after12.board, marks: after12.state.marks });

  // --- a legal drop that overshoots a clue is counted as over, not as satisfied. This one needs
  // an empty chart: with the certified navy two-thirds down, every free square on harbour-01 is
  // either touching a keel (adjacency refusal) or sitting on a line that still has room, so the
  // overshoot cannot be reached by a legal gesture at all.
  await runJS(`window.fleet.load('#/lot/harbour-01'); window.fleet.reset(); 'ok'`);
  await sleep(300);
  await tap('2,0');
  const over = await read();
  rec('a legal 1-hull in a row that reads 0 reads as over, not as satisfied',
    over.state.hulls === 1 && over.state.over === 1 && over.state.done === false && /超线/.test(over.said),
    { over: over.state.over, said: over.said, hulls: over.state.hulls });
  const overRows = await runJS('window.fleet.status().rows.map((c) => [c.clue, c.have, c.full, c.over])');
  rec('the over-running line reports its one square against its zero clue',
    JSON.stringify(overRows[0]) === JSON.stringify([0, 1, true, true]), overRows);
  rec('and it is the only line over, so the count of over-lines is exactly one',
    overRows.filter((c) => c[3]).length === 1 && over.state.over === 1, overRows);

  // --- the whole certified chart, dragged for real.
  // `load()` alone is not a fresh chart: setGame() re-waters the saved draft (DESIGN.md:210 is
  // exactly this trap), so the reset has to be explicit — and then proven, because every count in
  // this block is only meaningful on an empty board.
  await runJS(`window.fleet.load('#/lot/harbour-01'); window.fleet.reset(); 'ok'`);
  await sleep(300);
  const fresh = await read();
  rec('a reset chart is empty before the mouse touches it',
    fresh.board === '..../..../..../....' && fresh.state.hulls === 0 && fresh.state.errors === 0,
    { board: fresh.board, hulls: fresh.state.hulls, errors: fresh.state.errors });
  const route = await runJS('window.fleet.plan()');
  let laid = 0;
  const log = [];
  for (const h of route) {
    const p = await drag(`${h.x},${h.y},${h.len},${h.axis}`);
    if (!p) { rec(`square ${h.x},${h.y} is on screen`, false, p); break; }
    const now = await read();
    laid++;
    log.push({ hull: `${h.len}${h.axis}@${h.x},${h.y}`, hulls: now.state.hulls, refused: now.state.errors });
    if (now.state.errors > 0) { rec(`drag ${laid} was refused`, false, log); break; }
  }
  rec('the mouse drags the whole certified navy in, one hull per drag', laid === route.length && laid === 3, log);
  let watered = 0;
  const n = fresh.state.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const st = await runJS(`window.fleet.cellPoint(${x},${y}).state`);
      if (st !== 0) continue;
      const before = await runJS('window.fleet.state.marks');
      await tap(`${x},${y}`, 30, 60, SHIFT);
      if ((await runJS('window.fleet.state.marks')) > before) watered++;
    }
  }
  const win = await read();
  rec('shift-clicking every open square fills the chart', watered === 10 && win.state.done, { watered, done: win.state.done });
  rec('the win card goes up and the whole chart reads as the certified solution',
    win.state.done && win.state.curtain && win.board === '~~~~/#~##/#~~~/#~#~', { board: win.board, curtain: win.state.curtain });
  rec('the card prints the measured evidence, not a star rating', await runJS(`(() => {
    const t = document.getElementById('tally').textContent;
    return /唯一解 1/.test(t) && /假设层数 0/.test(t) && !/★/.test(t); })()`));
  rec('and the run is on record at three drags', await runJS(`(() => {
    const r = window.fleet.store.record('harbour-01'); return !!r && r.solved === true && r.best === 3; })()`));

  // --- off-board presses are free
  const miss = await runJS(`(() => {
    const box = document.getElementById('chart').getBoundingClientRect();
    const cands = [[box.left + 3, box.top + 3], [box.right - 3, box.top + 3], [box.left + 3, box.bottom - 3]];
    for (const [x, y] of cands) {
      if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
      if (!window.fleet.pointAt(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
    return null; })()`);
  if (!miss) {
    rec('a press outside the chart is ignored', false, 'no margin square was reachable');
  } else {
    const before = await read();
    await mouseAt(cdp, sessionId, 'mousePressed', miss.x, miss.y, 1);
    await sleep(24);
    await mouseAt(cdp, sessionId, 'mouseReleased', miss.x, miss.y, 0);
    await sleep(120);
    const after = await read();
    rec('a press on the margin costs nothing', after.state.hulls === before.state.hulls
      && after.state.errors === before.state.errors && after.px === before.px, { miss, errors: after.state.errors });
  }

  // --- the panel's buttons, on a page that has just been won
  rec('a finished chart disables 撤销 rather than un-finished it',
    await runJS('document.getElementById("undo").disabled') === true, await runJS('window.fleet.state'));
  // `.curtain { position: absolute; inset: 0 }` paints over the whole board, so it is the one
  // element in this app that can eat a press aimed somewhere else. Its own buttons have to be on
  // top of it, and the 再来一次 below is pressed with a real mouse event rather than el.click().
  const nextVisible = await runJS('!document.getElementById("next").hidden');
  const card = await reachOf(cdp, sessionId, runJS, nextVisible ? ['curtain', 'verdict', 'tally', 'again', 'next'] : ['curtain', 'verdict', 'tally', 'again']);
  rec('the win card does not swallow the buttons inside it',
    card.every((r) => r.inView && r.top && (r.tag !== 'BUTTON' || Math.min(r.w, r.h) >= 24)), { card, nextVisible });
  await clickEl(cdp, sessionId, runJS, 'again');
  await sleep(250);
  const again = await read();
  const cardGone = await runJS('document.getElementById("curtain").hidden');
  rec('再来一次 clears the card, the chart and the count',
    again.state.hulls === 0 && again.board === '..../..../..../....'
      && again.state.errors === 0 && again.state.hints === 0 && cardGone === true
      && /回到起点/.test(again.said),
    { hulls: again.state.hulls, board: again.board, errors: again.state.errors, hints: again.state.hints, cardGone, said: again.said });
  await drag('0,1,3,v');
  const oneHull = await read();
  await runJS(`document.getElementById('undo').click(); 'ok'`);
  await sleep(250);
  rec('the undo button walks a real drag back', oneHull.state.hulls === 1 && (await runJS('window.fleet.state.hulls')) === 0, oneHull.state);
  await drag('0,1,3,v');
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(250);
  rec('the restart button clears the chart', await runJS(`window.fleet.board() === '..../..../..../....'`), await runJS('window.fleet.board()'));
  rec('and re-enables 撤销, because there is nothing left to take back',
    await runJS('document.getElementById("undo").disabled') === true, await runJS('window.fleet.state'));

  // --- the hint is propagation made visible, so it may only say what the clues already prove
  const pxEmpty = await runJS(`(() => { window.fleet.reset(); return window.fleet.pixels(); })()`);
  await sleep(150);
  const hinted = await runJS(`(() => {
    const g = window.fleet;
    const h = g.hintOnce();
    const b = g.cells();
    return { cells: h.cells.length, open: h.cells.every((i) => b[i] === 0), line: /^提示/.test(h.line), hints: g.state.hints };
  })()`);
  rec('the hint names only squares that are still undecided on the board',
    hinted.open === true && hinted.cells === 16 && hinted.line === true && hinted.hints === 1, hinted);
  const pxWithHint = await runJS('window.fleet.pixels()');
  rec('the deduction highlight is actually on the canvas', pxWithHint !== pxEmpty, { pxEmpty, pxWithHint });
  await runJS(`document.getElementById('hint').click(); 'ok'`);
  await sleep(150);
  rec('the button and the hook bill the same hint counter', (await runJS('window.fleet.state.hints')) === 2, await runJS('window.fleet.state.hints'));
  await sleep(3600); // the highlight has an expiry; the picture must come back exactly clean
  rec('the hint fades without leaving pixels behind', (await runJS('window.fleet.pixels()')) === pxEmpty, {
    before: pxEmpty, after: await runJS('window.fleet.pixels()') });

  return { rows };
}

// The in-page suites. Each returns { rows: [{ test, pass, detail }] }.
const SCENARIOS = {
  boot: `(async () => {
    const g = window.fleet;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    rec('the shell boots straight into a chart', g && g.version === 1 && g.state.mode === 'campaign' && g.state.id === 'harbour-01', g && g.state);
    const c = document.getElementById('chart');
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    // A canvas whose CSS was never applied is still the 300x150 box the HTML spec hands out, and
    // the hit test would then map fingers into a grid nobody drew. The screenshot catches that by
    // eye; this line is the same check inside the gate.
    const box = c.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    rec('the canvas is laid out, not the unstyled 300x150 default',
      box.width > 300 && box.height > 300
        && Math.abs(c.width - box.width * dpr) <= dpr + 1 && Math.abs(c.height - box.height * dpr) <= dpr + 1,
      { css: [Math.round(box.width), Math.round(box.height)], backing: [c.width, c.height], dpr });
    rec('and it was actually painted', g.painted() > 50 && g.pixels() > 0, { litSamples: g.painted() });
    rec('the geometry maps a square to a point and back', (() => {
      // view.pointAt answers with both spaces: cell is the board square, x/y are the client
      // pixels of its centre. Reading back.x as a column asked a pixel to be an index.
      const p = g.cellPoint(1, 2); const back = g.pointAt(p.x, p.y);
      return !!p && !!back && back.cell[0] === 1 && back.cell[1] === 2 && back.x === p.x && back.y === p.y;
    })(), g.cellPoint(1, 2));
    rec('a point above the chart is not a square', g.pointAt(1, 1) === null, g.pointAt(1, 1));

    const pool = g.pool;
    rec('the shipped pool loaded: 96 charts in 6 measured bands', pool.charts === 96 && Object.keys(pool.byTier).length === 6, pool.charts);
    rec('every band reports its own board size, navy and lot count',
      Object.values(pool.byTier).every((t) => t.lots === 16 && t.n >= 4 && t.fleet && t.unique === 16), pool.byTier);
    rec('the bands are ordered by measured depth, not by an adjective',
      pool.byTier.harbour.depthMax === 0 && pool.byTier.patrol.depthMax === 0
        && pool.byTier.convoy.depthMax === 1 && pool.byTier.blockade.depthMax === 1
        && pool.byTier.sortie.depthMin >= 2 && pool.byTier.battleline.depthMin >= 2, pool.byTier);
    const readout = document.getElementById('readout').textContent;
    rec('the panel prints the two claims: unique solutions and assumption depth',
      /唯一解/.test(readout) && /假设层数/.test(readout) && /船坞/.test(readout), readout.slice(0, 200));
    rec('the dock shows one capsule per hull in the navy',
      document.querySelectorAll('#dock .hull').length === g.lot().fleet.length, g.lot().fleet);

    // The repo's claim, recomputed on this device rather than quoted from a laptop.
    const pr = g.probe();
    rec('the solver in this browser reproduces the printed count', pr.solver.count === pr.printed.count && pr.solver.count === 1, pr);
    rec('and the printed difficulty is the solver\\'s measured stack',
      pr.solver.depth === pr.printed.depth && pr.solver.guesses === pr.printed.guesses && !pr.solver.truncated, pr);
    rec('the independent enumeration table says the same thing',
      !!pr.table && pr.table.count === 1 && pr.table.route === 'enumerated table, filtered', pr.table);
    rec('so the on-screen chart is certified on both legs', pr.agrees === true, pr);
    rec('that re-count is cheap enough to run on demand, not on a tap', pr.solverMs < 300 && pr.tableMs < 3000, { solverMs: pr.solverMs, tableMs: pr.tableMs });
    g.load('#/lot/battleline-03'); await sleep(150);
    const deep = g.probe({ table: false });
    rec('the deepest band still reproduces its printed numbers in the browser',
      deep.agrees && deep.printed.depth === 11 && deep.solver.depth === 11 && deep.solver.nodes === 62, deep);
    g.load('#/lot/harbour-01'); await sleep(150);
    rec('a fresh chart reads as sixteen undecided squares', g.board() === '..../..../..../....', g.board());
    rec('and the state reports itself honestly about persistence', typeof g.state.persistent === 'boolean', g.state.persistent);
    return { rows };
  })()`,

  play: `(async () => {
    const g = window.fleet;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);

    g.store.reset();
    g.load('#/lot/harbour-01'); await sleep(150);
    rec('the programmatic gestures go through the same commit path', g.drag(0, 1, 3, 'v') === true && g.state.hulls === 1, g.board());
    rec('an out-of-bounds drag is refused and counted', g.drag(3, 0, 2, 'h') === false && g.state.errors === 1 && g.state.hulls === 1, g.state);
    rec('an overlapping drag is refused', g.drag(0, 2, 2, 'h') === false && g.state.errors === 2, g.state);
    rec('a diagonal touch is refused - the rule the whole repo leans on',
      g.drag(1, 0, 2, 'h') === false && g.state.errors === 3 && /斜角/.test(D('hintline').textContent), D('hintline').textContent);
    rec('a hull length the navy does not own is refused', g.drag(1, 3, 4, 'h') === false && /船坞/.test(D('hintline').textContent), g.board());
    rec('and four refusals laid exactly one hull', g.hulls().length === 1 && g.state.hulls === 1, g.hulls());
    rec('the refusal count reaches the save file', g.store.stats.rejects === 4, g.store.stats);

    g.reset(); await sleep(120);
    rec('重开 clears the chart, the count and the card', g.board() === '..../..../..../....' && g.state.errors === 0 && D('curtain').hidden, g.state);
    rec('the tap gesture lays the shortest hull in the dock', g.tap(2, 3) === true && g.hulls()[0].len === 1 && g.state.fleetLeft.join(',') === '2,3', g.hulls());
    rec('and a tap on that hull lifts it again', g.tap(2, 3) === true && g.hulls().length === 0 && g.state.fleetLeft.join(',') === '1,2,3', g.state.fleetLeft);

    // Water may only be blacked in where no clue still needs a square.
    rec('water is refused on a line that still needs squares', g.water(1, 1) === false && g.state.marks === 0, g.board());
    rec('water is accepted where both lines read zero', g.water(1, 0) === true && g.board()[1] === '~', g.board());
    rec('marking the same square twice is not a second move', g.water(1, 0) === false && g.state.marks === 1, g.state.marks);
    rec('a pencil mark is an annotation, not a claim', g.query(3, 3) === true && g.board().includes('?') && g.state.done === false, g.board());
    rec('and it cycles back to open', g.query(3, 3) === true && !g.board().includes('?'), g.board());

    // A legal drop that overshoots a clue must not read as satisfied.
    g.reset(); await sleep(120);
    g.drag(0, 1, 3, 'v'); g.drag(2, 1, 2, 'h'); g.drag(3, 3, 1, 'h');
    const st = g.status();
    rec('an overshoot reports over, and full is not the same as correct',
      st.cols[3].have === 2 && st.cols[3].clue === 1 && st.cols[3].over === true && g.state.over === 1, st.cols[3]);
    rec('the panel shows it in red', /超线/.test(D('hintline').textContent), D('hintline').textContent);
    rec('the chart is not done with a line over', g.state.done === false, g.state);

    // The whole certified chart, through the gesture layer. A bare load() is not a fresh chart —
    // setGame() re-waters the saved draft (DESIGN.md:210), and with the overshoot block above
    // still on disk playAll finds nothing to lay.
    g.load('#/lot/harbour-01'); g.reset(); await sleep(150);
    const all = g.playAll();
    rec('the printed navy plays out through the gestures', all.laid === 3 && all.watered === 10 && all.done === true, all);
    rec('the finished chart is the one the bake certified', g.board() === '~~~~/#~##/#~~~/#~#~', g.board());
    rec('the win card goes up', D('curtain').hidden === false && /舰队就位/.test(D('verdict').textContent), D('verdict').textContent);
    rec('the card cites both legs and the measured depth', /唯一解/.test(D('tally').textContent) && /假设层数/.test(D('tally').textContent), D('tally').textContent);
    rec('the draft is dropped once the chart is solved', g.store.loadProgress('harbour-01') === null, g.store.progress);
    const rec1 = g.store.record('harbour-01');
    rec('a solve is on record at three drags', rec1 && rec1.solved && rec1.best === 3 && rec1.plays === 1, rec1);
    g.reset(); await sleep(120);
    g.playAll();
    const rec2 = g.store.record('harbour-01');
    rec('a second solve raises the play count but not the best', rec2.best === 3 && rec2.plays === 2, rec2);
    g.reset(); await sleep(120);
    g.drag(0, 1, 3, 'v'); g.drag(2, 1, 2, 'h'); g.drag(2, 3, 1, 'h');
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) g.water(x, y);
    rec('solving it again with the same drags does not move the record', g.store.record('harbour-01').best === 3, g.store.record('harbour-01'));
    // 撤销 is disabled the moment a chart is solved — @pointer pins that on the finished board —
    // so walking a session back gesture by gesture needs a chart that is still open: water every
    // square but the last, then take the ninth of those back.
    g.reset(); await sleep(120);
    g.drag(0, 1, 3, 'v'); g.drag(2, 1, 2, 'h'); g.drag(2, 3, 1, 'h');
    let watered = 0;
    for (let y = 0; y < 4 && watered < 9; y++) for (let x = 0; x < 4 && watered < 9; x++) if (g.water(x, y)) watered++;
    rec('the chart is still open with its last square unblacked', watered === 9 && g.state.done === false,
      { watered, done: g.state.done });
    const marksBefore = g.state.marks;
    rec('undo walks the session back one gesture at a time',
      g.undoOnce() === 3 && g.state.marks === marksBefore - 1 && g.hulls().length === 3,
      { marksBefore, marks: g.state.marks, watered });
    // A 6x6 with a real navy: the gesture layer must scale with the board, not special-case it.
    g.load('#/lot/blockade-01'); g.reset(); await sleep(200);
    const big = g.playAll();
    rec('a 6x6 four-hull chart plays the same way', big.done === true && g.state.n === 6 && big.laid === 4, { ...big, state: g.state });
    rec('and its printed numbers reproduce in this browser', g.probe().agrees === true, g.probe());
    g.load('#/lot/harbour-01'); await sleep(150);
    return { rows };
  })()`,

  routes: `(async () => {
    const g = window.fleet;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    g.load('#/c/12'); await sleep(150);
    rec('#/c/12 opens the twelfth chart of the ladder', g.state.index === 12 && g.state.mode === 'campaign' && g.state.id === 'harbour-12', g.state);
    g.load('#/c/99999'); await sleep(150);
    rec('a huge index clamps to the last chart', g.state.index === g.pool.charts && g.state.id === 'battleline-16', { index: g.state.index });
    g.load('#/c/0'); await sleep(150);
    rec('index zero clamps up to one', g.state.index === 1 && g.state.id === 'harbour-01', g.state.id);
    g.load('#/nonsense'); await sleep(150);
    rec('an unparseable route still deals a chart', g.state.mode === 'campaign' && g.state.index === 1, g.state);

    g.load('#/lot/sortie-03'); await sleep(150);
    rec('#/lot/<id> opens that exact chart', g.state.id === 'sortie-03' && g.state.mode === 'lot' && g.state.n === 6, g.state);
    rec('and the shared chart carries the printed evidence', g.lot().depth === 6 && g.lot().guesses === 12 && g.lot().solutionCount === 1, g.lot());
    rec('the browser re-derives the same evidence for it', g.probe().agrees === true, g.probe());
    g.load('#/lot/not-a-chart'); await sleep(150);
    rec('an unknown id falls back instead of blanking the board', !!g.state.id && g.state.mode === 'lot' && g.state.n >= 4, g.state);

    g.load('#/daily'); await sleep(150);
    const daily = g.state.id;
    const dailyDepth = g.state.depth;
    g.load('#/c/1'); await sleep(150);
    g.load('#/daily'); await sleep(150);
    rec('#/daily is the same chart twice in one session', g.state.mode === 'daily' && g.state.id === daily, { first: daily, again: g.state.id });
    rec('the daily label carries today\\'s date and the seed is that date',
      /^每日一题 · \\d{4}-\\d{2}-\\d{2}$/.test(g.state.label) && g.state.day === g.state.label.split(' · ')[1],
      { label: g.state.label, day: g.state.day });
    rec('the daily chart is a certified one', g.state.depth === dailyDepth && g.probe().agrees === true, g.probe());
    g.load('#/lot/harbour-01'); await sleep(150);
    g.load('#/daily'); await sleep(150);
    rec('re-entering #/daily still resolves to one chart', g.state.id === daily, g.state.id);

    for (const band of Object.keys(g.pool.byTier)) {
      g.load('#/random/' + band + '/fixedseed'); await sleep(120);
      const first = { id: g.state.id, tier: g.state.tier, depth: g.state.depth };
      g.load('#/c/1'); await sleep(120);
      g.load('#/random/' + band + '/fixedseed'); await sleep(120);
      const t = g.pool.byTier[band];
      rec('#/random/' + band + ' stays in its band and repeats itself',
        first.tier === band && g.state.id === first.id && first.depth >= t.depthMin && first.depth <= t.depthMax,
        { want: [t.depthMin, t.depthMax], got: first, again: g.state.id });
    }
    g.load('#/random/harbour/fixedseed'); await sleep(120);
    const h1 = g.state.id;
    g.load('#/random/patrol/fixedseed'); await sleep(120);
    rec('the same token in two bands gives two different charts', g.state.id !== h1 && g.state.tier === 'patrol', { harbour: h1, patrol: g.state.id });
    g.load('#/random'); await sleep(300);
    rec('a bare #/random mints a token into the URL', /^#\\/random\\/[a-z]+\\/[a-z0-9]+$/.test(location.hash), location.hash);
    g.load('#/c/1'); await sleep(120);
    rec('the mode buttons follow the route', (() => {
      document.querySelector('#modes button[data-mode="daily"]').click(); return true; })(), 'clicked');
    await sleep(200);
    rec('and the daily button lands on the daily chart', g.state.mode === 'daily' && g.state.id === daily, g.state);
    return { rows };
  })()`,

  save: `(async () => {
    const g = window.fleet;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const KEY = 'fleet.save.v1';

    g.load('#/c/1'); await sleep(150);
    g.store.reset();
    rec('a wipe starts the section on a clean device', Object.keys(g.store.records).length === 0 && g.store.unlocked === 1, g.store.unlocked);
    rec('the store reports itself as persistent in a real browser', g.state.persistent === true, g.state);
    g.playAll(); await sleep(200);
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('the solve reaches localStorage, not only memory', !!(raw && raw.records['harbour-01'] && raw.records['harbour-01'].best === 3), raw && Object.keys(raw.records));
    rec('clearing the first chart unlocks the second', g.store.unlocked === 2 && raw.unlocked === 2, { unlocked: g.store.unlocked, raw: raw.unlocked });
    rec('the record keeps the number of drags and plays', raw.records['harbour-01'].plays === 1 && raw.records['harbour-01'].solved === true, raw.records['harbour-01']);
    const shelf2 = document.querySelector("#shelf button[data-index='2']");
    const shelf3 = document.querySelector("#shelf button[data-index='3']");
    rec('the shelf lets chart two be clicked', !!shelf2 && !shelf2.disabled, shelf2 && shelf2.outerHTML);
    rec('and keeps chart three locked', !!shelf3 && shelf3.disabled, shelf3 && shelf3.outerHTML);
    g.load('#/c/1'); await sleep(150);
    // NOTE ON ESCAPING (this body is a template literal, so it is *source text* the page
    // compiles): a regex slash must be written doubled here.
    rec('the panel prints the record it just read back', /<div class="best"><dt>最好成绩<\\/dt><dd>3<\\/dd>/.test(D('readout').innerHTML), D('readout').innerHTML.slice(0, 400));
    rec('the header tally counts the solve', /已解 <b>1<\\/b>\\/96/.test(D('totals').innerHTML), D('totals').innerHTML);

    g.reset(); await sleep(120);
    g.load('#/c/2'); await sleep(150);
    const all2 = g.playAll(); await sleep(200);
    const id2 = g.state.id;
    const r2 = g.store.record(id2);
    rec('the second chart solves through the same gestures', all2.done === true && r2.solved === true && r2.best === 3 && r2.plays === 1, { all2, r2 });
    g.load('#/c/2'); await sleep(150);
    g.reset(); g.playAll(); await sleep(200);
    rec('replaying it does not move the best but does count the play', g.store.record(id2).best === 3 && g.store.record(id2).plays === 2, g.store.record(id2));
    rec('unlocked only goes up', (() => { const before = g.store.unlocked; g.store.unlock(1); return g.store.unlocked === before; })(), g.store.unlocked);

    // An unfinished chart is a draft, and the draft is on disk. harbour-03's row 0 is a zero-free
    // 3-run and its row 1 is a zero line, so this is a half-drawn chart that is not also over a
    // clue: water(1,1) is accepted because the drag completed both row 1 (0 needed, 0 had) and
    // column 1 (1 needed, 1 had).
    g.load('#/c/3'); await sleep(150);
    g.reset();
    g.drag(0, 0, 3, 'h');
    g.water(1, 1);
    await sleep(150);
    const draft = JSON.parse(localStorage.getItem(KEY)).progress[g.state.id];
    rec('a half-drawn chart is saved as a serialized grid', typeof draft === 'string' && draft.split('/').length === 4 && draft.includes('#'), { id: g.state.id, draft });
    rec('the draft is the same grid the shell is showing', draft === g.board(), { draft, board: g.board() });

    g.load('#/daily'); await sleep(150);
    const day = g.state.day;
    g.playAll(); await sleep(200);
    const mark = g.store.dailyDone(day);
    rec('today is logged once solved', !!mark && mark.id === g.state.id, { day, mark });
    rec('the shelf says today is done', /已解/.test(D('shelf').textContent), D('shelf').textContent);
    rec('the stats add up across the session', g.store.stats.solves >= 3 && g.store.stats.drags >= 6, g.store.stats);
    rec('and refusals are counted, never punished', g.store.stats.rejects >= 0 && /拒绝/.test(D('totals').textContent), D('totals').textContent);

    // The wipe is armed by a first click, so a stray click cannot cost anybody their record.
    D('wipe').click(); await sleep(120);
    rec('the first wipe click only arms it', Object.keys(g.store.records).length > 0 && !D('toast').hidden && /清空/.test(D('toast').textContent), {
      records: Object.keys(g.store.records).length, toast: D('toast').textContent });
    D('wipe').click(); await sleep(250);
    rec('清空存档 takes two clicks and clears everything',
      Object.keys(g.store.records).length === 0 && g.store.unlocked === 1 && localStorage.getItem(KEY) === null,
      { records: Object.keys(g.store.records), unlocked: g.store.unlocked });
    rec('and the shell re-renders as a clean device', /已解 <b>0<\\/b>/.test(D('totals').innerHTML), D('totals').innerHTML);

    // Fill the save file again, deliberately: @reloaded runs in its own process against a real
    // page load, and the only honest thing it can read back is what this run left on disk.
    g.load('#/c/1'); await sleep(150);
    g.playAll(); await sleep(200);
    rec('after the wipe the first chart solves again from scratch',
      g.store.record('harbour-01').plays === 1 && g.store.unlocked === 2 && /已解 <b>1<\\/b>/.test(D('totals').innerHTML),
      { rec: g.store.record('harbour-01'), unlocked: g.store.unlocked });
    g.load('#/c/2'); await sleep(150);
    g.playAll(); await sleep(200);
    rec('and a second chart joins it on disk', g.store.record('harbour-02').best === 3 && g.store.unlocked === 3,
      { harbour02: g.store.record('harbour-02'), unlocked: g.store.unlocked });
    g.load('#/daily'); await sleep(150);
    const dayAgain = g.state.day;
    g.playAll(); await sleep(200);
    rec('today is logged again after the wipe', !!g.store.dailyDone(dayAgain), { day: dayAgain });
    g.load('#/c/3'); await sleep(150);
    g.drag(0, 0, 3, 'h');
    g.water(1, 1);
    await sleep(150);
    rec('a draft left after the wipe is the one a reload has to restore',
      JSON.parse(localStorage.getItem(KEY)).progress['harbour-03'] === g.board(), { draft: g.board() });
    rec('and that draft is a hull plus a mark, not an over-line chart',
      g.state.hulls === 1 && g.state.marks === 1 && g.state.over === 0, g.state);
    return { rows };
  })()`,

  // Run after @save in its own process, so `eval` (without nonav) has really reloaded the page:
  // this is the only suite that can tell a warm module cache from a save on disk.
  reloaded: `(async () => {
    const g = window.fleet;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);

    rec('a fresh page reads its progress off disk', g.store.unlocked === 3 && Object.keys(g.store.records).length >= 2,
      { unlocked: g.store.unlocked, records: Object.keys(g.store.records) });
    const r1 = g.store.record('harbour-01');
    rec('and the first chart\\'s record came back', !!r1 && r1.solved === true && r1.best === 3 && r1.plays === 1, r1);
    g.load('#/c/1'); await sleep(200);
    rec('the shelf shows it as already solved', /done/.test((document.querySelector("#shelf button[data-index='1']") || {}).className || ''),
      (document.querySelector("#shelf button[data-index='1']") || {}).className);
    rec('the header counts the recovered solves', /已解 <b>\\d<\\/b>\\/96/.test(D('totals').innerHTML), D('totals').innerHTML);
    g.load('#/daily'); await sleep(200);
    rec('the daily slot is remembered across the reload', g.store.dailyDone(g.state.day) !== null, g.state);
    g.load('#/c/3'); await sleep(250);
    rec('the half-drawn fleet comes back on the chart it was left on', g.state.hulls === 1 && g.state.marks >= 1, g.state);
    const board = g.board();
    rec('and the restored grid is the saved one, hull grouping included', board.split('/').join('').includes('#')
      && g.hulls().length === 1 && g.hulls()[0].len === 3, { board, hulls: g.hulls() });
    rec('restoring does not count as a move: the draft is a session, not a solve',
      g.store.record(g.state.id) === null, g.store.record(g.state.id));
    g.store.reset();
    rec('a reset leaves nothing on disk for the next visitor', localStorage.getItem('fleet.save.v1') === null, localStorage.getItem('fleet.save.v1'));
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
