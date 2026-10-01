// js/audio.js against a fake AudioContext. The point of the whole file is one claim: muted
// means the machine stops, not that somebody turned the volume knob to zero. That claim is only
// checkable by counting node allocations, which is exactly what the fake below makes visible.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { createAudio, VOICES } from '../js/audio.js';

class FakeCtx {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = { connect() {} };
    this.osc = 0;
    this.gain = 0;
    this.starts = 0;
    this.stops = 0;
    this.suspends = 0;
    this.resumes = 0;
  }

  createOscillator() {
    const self = this;
    this.osc += 1;
    return {
      type: 'sine',
      frequency: { setValueAtTime() {} },
      connect() {},
      start() { self.starts += 1; },
      stop() { self.stops += 1; },
    };
  }

  createGain() {
    this.gain += 1;
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }

  suspend() { this.suspends += 1; this.state = 'suspended'; }
  resume() { this.resumes += 1; this.state = 'running'; }
}

const makeEnv = (ctx = new FakeCtx(), storage = null) => ({
  AudioContext: function Ctor() { return ctx; },
  localStorage: storage,
});

test('每个声音都是"起一次、停一次"，不留活口', () => {
  const ctx = new FakeCtx();
  const a = createAudio(makeEnv(ctx));
  for (const v of VOICES) eq(a.play(v), true, `${v} 应该能播`);
  ok(ctx.osc > 0 && ctx.osc === ctx.starts, `振荡器都该被 start：osc=${ctx.osc} starts=${ctx.starts}`);
  eq(ctx.stops, ctx.starts, '每个 start 都要有一个 stop，否则静音后还有声音排队');
  eq(ctx.gain, ctx.osc, '每个振荡器接一个增益');
});

test('静音态不新建任何节点（把 gain 设 0 的那种假静音过不了这条）', () => {
  const ctx = new FakeCtx();
  const a = createAudio(makeEnv(ctx));
  a.play('place');
  const before = ctx.osc;
  ok(before > 0, '先确认非静音时确实建了节点');
  a.setMuted(true);
  a.reset();
  eq(a.play('place'), false, '静音时 play() 必须返回 false');
  eq(a.play('win'), false);
  eq(a.play('refuse'), false);
  eq(ctx.osc, before, '静音期间一个节点都不许新建');
  eq(ctx.starts, before, '静音期间不许 start 任何振荡器');
  eq(a.state().created, 0, '计数器也必须归零');
});

test('静音真的挂起上下文，取消静音才唤醒', () => {
  const ctx = new FakeCtx();
  const a = createAudio(makeEnv(ctx));
  a.play('water'); // 首次发声才建上下文
  eq(a.state().hasContext, true);
  a.setMuted(true);
  ok(ctx.suspends >= 1, '静音必须调用 suspend()');
  eq(ctx.state, 'suspended');
  a.setMuted(false);
  ok(ctx.resumes >= 1, '取消静音必须调用 resume()');
  eq(ctx.state, 'running');
});

test('播放时上下文处于 suspended 会先唤醒（自动播放策略下的第一声）', () => {
  const ctx = new FakeCtx();
  ctx.state = 'suspended';
  const a = createAudio(makeEnv(ctx));
  eq(a.play('mark'), true);
  ok(ctx.resumes >= 1, '第一声要把时钟叫醒');
  eq(ctx.state, 'running');
});

test('暂停是 hold/release，且不会替玩家改静音偏好', () => {
  const ctx = new FakeCtx();
  const a = createAudio(makeEnv(ctx));
  a.play('place');
  a.hold();
  ok(ctx.suspends >= 1, '暂停要挂起音频');
  eq(a.isMuted(), false, '暂停不是静音');
  a.release();
  ok(ctx.resumes >= 1, '恢复要唤醒音频');
  eq(a.isMuted(), false);
  // 静音中暂停再恢复，不许把声音放出来
  a.setMuted(true);
  a.hold();
  a.release();
  eq(ctx.state, 'suspended', '静音态下 release() 不得 resume');
  eq(a.isMuted(), true);
});

test('没有 AudioContext 的环境：不响、不抛、如实回报', () => {
  const a = createAudio({});
  eq(a.play('place'), false);
  eq(a.state().hasContext, false);
  eq(a.state().lastError, 'no-audiocontext');
  eq(a.setMuted(true), true, '静音开关本身仍然可用');
});

test('未知音色不发声并记录原因', () => {
  const a = createAudio(makeEnv(new FakeCtx()));
  eq(a.play('nope'), false);
  ok(a.state().lastError.startsWith('unknown-voice:'), a.state().lastError);
});

test('静音偏好落盘，且 \'0\' 不会被读成"静音"', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
  const a = createAudio(makeEnv(new FakeCtx(), storage));
  a.setMuted(true);
  eq(mem.get('fleet.sound.muted'), '1');
  a.setMuted(false);
  eq(mem.get('fleet.sound.muted'), '0');
  // 重新"刷新"一次：'0' 是 truthy 字符串，直接 !!getItem 会把取消静音的玩家读成静音。
  const b = createAudio(makeEnv(new FakeCtx(), storage));
  eq(b.isMuted(), false, "存成 '0' 的偏好必须读回 false");
  b.setMuted(true);
  const c = createAudio(makeEnv(new FakeCtx(), storage));
  eq(c.isMuted(), true, '存成 1 的偏好要跨刷新生效');
});

test('toggle 与 state 的口径一致', () => {
  const a = createAudio(makeEnv(new FakeCtx()));
  const was = a.isMuted();
  eq(a.toggle(), !was);
  eq(a.state().muted, !was);
  eq(a.toggle(), was);
});

run();
