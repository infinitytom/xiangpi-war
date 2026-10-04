// 甩出手势：手指按住自己的橡皮，朝想去的方向一甩，出手瞬间的手指速度就是力度。
// 按住的位置决定施力点：按着角甩，橡皮会带着旋转飞出去。
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
  point: Vec2; // 施力点（世界坐标）
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

export interface FlickHost {
  /** 按下位置可以抓的橡皮编号；没有返回 null */
  pick(p: Vec2): number | null;
  targetInfo(index: number): FlickTarget | null;
  toTable(clientX: number, clientY: number): Vec2 | null;
  onStart(p: Vec2, index: number): void;
  /** speed：最近一小段时间的手指速度（桌面单位/秒），用于实时力度显示 */
  onMove(p: Vec2, speed: number): void;
  onFlick(index: number, r: FlickResult): void;
  onCancel(reason: 'outside' | 'weak' | 'lifted' | 'none'): void;
  /** 按下但没按住可甩的橡皮（用于刹车等「点一下」操作） */
  onTap?(p: Vec2): void;
}

/** 抓取范围：橡皮轮廓外扩 grabMargin 也算按住（手指比鼠标粗） */
export const grabRadius = (t: { w: number; h: number }) => Math.hypot(t.w, t.h) / 2 + FLICK.grabMargin;

export class FlickInput {
  private pointerId: number | null = null;
  private samples: Sample[] = [];
  private index = -1;
  private target: FlickTarget | null = null;
  private grabLocal: Vec2 = { x: 0, y: 0 };

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
  /** 按下点是否抓住橡皮（轮廓外扩 grabMargin）；返回夹回真实轮廓内的局部坐标 */
  private grab(t: FlickTarget, p: Vec2): Vec2 | null {
    const l = this.toLocal(t, p);
    const g = FLICK.grabMargin;
    if (t.round) {
      const R = t.w / 2;
      const d = Math.hypot(l.x, l.y);
      if (d > R + g) return null;
      return d > R ? { x: (l.x / d) * R, y: (l.y / d) * R } : l;
    }
    const hx = t.w / 2, hy = t.h / 2;
    if (Math.abs(l.x) > hx + g || Math.abs(l.y) > hy + g) return null;
    return { x: Math.max(-hx, Math.min(hx, l.x)), y: Math.max(-hy, Math.min(hy, l.y)) };
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    if (this.pointerId !== null) return; // 只认一根手指
    const p = this.host.toTable(e.clientX, e.clientY);
    if (!p) return;
    const idx = this.host.pick(p);
    const t = idx === null ? null : this.host.targetInfo(idx);
    const local = t ? this.grab(t, p) : null;
    if (idx === null || !t || !local) {
      if (this.host.onTap) this.host.onTap(p);
      else this.host.onCancel(idx === null ? 'none' : 'outside');
      return;
    }
    this.index = idx;
    this.target = t;
    this.grabLocal = local;
    this.pointerId = e.pointerId;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    this.samples = [{ t: performance.now(), x: p.x, y: p.y }];
    this.host.onStart(p, idx);
  };

  /** 记录一个触点；甩得够远就直接出手，返回 true */
  private feed(clientX: number, clientY: number, t: number): boolean {
    const p = this.host.toTable(clientX, clientY);
    if (!p) return false;
    const prev = this.samples[this.samples.length - 1];
    if (prev && p.x === prev.x && p.y === prev.y) return false;
    this.samples.push({ t: Math.max(t, (prev?.t ?? 0) + 0.5), x: p.x, y: p.y });
    if (this.samples.length > 64) this.samples.shift();
    this.host.onMove(p, this.peak(performance.now() - 90).speed);
    // 手指已经甩出足够远：不必等抬手，立即出手（大幅甩动时手指可能滑出屏幕）
    const s0 = this.samples[0];
    if (Math.hypot(p.x - s0.x, p.y - s0.y) >= FLICK.maxDrag) {
      this.release(this.samples[this.samples.length - 1].t);
      return true;
    }
    return false;
  }

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    if (!this.host.targetInfo(this.index)) {
      this.reset();
      return;
    }
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    // 时间统一用 performance.now() 基准：合并事件有可信时间戳就用，否则在上个样本与现在之间均匀插值
    const now = performance.now();
    const prevT = this.samples[this.samples.length - 1]?.t ?? now;
    const trusted = list.every((ev, i) => Math.abs(ev.timeStamp - now) < 500 && (i === 0 || ev.timeStamp >= list[i - 1].timeStamp));
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      if (this.feed(ev.clientX, ev.clientY, trusted ? ev.timeStamp : prevT + ((now - prevT) * (i + 1)) / list.length)) return;
    }
  };

  /** since 之后任意一段 12–45 ms 区间内的最高手指速度，以及那段的方向 */
  private peak(since: number): { speed: number; dir: Vec2 } {
    const s = this.samples;
    let best = 0, bx = 0, by = 0;
    for (let j = s.length - 1; j > 0; j--) {
      if (s[j].t < since) break;
      for (let i = j - 1; i >= 0; i--) {
        const dt = s[j].t - s[i].t;
        if (dt < 12) continue;
        if (dt > 45) break;
        const dx = s[j].x - s[i].x, dy = s[j].y - s[i].y;
        const v = Math.hypot(dx, dy) / (dt / 1000);
        if (v > best) {
          best = v;
          bx = dx;
          by = dy;
        }
        break; // 每个终点只取最近的一段合格区间
      }
    }
    if (best === 0 && s.length >= 2) {
      // 样本太稀：用最后两个点
      const a = s[s.length - 2], b = s[s.length - 1];
      if (b.t >= since) {
        const dt = Math.max(8, b.t - a.t);
        bx = b.x - a.x;
        by = b.y - a.y;
        best = Math.hypot(bx, by) / (dt / 1000);
      }
    }
    const l = Math.hypot(bx, by) || 1;
    return { speed: best, dir: { x: bx / l, y: by / l } };
  }

  /** 出手：取出手前一小段时间的峰值速度；手指停住再松开就不算甩 */
  private release(at: number) {
    const t = this.target;
    const idx = this.index;
    const s = this.samples;
    if (!t || s.length < 1) {
      this.reset();
      return;
    }
    const pk = this.peak(at - FLICK.releaseWindowMs);
    // 方向：出手前一段的整体位移方向（比单段峰值稳）
    const last = s[s.length - 1];
    let first = last;
    for (const smp of s) if (smp.t >= at - FLICK.releaseWindowMs) { first = smp; break; }
    let dx = last.x - first.x, dy = last.y - first.y;
    if (Math.hypot(dx, dy) < 0.05) {
      dx = pk.dir.x;
      dy = pk.dir.y;
    }
    const l = Math.hypot(dx, dy) || 1;
    const moved = Math.hypot(last.x - s[0].x, last.y - s[0].y);
    this.reset();
    if (pk.speed < FLICK.minFingerSpeed || moved < 0.08) {
      this.host.onCancel(moved < 0.15 ? 'lifted' : 'weak');
      return;
    }
    this.host.onFlick(idx, { dir: { x: dx / l, y: dy / l }, fingerSpeed: pk.speed, point: this.toWorld(t, this.grabLocal) });
  }

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const now = performance.now();
    // 抬手位置也算一段：快速甩时最后一段常常只出现在 pointerup 里
    if (this.feed(e.clientX, e.clientY, now)) return;
    this.release(now);
  };

  private cancel = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.reset();
    this.host.onCancel('lifted');
  };

  private reset() {
    const id = this.pointerId;
    this.pointerId = null;
    this.samples = [];
    this.target = null;
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
