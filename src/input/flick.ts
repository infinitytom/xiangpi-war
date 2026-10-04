// 弹指手势：手指从橡皮后方快速划过橡皮 = 弹出
// 力度取击中前一小段时间的手指速度；击中点决定偏心旋转。
import { FLICK } from '../core/config';
import type { Vec2 } from '../core/sim';

export interface FlickTarget {
  x: number;
  y: number;
  angle: number;
  w: number;
  h: number;
  round: boolean;
}

export interface FlickResult {
  dir: Vec2;
  fingerSpeed: number; // 桌面单位/秒
  point: Vec2; // 击中点（世界坐标）
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

export interface FlickHost {
  /** 按下位置附近可以弹的橡皮编号；没有返回 null */
  pick(p: Vec2): number | null;
  targetInfo(index: number): FlickTarget | null;
  toTable(clientX: number, clientY: number): Vec2 | null;
  onStart(p: Vec2, index: number): void;
  /** speed：最近一小段时间的手指速度（桌面单位/秒），用于实时力度显示 */
  onMove(p: Vec2, speed: number): void;
  onFlick(index: number, r: FlickResult): void;
  onCancel(reason: 'outside' | 'weak' | 'lifted' | 'none'): void;
  /** 按下但不在任何橡皮附近（用于刹车等「点一下」操作） */
  onTap?(p: Vec2): void;
}

export const zoneRadius = (t: { w: number; h: number }) => Math.hypot(t.w, t.h) / 2 + FLICK.zoneExtra;

export class FlickInput {
  private pointerId: number | null = null;
  private samples: Sample[] = [];
  private startedInside = false;
  private index = -1;

  constructor(private el: HTMLElement, private host: FlickHost) {
    el.addEventListener('pointerdown', this.down, { passive: false });
    el.addEventListener('pointermove', this.move, { passive: false });
    el.addEventListener('pointerup', this.up, { passive: false });
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('lostpointercapture', this.cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private toLocal(t: FlickTarget, p: Vec2): Vec2 {
    const dx = p.x - t.x, dy = p.y - t.y;
    const c = Math.cos(-t.angle), s = Math.sin(-t.angle);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }
  private toWorld(t: FlickTarget, p: Vec2): Vec2 {
    const c = Math.cos(t.angle), s = Math.sin(t.angle);
    return { x: t.x + p.x * c - p.y * s, y: t.y + p.x * s + p.y * c };
  }
  private inside(t: FlickTarget, l: Vec2) {
    return t.round ? Math.hypot(l.x, l.y) <= t.w / 2 : Math.abs(l.x) <= t.w / 2 && Math.abs(l.y) <= t.h / 2;
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    if (this.pointerId !== null) return; // 只认一根手指
    const p = this.host.toTable(e.clientX, e.clientY);
    if (!p) return;
    const idx = this.host.pick(p);
    const t = idx === null ? null : this.host.targetInfo(idx);
    if (idx === null || !t || Math.hypot(p.x - t.x, p.y - t.y) > zoneRadius(t)) {
      if (this.host.onTap) this.host.onTap(p);
      else this.host.onCancel(idx === null ? 'none' : 'outside');
      return;
    }
    this.index = idx;
    this.pointerId = e.pointerId;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    this.startedInside = this.inside(t, this.toLocal(t, p));
    this.samples = [{ t: performance.now(), x: p.x, y: p.y }];
    this.host.onStart(p, idx);
  };

  /** 处理一个新的触点位置；击中则弹出并返回 true */
  private feed(clientX: number, clientY: number, timeStamp: number): boolean {
    const t = this.host.targetInfo(this.index);
    if (!t) {
      this.reset();
      return true;
    }
    const p = this.host.toTable(clientX, clientY);
    if (!p) return false;
    const prev = this.samples[this.samples.length - 1];
    if (p.x === prev.x && p.y === prev.y) return false;
    this.samples.push({ t: Math.max(timeStamp, prev.t + 0.5), x: p.x, y: p.y });
    if (this.samples.length > 48) this.samples.shift();
    this.host.onMove(p, this.recentSpeed());
    const hit = this.checkHit(t, prev, p);
    if (hit) {
      this.fire(t, hit.local, hit.frac);
      return true;
    }
    return false;
  }

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    // 时间戳统一用 performance.now()：部分平板浏览器的事件时间戳基准不可靠。
    // 合并事件（coalesced）若带可信时间戳就用它，否则在上一个样本和现在之间均匀插值。
    const now = performance.now();
    const prevT = this.samples[this.samples.length - 1]?.t ?? now;
    const trusted = list.every((ev, i) => Math.abs(ev.timeStamp - now) < 500 && (i === 0 || ev.timeStamp >= list[i - 1].timeStamp));
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      const t = trusted ? ev.timeStamp : prevT + ((now - prevT) * (i + 1)) / list.length;
      if (this.feed(ev.clientX, ev.clientY, t)) return;
    }
  };

