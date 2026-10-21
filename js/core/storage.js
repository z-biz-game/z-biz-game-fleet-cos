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

// 默认后端是浏览器自己的 localStorage，但逐字写出来：每次调用都重新取值 ——
// 私密模式下读属性本身就会抛，页面也可能中途从"没有存储"变成"有"（或反过来）。
function backend() {
  if (injected) return injected;
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    if (typeof localStorage.getItem !== 'function' || typeof localStorage.setItem !== 'function') return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
      removeItem: (k) => localStorage.removeItem(k),
    };
  } catch (err) {
    return null;
  }
}

let cache = null;

// 第二段解码记下丢了几条：坏数据静默消失是另一种 bug，测试与 `store.audit()` 要能看见它。
let audit = { records: 0, daily: 0, progress: 0, stats: 0 };

// 非负的有限数向下取整；字符串、NaN、Infinity、负数一律不认 —— 宁缺毋滥，缺的由调用方补默认值。
function whole(v) {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function stamp(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// 一条记录：不是对象（null、数字、字符串、数组）就丢掉这一条；是对象就把字段修回可用形状。
// best 认不到就留 null（"还没通"和"通了但 0 次"是两回事），别拿 0 顶替。
function decodeRecord(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const plays = whole(v.plays);
  const best = whole(v.best);
  return {
    solved: v.solved === true,
    best: best === null ? null : best,
    plays: plays === null ? 0 : plays,
    at: stamp(v.at),
  };
}

function decodeRecords(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (Array.isArray(raw)) audit.records += raw.length;
    return out;
  }
  for (const [id, v] of Object.entries(raw)) {
    const rec = decodeRecord(v);
    if (rec) out[id] = rec;
    else audit.records += 1; // 丢的只有这一条，其它记录照常读出来
  }
  return out;
}

function decodeDaily(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [day, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && typeof v.id === 'string' && v.id) out[day] = { id: v.id, at: stamp(v.at) };
    else audit.daily += 1;
  }
  return out;
}

// 草稿是 `board.serialize` 的文本：只有字符串可能是它，其它一律不认 —— 半张图恢复不了
// 也比把一个对象当成图铺开要好。
function decodeProgress(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, text] of Object.entries(raw)) {
    if (typeof text === 'string' && text) out[id] = text;
    else audit.progress += 1;
  }
  return out;
}

function decodeStats(raw) {
  const base = blank().stats;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    const n = whole(raw[key]);
    if (n === null) audit.stats += 1; // 这一个计数器退回默认值，别的照常
    else out[key] = n;
  }
  return out;
}

function read() {
  if (cache) return cache;
  const ls = backend();
  let raw = null;
  if (ls) {
    try {
      raw = ls.getItem(KEY);
    } catch (err) {
      raw = null;
    }
  }
  if (raw) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // 第一段：整份 JSON 坏了就不值得留 —— 读成一台干净设备，而不是把 shell 一起带走。
      parsed = null;
    }
    // 版本门：只认本仓写出去的版本。将来升 v2 时，旧档宁可整档丢弃也不能被误读成新档。
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed.v === undefined || parsed.v === SAVE_VERSION)) {
      const base = blank();
      const unlocked = whole(parsed.unlocked);
      audit = { records: 0, daily: 0, progress: 0, stats: 0 };
      cache = {
        v: SAVE_VERSION,
        version: 1,
        // 第二段：逐条、逐键、逐字段过一遍，坏的只丢它自己。
        records: decodeRecords(parsed.records),
        progress: decodeProgress(parsed.progress),
        daily: decodeDaily(parsed.daily),
        unlocked: unlocked === null || unlocked < 1 ? base.unlocked : unlocked,
        stats: decodeStats(parsed.stats),
      };
      return cache;
    }
  }
  audit = { records: 0, daily: 0, progress: 0, stats: 0 };
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
    ls.setItem(KEY, JSON.stringify(cache));
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

  // 上一次解码丢掉了什么。0 是常态；不是 0 就说明磁盘上那份是坏的，而游戏照样能跑。
  audit() {
    read(); // 没有解码过就没有账可查：先读一次，报的才是这份磁盘内容的真话
    return { ...audit };
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
    audit = { records: 0, daily: 0, progress: 0, stats: 0 };
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
