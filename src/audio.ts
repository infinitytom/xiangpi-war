// 用 WebAudio 现场合成音效，不需要音频文件
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
export const audioSettings = { enabled: true };

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function burst(opts: { freq: number; q: number; dur: number; vol: number; type?: BiquadFilterType; tone?: number; toneDur?: number }) {
  if (!ctx || !master || !noiseBuf || !audioSettings.enabled) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = opts.type ?? 'bandpass';
  f.frequency.value = opts.freq;
  f.Q.value = opts.q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(opts.vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + opts.dur + 0.02);
  if (opts.tone) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(opts.tone, t);
    o.frequency.exponentialRampToValueAtTime(opts.tone * 0.6, t + (opts.toneDur ?? 0.08));
    const og = ctx.createGain();
    og.gain.setValueAtTime(opts.vol * 0.6, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + (opts.toneDur ?? 0.08));
    o.connect(og).connect(master);
    o.start(t);
    o.stop(t + (opts.toneDur ?? 0.08) + 0.02);
  }
}

/** 指甲弹到橡皮的「啪」 */
export function sfxFlick(strength: number) {
  const s = Math.min(1, strength);
  burst({ freq: 1800 + s * 1800, q: 1.2, dur: 0.035 + s * 0.02, vol: 0.25 + s * 0.6, tone: 300 + s * 200, toneDur: 0.04 });
}

/** 橡皮互撞的闷响 */
export function sfxHit(strength: number) {
  const s = Math.min(1, strength);
  if (s < 0.03) return;
  burst({ freq: 700 + s * 500, q: 0.9, dur: 0.06 + s * 0.05, vol: 0.2 + s * 0.7, type: 'lowpass', tone: 160 + s * 60, toneDur: 0.07 });
}

/** 掉到水磨石地面 */
export function sfxFloor() {
  burst({ freq: 2400, q: 2, dur: 0.05, vol: 0.5, tone: 520, toneDur: 0.05 });
  setTimeout(() => burst({ freq: 2600, q: 2, dur: 0.03, vol: 0.18, tone: 560, toneDur: 0.03 }), 110);
}

export function sfxTick() {
  burst({ freq: 3200, q: 4, dur: 0.02, vol: 0.12 });
}

/** 滑动摩擦声：level 0–1，按所有橡皮的滑动速度每帧调用 */
let slideGain: GainNode | null = null;
export function sfxSlide(level: number) {
  if (!ctx || !master || !noiseBuf) return;
  if (!slideGain) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 650;
    f.Q.value = 0.6;
    slideGain = ctx.createGain();
    slideGain.gain.value = 0;
    src.connect(f).connect(slideGain).connect(master);
    src.start();
  }
  const v = audioSettings.enabled ? Math.min(1, level) * 0.22 : 0;
  slideGain.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
}
