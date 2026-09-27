// The save file, against a browser that misbehaves.
//
// js/core/storage.js looks its backend up on `globalThis` and wraps every call, so these cases
// hand it three backends: a working one, a hostile one that throws on every property access
// (Safari private mode), and none at all (node, and the file:// origin). What has to survive is
// the game: the record rules are `best` only goes down and `unlocked` only goes up, and a wipe
// has to reach the disk.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { store, setBackend } from '../js/core/storage.js';

const KEY = 'fleet.save.v1';

function memoryBackend(over = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get raw() { return map.get(KEY) || null; },
    ...over,
  };
}

function hostileBackend() {
  // Present, and every method refuses (Safari private mode, or a quota-exhausted origin).
  return {
    getItem() { throw new Error('SecurityError: blocked'); },
    setItem() { throw new Error('SecurityError: blocked'); },
    removeItem() { throw new Error('SecurityError: blocked'); },
  };
}

function throwingWrite(backend) {
  return { ...backend, setItem() { throw new Error('QuotaExceededError'); } };
}

test('with no backend at all the store still remembers, in memory', () => {
  setBackend(null);
  eq(typeof globalThis.window, 'undefined', 'this file runs under node: there is no localStorage to find');
  store.reset();
  eq(store.persistent(), false, 'and it says so, so the UI can warn the player');
  const r = store.solve('harbour-01', { moves: 4 });
  eq([r.solved, r.best, r.plays], [true, 4, 1]);
  eq(store.record('harbour-01').best, 4, 'the record is readable back');
  eq(store.unlocked, 1);
  eq(store.unlock(3), 3, 'unlocking works without a disk');
  eq(store.stats.solves, 1);
});

test('a hostile globalThis.localStorage is treated as absent, not as fatal', () => {
  // The Safari-private-mode path: touching the property itself throws. `setBackend` cannot
  // stand in for this, because storage.js validates what it finds on globalThis and hands an
  // injected backend through unchecked — so the property is installed for real here.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: access denied'); },
  });
  try {
    setBackend(null);
    store.reset();
    eq(store.persistent(), false, 'a throwing property reads as no backend at all');
    eq(store.solve('patrol-01', { moves: 5 }).best, 5, 'the solve still happened');
    store.saveProgress('patrol-01', '~~../...');
    eq(store.loadProgress('patrol-01'), '~~../...', 'and the half-drawn chart is kept for this session');
    eq(store.reject(), 1, 'refusals count too');
    eq(store.unlocked, 1);
  } finally {
    // Node ships a `localStorage` accessor on globalThis; a bare delete would leave the suite
    // running against a different global than it started with.
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
    eq(!!Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), !!had, 'the property is left as it was found');
  }
});

test('a backend whose methods throw degrades the moment a write is asked for', () => {
  // The other failure shape: the object is there, every call on it is not. `backend()` trusts
  // an injected backend (that is what injection is for), so the honest promise here is that
  // the first failed write flips `persistent()` rather than escaping into the shell.
  setBackend(hostileBackend());
  store.reset();
  let threw = null;
  try { store.solve('harbour-01', { moves: 6 }); } catch (err) { threw = String(err.message); }
  eq(threw, null, 'the store never throws at the shell');
  eq(store.persistent(), false, 'and it says it is not persisting');
  eq(store.record('harbour-01').best, 6, 'the session record is still readable');
});

test('a write that throws on quota degrades instead of crashing', () => {
  const b = throwingWrite(memoryBackend());
  setBackend(b);
  store.reset();
  eq(store.persistent(), true, 'the backend is there until a write fails');
  let threw = null;
  try { store.solve('convoy-01', { moves: 6 }); } catch (err) { threw = String(err.message); }
  eq(threw, null, 'the throw is swallowed, not surfaced to the shell');
  eq(store.persistent(), false, 'and the store now reports itself unpersisted');
  eq(store.record('convoy-01').best, 6, 'the in-memory record is intact');
});

test('best only ever goes down', () => {
  setBackend(memoryBackend());
  store.reset();
  eq(store.solve('harbour-02', { moves: 7 }).best, 7, 'first run sets the bar');
  eq(store.solve('harbour-02', { moves: 9 }).best, 7, 'a sloppier repeat cannot raise it');
  eq(store.solve('harbour-02', { moves: 5 }).best, 5, 'a better one takes it down');
  eq(store.solve('harbour-02', { moves: 6 }).best, 5);
  const rec = store.record('harbour-02');
  eq([rec.solved, rec.plays, rec.best], [true, 4, 5], 'plays counts every run, best keeps the minimum');
  eq(store.stats.solves, 4);
  eq(store.stats.drags, 27, 'the drags tally is the sum of every run, not of the bests');
});