  /**
   * 线段 a→b 是否碰到橡皮（外扩手指半径）。
   * 返回击中点（局部坐标）以及击中位置在线段上的比例（用于插值击中时刻）。
   */
  private checkHit(t: FlickTarget, a: Vec2, b: Vec2): { local: Vec2; frac: number } | null {
    const la = this.toLocal(t, a), lb = this.toLocal(t, b);
    const r = FLICK.fingerRadius;
    if (this.startedInside) {
      // 在橡皮上起手：手指离开橡皮轮廓时算作「推」出，击中点为起手点
      if (this.inside(t, la) && !this.inside(t, lb)) {
        const s = this.samples[0];
        return { local: this.toLocal(t, s), frac: 1 };
      }
      return null;
    }
    const dx = lb.x - la.x, dy = lb.y - la.y;
    if (t.round) {
      // 线段与圆（半径 + 手指）求交
      const R = t.w / 2 + r;
      const A = dx * dx + dy * dy, B = 2 * (la.x * dx + la.y * dy), C = la.x * la.x + la.y * la.y - R * R;
      if (C <= 0) return { local: this.clampRound(t, la), frac: 0 };
      const disc = B * B - 4 * A * C;
      if (A < 1e-12 || disc < 0) return null;
      const t0 = (-B - Math.sqrt(disc)) / (2 * A);
      if (t0 < 0 || t0 > 1) return null;
      return { local: this.clampRound(t, { x: la.x + dx * t0, y: la.y + dy * t0 }), frac: t0 };
    }
    // 线段与外扩矩形的 slab 求交
    const hx = t.w / 2, hy = t.h / 2, ex = hx + r, ey = hy + r;
    let t0 = 0, t1 = 1;
    for (const [p0, d, lo, hi] of [
      [la.x, dx, -ex, ex],
      [la.y, dy, -ey, ey],
    ] as const) {
      if (Math.abs(d) < 1e-9) {
        if (p0 < lo || p0 > hi) return null;
      } else {
        let ta = (lo - p0) / d, tb = (hi - p0) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) return null;
      }
    }
    const px = la.x + dx * t0, py = la.y + dy * t0;
    return { local: { x: Math.max(-hx, Math.min(hx, px)), y: Math.max(-hy, Math.min(hy, py)) }, frac: t0 };
  }

  private clampRound(t: FlickTarget, l: Vec2): Vec2 {
    const d = Math.hypot(l.x, l.y) || 1;
    const R = t.w / 2;
    return { x: (l.x / d) * R, y: (l.y / d) * R };
  }

  private recentSpeed() {
    const s = this.samples;
    const last = s[s.length - 1];
    let first = s[0];
    for (let i = s.length - 1; i >= 0; i--) {
      first = s[i];
      if (last.t - s[i].t >= FLICK.sampleWindowMs) break;
    }
    const dt = (last.t - first.t) / 1000;
    return dt > 0.004 ? Math.hypot(last.x - first.x, last.y - first.y) / dt : 0;
  }

  private fire(t: FlickTarget, localHit: Vec2, _frac: number) {
    const s = this.samples;
    const last = s[s.length - 1];
    // 取击中前 sampleWindowMs 内的平均速度；样本太少时用整个手势
    let first = s[0];
    for (let i = s.length - 1; i >= 0; i--) {
      first = s[i];
      if (last.t - s[i].t >= FLICK.sampleWindowMs) break;
    }
    const dtS = Math.max(0.006, (last.t - first.t) / 1000);
    const vx = (last.x - first.x) / dtS, vy = (last.y - first.y) / dtS;
    const sp = Math.hypot(vx, vy);
    const idx = this.index;
    this.reset();
    if (sp < FLICK.minFingerSpeed) {
      this.host.onCancel('weak');
      return;
    }
    this.host.onFlick(idx, { dir: { x: vx / sp, y: vy / sp }, fingerSpeed: sp, point: this.toWorld(t, localHit) });
  }

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    // 抬手位置也算一段：快速划过时最后一段常常只出现在 pointerup 里
    if (this.feed(e.clientX, e.clientY, performance.now())) return;
    this.reset();
    this.host.onCancel('lifted');
  };
  private cancel = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.reset();
  };
  private reset() {
    const id = this.pointerId;
    this.pointerId = null;
    this.samples = [];
    if (id !== null) {
      try {
        this.el.releasePointerCapture(id);
      } catch {}
    }
  }
}

/** 手指速度 → 橡皮初速（带灵敏度与轻微非线性） */
export function fingerToLaunch(fingerSpeed: number, sensitivity: number) {
  return FLICK.speedGain * sensitivity * Math.pow(fingerSpeed, FLICK.speedExp);
}
