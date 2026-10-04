// 背景音乐：现场合成的八音盒小曲（原创旋律），C 大调五声音阶，I–vi–IV–V 走向，循环播放。
import { audioOut } from './audio';

const BPM = 88;
const EIGHTH = 60 / BPM / 2;
const _ = null;

// 每小节 8 个八分音符（MIDI 音高），16 小节一轮
const MELODY: (number | null)[][] = [
  [76, _, 79, 76, 74, _, 72, _], [74, 76, 79, _, 81, 79, 76, _], // C
  [81, _, 79, 76, 72, _, 74, 76], [72, _, _, 69, 72, _, _, _], // Am
  [77, _, 76, 72, 69, _, 72, 74], [76, _, 74, 72, 74, _, _, _], // F
  [79, _, 81, 79, 76, _, 74, _], [74, 76, 74, 71, 74, _, _, _], // G
  [72, 74, 76, _, 79, _, 76, 74], [76, _, 79, _, 84, _, 81, _], // C
  [81, 79, 76, _, 79, _, 76, 72], [74, _, 72, _, 69, _, _, _], // Am
  [72, _, 69, 72, 77, _, 76, _], [74, 72, 74, _, 76, _, _, _], // F
  [79, _, 76, _, 74, _, 71, _], [72, _, _, _, _, _, _, _], // G → C
];
const BASS = [48, 48, 45, 45, 41, 41, 43, 43, 48, 48, 45, 45, 41, 41, 43, 48];
const CHORDS: Record<number, number[]> = { 48: [60, 64, 67], 45: [57, 60, 64], 41: [57, 60, 65], 43: [59, 62, 67] };

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

let gain: GainNode | null = null;
let timer = 0;
let nextTime = 0;
let step = 0;
let playing = false;

/** 八音盒音色：正弦 + 高八度泛音，快速衰减 */
function musicBox(ctx: AudioContext, out: AudioNode, midi: number, t: number, vel: number) {
  for (const [mul, amp, dec] of [[1, 1, 1.4], [2, 0.35, 0.5], [3.01, 0.12, 0.25]] as const) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz(midi) * mul;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel * amp, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dec + 0.05);
  }
}

function softTone(ctx: AudioContext, out: AudioNode, midi: number, t: number, dur: number, vel: number, type: OscillatorType) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = hz(midi);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function schedule() {
  const a = audioOut();
  if (!a || !gain) return;
  const { ctx } = a;
  while (nextTime < ctx.currentTime + 0.25) {
    const bar = Math.floor(step / 8) % MELODY.length;
    const i = step % 8;
    const note = MELODY[bar][i];
    // 轻微摇摆，听起来更像手摇八音盒
    const t = nextTime + (i % 2 === 1 ? EIGHTH * 0.08 : 0);
    if (note !== null) musicBox(ctx, gain, note, t, i % 4 === 0 ? 0.22 : 0.16);
    if (i === 0 || i === 4) softTone(ctx, gain, BASS[bar], t, EIGHTH * 3.5, 0.13, 'sine');
    if (i === 0) for (const n of CHORDS[BASS[bar]]) softTone(ctx, gain, n, t, EIGHTH * 7.5, 0.025, 'triangle');
    nextTime += EIGHTH;
    step++;
  }
}

export const music = {
  volume: 0.55,
  start() {
    const a = audioOut();
    if (!a || playing) return;
    if (!gain) {
      gain = a.ctx.createGain();
      gain.connect(a.master);
    }
    gain.gain.cancelScheduledValues(a.ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, a.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(this.volume, a.ctx.currentTime + 1.5);
    nextTime = a.ctx.currentTime + 0.1;
    playing = true;
    schedule();
    timer = window.setInterval(schedule, 60);
  },
  stop() {
    const a = audioOut();
    if (!playing || !a || !gain) return;
    playing = false;
    clearInterval(timer);
    gain.gain.cancelScheduledValues(a.ctx.currentTime);
    gain.gain.setTargetAtTime(0.0001, a.ctx.currentTime, 0.3);
  },
  get playing() {
    return playing;
  },
};
