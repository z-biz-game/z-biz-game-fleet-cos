// Sound. Four voices, one AudioContext, and a mute that actually stops the machine.
//
// Why a mute has to suspend the context rather than zero a gain: a gain of 0 still allocates
// and starts an OscillatorNode per event, so "muted" in the string sense and "muted" in the
// battery sense are different programs. The brief for this repo is explicit about it (§2), and
// `test/audio.test.mjs` asserts the difference against a fake AudioContext: while muted,
// `play()` must create **zero** nodes and must not resume the clock.
//
// Nothing here is loaded from disk: the voices are oscillator shapes, consistent with the rest
// of the repo (no binary assets beyond the generated bitmaps, and no audio files to license).

const SHAPES = {
  // name: [ [freq, dur, type, gain], ... ] — a voice is a short arpeggio, played in sequence.
  place: [[392, 0.07, 'triangle', 0.16], [587.33, 0.09, 'triangle', 0.13]],
  refuse: [[138.59, 0.11, 'sawtooth', 0.13], [110, 0.14, 'sawtooth', 0.1]],
  water: [[880, 0.035, 'sine', 0.07]],
  mark: [[1174.66, 0.03, 'sine', 0.05]],
  win: [[523.25, 0.09, 'triangle', 0.15], [659.25, 0.09, 'triangle', 0.15], [783.99, 0.16, 'triangle', 0.16]],
  hint: [[659.25, 0.05, 'sine', 0.08], [880, 0.07, 'sine', 0.07]],
};

export const VOICES = Object.keys(SHAPES);

// The browser will not start an AudioContext from a script that was not triggered by a user
// gesture, so the context is created lazily on the first sound a tap or a key produced.
function engine(env) {
  const AC = env.AudioContext || env.webkitAudioContext;
  if (typeof AC !== 'function') return null;
  try {
    return new AC();
  } catch {
    return null;
  }
}

export function createAudio(env = globalThis, hooks = {}) {
  let ctx = null;
  let muted = false;
  try {
    // '0' 是 truthy 字符串，所以这里必须比 '1'，不能 !!getItem()。
    muted = env.localStorage?.getItem?.('fleet.sound.muted') === '1';
  } catch {
    muted = false;
  }
  let created = 0; // nodes ever started, for the test surface
  let lastError = '';

  function persistMuted(on) {
    try {
      const ls = env.localStorage;
      if (ls && typeof ls.setItem === 'function') ls.setItem('fleet.sound.muted', on ? '1' : '0');
    } catch {
      /* private mode: the preference just does not survive the session */
    }
  }

  function ensure() {
    if (ctx) return ctx;
    ctx = engine(env);
    if (!ctx) lastError = 'no-audiocontext';
    return ctx;
  }

  // A voice is scheduled entirely up front and self-cancelling: every oscillator gets a stop()
  // at a fixed offset, so a fired sound cannot outlive its own frame and stack up behind a
  // muted toggle.
  function play(name) {
    const shape = SHAPES[name];
    if (!shape) {
      lastError = `unknown-voice:${name}`;
      return false;
    }
    if (muted) return false; // 静音态：不新建节点、不唤醒时钟
    const c = ensure();
    if (!c) return false;
    if (c.state === 'suspended' && typeof c.resume === 'function') {
      try { c.resume(); } catch (err) { lastError = String(err && err.name); }
    }
    let at = c.currentTime;
    for (const [freq, dur, type, gain] of shape) {
      const osc = c.createOscillator();
      const amp = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, at);
      amp.gain.setValueAtTime(0.0001, at);
      amp.gain.exponentialRampToValueAtTime(gain, at + 0.008);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(amp);
      amp.connect(c.destination);
      osc.start(at);
      osc.stop(at + dur + 0.01);
      created += 1;
      at += dur * 0.85;
    }
    if (hooks.onPlay) hooks.onPlay(name);
    return true;
  }

  function setMuted(on) {
    muted = !!on;
    persistMuted(muted);
    if (!ctx) return muted;
    try {
      // 真停：静音挂起整个上下文（时钟也停），恢复时再唤醒。已经排好的声音不会
      // 在静音期间继续跑，因为上下文一挂起 currentTime 就不前进了。
      if (muted && typeof ctx.suspend === 'function') ctx.suspend();
      else if (!muted && typeof ctx.resume === 'function') ctx.resume();
    } catch (err) {
      lastError = String(err && err.name);
    }
    return muted;
  }

  return {
    play,
    voices: VOICES,
    toggle() { return setMuted(!muted); },
    setMuted,
    isMuted: () => muted,
    // 暂停/恢复：与静音是两件事。暂停期间不许有声音继续跑，但玩家的偏好不变。
    hold() {
      if (ctx && !muted && typeof ctx.suspend === 'function') { try { ctx.suspend(); } catch { /* noop */ } }
    },
    release() {
      if (ctx && !muted && typeof ctx.resume === 'function') { try { ctx.resume(); } catch { /* noop */ } }
    },
    state() {
      return { muted, hasContext: !!ctx, ctxState: ctx ? ctx.state : 'none', created, lastError };
    },
    // Only for the test surface: how many nodes the last gesture allocated.
    reset() { created = 0; lastError = ''; },
  };
}
