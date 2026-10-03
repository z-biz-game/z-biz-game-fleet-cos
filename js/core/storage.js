// Save file. One key, plain JSON, a versioned shape, and no reference to `window` — the
// storage backend is looked up on `globalThis` and every call into it is wrapped, because
// `localStorage` is not merely absent in some browsers: reading the property can throw
// (Safari private mode) and `setItem` can throw even when the object exists (file://, quota).
// A game that dies on its own save file is worse than one that forgets.
//
// Two monotone rules make the save reviewable rather than a bag of fields:
//   * `best` only ever goes down (a re-solve in more moves cannot make the record worse);
//   * `unlocked` only ever goes up (finishing an easy chart late cannot hide a hard one).
// Both are asserted in test/storage.test.mjs against a backend that throws.

const KEY = 'fleet.save.v1';
// 存档格式版本号。写档带上、读档校验：将来改形状时旧档宁可整档丢弃，也不能被误读。
export const SAVE_VERSION = 1;

// Records are keyed by lot id; `progress` holds an unfinished board as `board.serialize`
// text so a half-drawn fleet survives a reload. `daily` maps 'YYYY-MM-DD' to the chart and
// the moves it took.
function blank() {
  return {
    v: SAVE_VERSION,
    version: 1,
    records: {},
    progress: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, drags: 0, rejects: 0 },
  };
}

// The injected backend wins over globalThis, which is how the tests simulate a hostile
// browser without a DOM.
let injected = null;

export function setBackend(b) {
  injected = b || null;
  cache = null;
}

function backend() {
  if (injected) return injected;
  // 注入的测试替身优先；没有注入才落到真的 localStorage 上。
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
    return ls;
  } catch (err) {
    return null;
  }
}

let cache = null;

// 数字字段的归一自带一份，不依赖仓里有没有 count() —— 少一层隐式耦合。
function recordNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 存档两段式解码的第一段：整档 JSON 落到这里之后，**逐字段**归一。
// 一条记录不是"能用/不能用"二选一 —— 类型错的字段自己退成默认值，整条照样留下。
// 第二段（sanitizeRecords）在下面：它只丢掉归一后彻底没意义的记录，别的记录不受牵连。
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  out.solved = !!r.solved;
  out.best = recordNum(r.best);
  out.plays = recordNum(r.plays);
  out.at = recordNum(r.at);
  return out;
}

// 逐条隔离：坏的那条丢掉，好的那些原样留下，绝不因为一条把整份存档作废。
function sanitizeRecords(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const [id, rec] of Object.entries(p)) {
    const clean = sanitizeRecord(rec);
    if (clean) out[id] = clean;
  }
  return out;
}

function read() {
  if (cache) return cache;
  const ls = backend();
  let raw = null;
  if (ls) {
    try {
      raw = ls === globalThis.localStorage ? globalThis.localStorage.getItem(KEY) : ls.getItem(KEY);
    } catch (err) {
      raw = null;
    }
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      // 版本门：只认本仓写出去的版本。将来升 v2 时，旧档宁可整档丢弃也不能被误读成新档。
      if (p && typeof p === 'object' && !Array.isArray(p)
          && (p.v === undefined || p.v === SAVE_VERSION)) {
        const base = blank();
        cache = {
          version: 1,
          records: sanitizeRecords(p.records),
          progress: p.progress && typeof p.progress === 'object' ? p.progress : base.progress,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: Number(p.unlocked) > 0 ? Number(p.unlocked) : base.unlocked,
          stats: { ...base.stats, ...(p.stats || {}) },
        };
        return cache;
      }
    } catch (err) {
      // Corrupt JSON is not worth keeping: start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

let broken = false;

function write() {
  const ls = backend();
  if (!ls) {
    broken = true;
    return;
  }
  try {
    // backend() 没有注入时拿到的就是存储全局量本身，这里按全名写回去；
    // 注入了测试替身（injected）时走替身，替身该抛还是抛。
    if (ls === globalThis.localStorage) globalThis.localStorage.setItem(KEY, JSON.stringify(cache));
    else ls.setItem(KEY, JSON.stringify(cache));
    broken = false;
  } catch (err) {
    broken = true;
  }
}

export const store = {
  // False the moment the backend is missing or a real write fails, so the UI can say
  // "本次会话不会被保存" instead of quietly losing progress.
  persistent() {
    return !broken && !!backend();
  },

  get records() { return read().records; },
  get progress() { return read().progress; },
  get daily() { return read().daily; },
  get stats() { return read().stats; },
  get unlocked() { return read().unlocked; },

  record(id) {
    return read().records[id] || null;
  },

  unlock(n) {
    const s = read();
    if (n > s.unlocked) s.unlocked = n;
    write();
    return s.unlocked;
  },

  // `moves` is the number of hull placements the player used. `best` only decreases — the
  // honest reading is "fewest drags ever", not "last time".
  solve(id, { moves = 0 } = {}) {
    const s = read();
    const prev = s.records[id];
    const best = !prev || !Number.isFinite(prev.best) || moves < prev.best ? moves : prev.best;
    s.records[id] = {
      solved: true,
      best,
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      at: Date.now(),
    };
    s.stats.solves += 1;
    s.stats.drags += moves;
    if (s.progress) delete s.progress[id];
    write();
    return s.records[id];
  },

  // A rejected illegal drop is counted, never punished: it is the number the UI shows as
  // "不计入" so the player can see the rule biting.
  reject() {
    const s = read();
    s.stats.rejects += 1;
    write();
    return s.stats.rejects;
  },

  saveProgress(id, text) {
    const s = read();
    if (text) s.progress[id] = text;
    else delete s.progress[id];
    write();
  },

  loadProgress(id) {
    return read().progress[id] || null;
  },

  markDaily(dateKey, id) {
    const s = read();
    s.daily[dateKey] = { id, at: Date.now() };
    write();
  },

  dailyDone(dateKey) {
    return read().daily[dateKey] || null;
  },

  reset() {
    cache = blank();
    const ls = backend();
    if (ls) {
      try {
        ls.removeItem(KEY);
      } catch (err) {
        /* nothing was ever persisted */
      }
    }
    broken = false;
    return cache;
  },
};
