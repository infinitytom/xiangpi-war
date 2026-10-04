// 程序化贴图：老课桌、水磨石地面、用旧的橡皮。全部在 canvas 上画，不依赖外部图片。
import * as THREE from 'three';

const KAI = '"KaiTi","STKaiti","Kaiti SC","楷体",serif';

// ---------- 噪声 ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed: number) {
  const rnd = mulberry32(seed);
  const N = 256;
  const perm = new Uint8Array(N * 2);
  const vals = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    perm[i] = i;
    vals[i] = rnd();
  }
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const fade = (t: number) => t * t * (3 - 2 * t);
  const v2 = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const a = vals[perm[perm[X] + Y]], b = vals[perm[perm[X + 1] + Y]];
    const c = vals[perm[perm[X] + Y + 1]], d = vals[perm[perm[X + 1] + Y + 1]];
    const u = fade(xf), w = fade(yf);
    return lerp(lerp(a, b, u), lerp(c, d, u), w);
  };
  const fbm = (x: number, y: number, oct = 4) => {
    let s = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) {
      s += amp * v2(x * f, y * f);
      f *= 2;
      amp *= 0.5;
    }
    return s;
  };
  return { v2, fbm, rnd };
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function toTex(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// ---------- 课桌桌面 ----------
export function deskTop(pxPerUnit = 170) {
  const W = Math.round(12 * pxPerUnit), H = Math.round(8 * pxPerUnit);
  const { c, g } = canvas(W, H);
  const { fbm, v2, rnd } = makeNoise(1987);
  const img = g.createImageData(W, H);
  const d = img.data;
  // 木纹：沿 x 方向的长条纹理（桌板是横向拼板）
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = x / W, ny = y / H;
      const warp = fbm(nx * 3, ny * 8, 3) * 2.2;
      const ring = Math.sin((ny * 38 + warp * 4 + fbm(nx * 1.5, ny * 2) * 3) * Math.PI);
      const grain = Math.pow(Math.abs(ring), 0.35);
      const fine = v2(x * 0.9, y * 0.06) * 0.5 + v2(x * 0.05, y * 2.2) * 0.5;
      const plank = Math.floor(ny * 3.0); // 三块拼板
      const plankTone = [0.0, 0.05, -0.03][plank] ?? 0;
      let t = 0.55 + grain * 0.25 + (fine - 0.5) * 0.18 + plankTone;
      // 磨损：手肘常压的地方清漆磨掉，颜色发白发灰
      const wear = fbm(nx * 2.5 + 7, ny * 2.5, 4);
      const elbowL = Math.exp(-(((nx - 0.18) / 0.16) ** 2 + ((ny - 0.85) / 0.2) ** 2));
      const elbowR = Math.exp(-(((nx - 0.82) / 0.16) ** 2 + ((ny - 0.85) / 0.2) ** 2));
      const worn = Math.min(1, Math.max(0, wear - 0.52) * 3 + (elbowL + elbowR) * 0.45);
      // 边缘积灰发黑
      const ex = Math.min(nx, 1 - nx) * W, ey = Math.min(ny, 1 - ny) * H;
      const edge = Math.max(0, 1 - Math.min(ex, ey) / (pxPerUnit * 0.45));
      let r = 168 * t + 40, gg = 112 * t + 28, b = 58 * t + 14;
      // 清漆偏黄偏红
      r = r * (1 - worn) + (r * 0.8 + 45) * worn;
      gg = gg * (1 - worn) + (gg * 0.85 + 38) * worn;
      b = b * (1 - worn) + (b * 0.9 + 34) * worn;
      const dark = 1 - edge * 0.45;
      const i = (y * W + x) * 4;
      d[i] = r * dark;
      d[i + 1] = gg * dark;
      d[i + 2] = b * dark;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // 拼板缝
  g.strokeStyle = 'rgba(40,22,10,0.55)';
  g.lineWidth = 2;
  for (const fy of [1 / 3, 2 / 3]) {
    g.beginPath();
    g.moveTo(0, fy * H);
    for (let x = 0; x <= W; x += 40) g.lineTo(x, fy * H + Math.sin(x * 0.01) * 1.5);
    g.stroke();
  }

  // 划痕：浅色细线
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, y = rnd() * H;
    const len = 20 + rnd() * 160, a = (rnd() - 0.5) * 0.8 + (rnd() < 0.5 ? 0 : Math.PI / 2) * 0.15;
    g.strokeStyle = `rgba(235,205,160,${0.08 + rnd() * 0.18})`;
    g.lineWidth = 0.6 + rnd() * 1.1;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 10, y + Math.sin(a) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }

  // 三八线：中间一道刻痕 + 圆珠笔反复描过的线
  const cx = W / 2;
  g.save();
  g.strokeStyle = 'rgba(30,15,5,0.6)';
  g.lineWidth = 3.2;
  g.beginPath();
  for (let y = 10; y < H - 10; y += 12) {
    const x = cx + Math.sin(y * 0.013) * 3 + (rnd() - 0.5) * 1.5;
    y === 10 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  for (let k = 0; k < 4; k++) {
    g.strokeStyle = `rgba(28,45,120,${0.35 + rnd() * 0.25})`;
    g.lineWidth = 1.4 + rnd() * 0.8;
    g.beginPath();
    for (let y = 30 + rnd() * 30; y < H - 30 - rnd() * 40; y += 14) {
      const x = cx + Math.sin(y * 0.013) * 3 + (rnd() - 0.5) * 3 + 3;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.restore();

  // 圆珠笔 / 铅笔涂鸦
  const ink = (a: number) => `rgba(32,48,128,${a})`;
  g.font = `${pxPerUnit * 0.34}px ${KAI}`;
  g.fillStyle = ink(0.45);
  g.save();
  g.translate(cx + pxPerUnit * 0.25, H * 0.12);
  g.rotate(0.05);
  g.fillText('越线的是小狗', 0, 0);
  g.restore();
  g.save();
  g.translate(pxPerUnit * 1.2, H * 0.2);
  g.rotate(-0.12);
  g.fillStyle = 'rgba(70,70,70,0.32)';
  g.font = `${pxPerUnit * 0.3}px ${KAI}`;
  g.fillText('好好学习 天天向上', 0, 0);
  g.restore();
  // 刻出来的「早」
  g.save();
  g.translate(W - pxPerUnit * 1.7, H - pxPerUnit * 1.4);
  g.rotate(0.2);
  g.font = `bold ${pxPerUnit * 0.62}px ${KAI}`;
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(25,12,4,0.55)';
  g.strokeText('早', 0, 0);
  g.strokeStyle = 'rgba(230,190,140,0.25)';
  g.lineWidth = 1;
  g.strokeText('早', 2, 2);
  g.restore();
  // 圆规扎的小坑
  for (let i = 0; i < 40; i++) {
    const x = rnd() * W, y = rnd() * H;
    g.fillStyle = 'rgba(20,10,4,0.55)';
    g.beginPath();
    g.arc(x, y, 1.2 + rnd() * 1.2, 0, Math.PI * 2);
    g.fill();
  }
  // 涂改液点
  for (let i = 0; i < 6; i++) {
    const x = rnd() * W, y = rnd() * H;
    g.fillStyle = 'rgba(245,242,230,0.75)';
    g.beginPath();
    g.ellipse(x, y, 4 + rnd() * 9, 3 + rnd() * 6, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // 墨水渍
  for (let i = 0; i < 3; i++) {
    const x = rnd() * W, y = rnd() * H, r = 10 + rnd() * 22;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(20,30,80,0.35)');
    grd.addColorStop(1, 'rgba(20,30,80,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // 涂鸦：小人和五角星
  g.strokeStyle = ink(0.4);
  g.lineWidth = 1.6;
  const sx = pxPerUnit * 2.2, sy = H - pxPerUnit * 1.6;
  g.beginPath();
  for (let k = 0; k <= 5; k++) {
    const a = -Math.PI / 2 + k * ((Math.PI * 4) / 5);
    const px = sx + Math.cos(a) * 26, py = sy + Math.sin(a) * 26;
    k ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.stroke();
  g.beginPath();
  g.arc(W * 0.66, H * 0.72, 14, 0, Math.PI * 2);
  g.moveTo(W * 0.66, H * 0.72 + 14);
  g.lineTo(W * 0.66, H * 0.72 + 50);
  g.moveTo(W * 0.66 - 20, H * 0.72 + 28);
  g.lineTo(W * 0.66 + 20, H * 0.72 + 28);
  g.moveTo(W * 0.66, H * 0.72 + 50);
  g.lineTo(W * 0.66 - 15, H * 0.72 + 75);
  g.moveTo(W * 0.66, H * 0.72 + 50);
  g.lineTo(W * 0.66 + 15, H * 0.72 + 75);
  g.stroke();

  return toTex(c);
}

/** 桌沿侧面：深色封边 */
export function deskEdge() {
  const { c, g } = canvas(512, 64);
  const { fbm } = makeNoise(7);
  const img = g.createImageData(512, 64);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 512; x++) {
      const t = 0.5 + fbm(x / 60, y / 6) * 0.5;
      const i = (y * 512 + x) * 4;
      img.data[i] = 105 * t + 20;
      img.data[i + 1] = 62 * t + 12;
      img.data[i + 2] = 30 * t + 8;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return toTex(c);
}

// ---------- 水磨石地面 ----------
export function terrazzo() {
  const S = 1024;
  const { c, g } = canvas(S, S);
  const { fbm, rnd } = makeNoise(42);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const t = 0.82 + fbm(x / 140, y / 140) * 0.18;
      const i = (y * S + x) * 4;
      img.data[i] = 150 * t;
      img.data[i + 1] = 150 * t;
      img.data[i + 2] = 142 * t;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const chips = ['#f2efe6', '#2a2a28', '#5d6b5a', '#8a5a44', '#c9c2b0', '#3d4a44'];
  for (let i = 0; i < 5200; i++) {
    const x = rnd() * S, y = rnd() * S, r = 1.2 + Math.pow(rnd(), 3) * 9;
    g.fillStyle = chips[Math.floor(rnd() * chips.length)];
    g.globalAlpha = 0.6 + rnd() * 0.4;
    g.beginPath();
    const n = 5 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, rr = r * (0.6 + rnd() * 0.6);
      k ? g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.fill();
  }
  g.globalAlpha = 1;
  // 铜条分隔线（贴图边缘，平铺后形成方格）
  g.strokeStyle = 'rgba(150,110,60,0.9)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, S - 4, S - 4);
  const t = toTex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------- 橡皮 ----------
export interface RubberOpts {
  cw: number; // 面的物理宽高（单位）
  ch: number;
  base: [number, number, number];
  seed: number;
  dirtyEnd?: 'left' | 'right' | 'none';
  sleeve?: { paper: string; band: string; label?: string; from: number; to: number };
  split?: { at: number; color: [number, number, number]; sandy: boolean };
  label?: { text: string; color: string; x?: number };
  sandy?: boolean;
}

export function rubberTex(o: RubberOpts) {
  const ppu = 200;
  const { c, g } = canvas(Math.max(8, Math.round(o.cw * ppu)), Math.max(8, Math.round(o.ch * ppu)));
  const W = c.width, H = c.height;
  const { fbm, rnd } = makeNoise(o.seed);
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const n = fbm(x / 30 + o.seed, y / 30, 3);
      const k = 0.92 + n * 0.12;
      let dirt = 0;
      if (o.dirtyEnd && o.dirtyEnd !== 'none') {
        const fx = o.dirtyEnd === 'left' ? x / W : 1 - x / W;
        dirt = Math.max(0, 1 - fx / 0.38) * (0.55 + fbm(x / 12, y / 12, 3) * 0.6);
      }
      const ex = Math.min(x, W - x), ey = Math.min(y, H - y);
      const edge = Math.max(0, 1 - Math.min(ex, ey) / (ppu * 0.07)) * 0.25;
      let col = o.base;
      let sandy = o.sandy ?? false;
      if (o.split && x / W > o.split.at) {
        col = o.split.color;
        sandy = o.split.sandy;
      }
      const grit = sandy ? (rnd() - 0.5) * 0.35 : 0;
      const shade = k * (1 - dirt * 0.45 - edge) + grit;
      const i = (y * W + x) * 4;
      img.data[i] = col[0] * shade;
      img.data[i + 1] = col[1] * shade;
      img.data[i + 2] = col[2] * shade;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `rgba(40,40,40,${0.1 + rnd() * 0.22})`;
    g.beginPath();
    g.arc(rnd() * W, rnd() * H, 0.6 + rnd() * 1.5, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 5; i++) {
    g.strokeStyle = `rgba(60,60,64,${0.1 + rnd() * 0.18})`;
    g.lineWidth = 1;
    g.beginPath();
    const x = rnd() * W, y = rnd() * H;
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 50, y + (rnd() - 0.5) * 16);
    g.stroke();
  }
  if (o.sleeve) {
    const x0 = W * o.sleeve.from, x1 = W * o.sleeve.to;
    g.save();
    g.beginPath();
    g.moveTo(x0 + 6, 0);
    for (let y = 0; y <= H; y += 6) g.lineTo(x0 + (rnd() - 0.5) * 8, y);
    g.lineTo(x1, H);
    g.lineTo(x1, 0);
    g.closePath();
    g.fillStyle = o.sleeve.paper;
    g.fill();
    g.clip();
    g.fillStyle = o.sleeve.band;
    g.fillRect(x0 - 10, H * 0.08, x1 - x0 + 20, H * 0.16);
    g.fillRect(x0 - 10, H * 0.76, x1 - x0 + 20, H * 0.16);
    const grd = g.createLinearGradient(x0, 0, x1, H);
    grd.addColorStop(0, 'rgba(180,150,80,0.18)');
    grd.addColorStop(1, 'rgba(120,100,60,0.05)');
    g.fillStyle = grd;
    g.fillRect(x0 - 10, 0, x1 - x0 + 20, H);
    if (o.sleeve.label) {
      g.fillStyle = o.sleeve.band;
      g.font = `bold ${Math.min(H * 0.3, ((x1 - x0) / o.sleeve.label.length) * 1.1)}px ${KAI}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(o.sleeve.label, (x0 + x1) / 2, H * 0.5);
    }
    g.restore();
  }
  if (o.label) {
    g.fillStyle = o.label.color;
    g.font = `bold ${Math.min(H * 0.32, (W / o.label.text.length) * 0.7)}px ${KAI}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(o.label.text, W * (o.label.x ?? 0.55), H * 0.5);
  }
  return toTex(c);
}

/** 大象橡皮顶面：印一只简笔大象 */
export function elephantTop(cw: number, ch: number) {
  const t = rubberTex({ cw, ch, base: [226, 223, 212], seed: 31, dirtyEnd: 'right' });
  const c = t.image as HTMLCanvasElement;
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  g.save();
  g.translate(W * 0.36, H * 0.52);
  g.strokeStyle = 'rgba(60,80,120,0.7)';
  g.fillStyle = 'rgba(60,80,120,0.18)';
  g.lineWidth = H * 0.025;
  const u = H * 0.2;
  g.beginPath();
  g.ellipse(0, 0, u * 1.3, u * 0.9, 0, 0, Math.PI * 2); // 身体
  g.fill();
  g.stroke();
  g.beginPath();
  g.arc(u * 1.3, -u * 0.5, u * 0.6, 0, Math.PI * 2); // 头
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(u * 1.8, -u * 0.3);
  g.quadraticCurveTo(u * 2.3, u * 0.4, u * 1.9, u * 1.0); // 鼻子
  g.stroke();
  for (const lx of [-0.8, -0.3, 0.4, 0.9]) {
    g.beginPath();
    g.moveTo(u * lx, u * 0.7);
    g.lineTo(u * lx, u * 1.3);
    g.stroke();
  }
  g.restore();
  g.fillStyle = 'rgba(60,80,120,0.75)';
  g.font = `bold ${H * 0.22}px ${KAI}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('大象', W * 0.76, H * 0.5);
  t.needsUpdate = true;
  return t;
}

/** 小熊头的脸（贴在挤出体的顶面上，UV 为形状坐标） */
export function bearFace(R: number) {
  const S = 512;
  const { c, g } = canvas(S, S);
  const { fbm } = makeNoise(77);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const k = 0.9 + fbm(x / 40, y / 40, 3) * 0.15;
      const i = (y * S + x) * 4;
      img.data[i] = 168 * k;
      img.data[i + 1] = 116 * k;
      img.data[i + 2] = 72 * k;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const cx = S / 2, cy = S / 2, u = S / 2 / (R * 1.55);
  // 口鼻（画布上方 = 额头一侧，口鼻在下方）
  g.fillStyle = '#e6c9a0';
  g.beginPath();
  g.ellipse(cx, cy + u * R * 0.3, u * R * 0.42, u * R * 0.32, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#3a2416';
  g.beginPath();
  g.ellipse(cx, cy + u * R * 0.2, u * R * 0.13, u * R * 0.09, 0, 0, Math.PI * 2);
  g.fill();
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.arc(cx + sx * u * R * 0.36, cy - u * R * 0.14, u * R * 0.08, 0, Math.PI * 2);
    g.fill();
  }
  // 磨掉的一块
  g.fillStyle = 'rgba(240,225,200,0.35)';
  g.beginPath();
  g.ellipse(cx + u * R * 0.5, cy - u * R * 0.6, u * R * 0.3, u * R * 0.16, 0.6, 0, Math.PI * 2);
  g.fill();
  const t = toTex(c);
  // 形状坐标范围约 [-1.55R, 1.55R] → [0,1]
  t.repeat.set(1 / (R * 3.1), 1 / (R * 3.1));
  t.offset.set(0.5, 0.5);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** 橡皮泥：灰色、有指纹似的细纹 */
export function puttyTex() {
  const S = 256;
  const { c, g } = canvas(S, S);
  const { fbm, v2 } = makeNoise(5);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const ring = Math.sin((Math.hypot(x - 90, y - 120) + fbm(x / 20, y / 20) * 20) * 0.5) * 0.04;
      const k = 0.85 + fbm(x / 25, y / 25, 4) * 0.2 + ring + (v2(x, y) - 0.5) * 0.05;
      const i = (y * S + x) * 4;
      img.data[i] = 128 * k;
      img.data[i + 1] = 130 * k;
      img.data[i + 2] = 136 * k;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = toTex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 画在桌面上的「弹区」圈：铅笔描的虚圈 */
export function flickRing() {
  const S = 512;
  const { c, g } = canvas(S, S);
  g.strokeStyle = 'rgba(255,248,225,0.9)';
  g.lineWidth = 7;
  g.setLineDash([26, 18]);
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2);
  g.stroke();
  return toTex(c);
}