test('unlocked only ever goes up', () => {
  const b = memoryBackend();
  setBackend(b);
  store.reset();
  eq(store.unlocked, 1);
  eq(store.unlock(5), 5);
  eq(store.unlock(2), 5, 'finishing an early chart late cannot relock the ladder');
  eq(store.unlock(5), 5, 'the same value is not a regression');
  eq(store.unlock(6), 6);
  eq(store.unlocked, 6);
});

test('progress is a draft, and solving throws the draft away', () => {
  setBackend(memoryBackend());
  store.reset();
  store.saveProgress('blockade-03', '..../..../..../....');
  eq(store.loadProgress('blockade-03'), '..../..../..../....');
  eq(Object.keys(store.progress).length, 1);
  store.solve('blockade-03', { moves: 3 });
  eq(store.loadProgress('blockade-03'), null, 'a finished chart has no draft to resume');
  store.saveProgress('blockade-03', 'x');
  store.saveProgress('blockade-03', '');
  eq(store.loadProgress('blockade-03'), null, 'saving an empty draft deletes it');
});

test('daily marks are per date and survive nothing but a wipe', () => {
  setBackend(memoryBackend());
  store.reset();
  eq(store.dailyDone('2026-03-04'), null);
  store.markDaily('2026-03-04', 'sortie-02');
  const mark = store.dailyDone('2026-03-04');
  eq(mark.id, 'sortie-02');
  ok(Number.isFinite(mark.at), 'and it remembers when');
  eq(store.dailyDone('2026-03-05'), null, 'yesterday is not today');
});

test('the shape on disk is the shape in memory, and junk on disk is survivable', () => {
  const b = memoryBackend();
  setBackend(b);
  store.reset();
  store.solve('harbour-03', { moves: 4 });
  store.unlock(2);
  store.markDaily('2026-03-04', 'harbour-03');
  const raw = JSON.parse(b.raw);
  eq(raw.version, 1);
  eq(Object.keys(raw.records), ['harbour-03']);
  eq(raw.records['harbour-03'].best, 4);
  eq(raw.unlocked, 2);
  eq(raw.daily['2026-03-04'].id, 'harbour-03');
  eq(store.persistent(), true);

  // Now the same store with garbage where the save should be.
  const junk = memoryBackend();
  junk.setItem(KEY, '{not json at all');
  setBackend(junk);
  store.reset();
  setBackend(junk);
  junk.setItem(KEY, '{not json at all');
  eq(store.unlocked, 1, 'a corrupt file reads as a clean device');
  eq(store.solve('harbour-01', { moves: 3 }).best, 3, 'and the game still plays');
  eq(JSON.parse(junk.raw).records['harbour-01'].best, 3, 'the next write replaced the junk');

  const partial = memoryBackend();
  setBackend(partial);
  store.reset();
  setBackend(partial);
  partial.setItem(KEY, JSON.stringify({ version: 1, unlocked: -4, records: null }));
  eq(store.unlocked, 1, 'a nonsense unlock count is reset, not honoured');
  eq(Object.keys(store.records).length, 0);
  eq(store.stats.rejects, 0, 'missing stats fill in at their defaults');
});

test('a reset really clears, on disk and not only in the cache', () => {
  const b = memoryBackend();
  setBackend(b);
  store.reset();
  store.solve('battleline-01', { moves: 8 });
  store.unlock(9);
  store.saveProgress('battleline-01', '~~');
  ok(b.raw !== null, 'something was written');
  store.reset();
  eq(b.raw, null, 'and the wipe removed it from the backend');
  eq(Object.keys(store.records).length, 0);
  eq(store.unlocked, 1);
  eq(store.loadProgress('battleline-01'), null);
  eq(store.stats.solves, 0);
  eq(store.persistent(), true, 'a wiped store is still a working store');
});

test('the store is one cache, so two reads of the same record cannot disagree', () => {
  setBackend(memoryBackend());
  store.reset();
  store.solve('harbour-04', { moves: 6 });
  const a = store.record('harbour-04');
  const b = store.records['harbour-04'];
  eq(a, b);
  eq(store.record('no-such-lot'), null, 'an unsolved chart has no record, rather than a zero');
  store.reject();
  eq(store.stats.rejects, 1);
  ok(store.stats.solves === 1 && store.stats.rejects === 1, 'both counters live in the same read object');
});

run();
