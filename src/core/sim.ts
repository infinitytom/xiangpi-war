// 纯逻辑物理核心：不依赖 DOM，可在浏览器、Worker、Node 中运行
import RAPIER from '@dimforge/rapier2d-deterministic-compat';
import { PHYS, SKILL_NUM, TABLE, type EraserDef, type SkillId } from './config';

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface FallInfo {
  index: number;
  pos: Vec2;
  vel: Vec2;
  angle: number;
  spin: number;
  frame: number;
}

/** 技能留在橡皮身上的效果 */
export interface Effects {
  braced?: boolean; // 定身：变重（持续到下次轮到自己）
  rooted?: boolean; // 扎根：抓地 ×4
  charged?: boolean; // 蓄势：下次力度 +60%
  bracePending?: boolean;
  rootPending?: boolean;
  springArmed?: boolean;
  curving?: boolean;
  sweepPending?: boolean;
  stickArmed?: boolean;
  brakeArmed?: boolean;
}

export interface EraserState {
  def: EraserDef;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  alive: boolean;
  fall: FallInfo | null;
  fx: Effects;
}

export interface Snapshot {
  x: number;
  y: number;
  angle: number;
  alive: boolean;
}

/** 可序列化的完整状态：联机校正、AI 前向模拟都用它 */
export interface SimState {
  e: { x: number; y: number; a: number; vx: number; vy: number; w: number; alive: boolean; fx: Effects }[];
}

export interface Impact {
  a: number;
  b: number;
  speed: number;
  x: number;
  y: number;
}

export class Sim {
  world: RAPIER.World;
  erasers: EraserState[] = [];
  frame = 0;
  resolving = false;
  impacts: Impact[] = [];
  private resolveFrames = 0;
  private events: RAPIER.EventQueue;
  private colliderOwner = new Map<number, number>();
  private stick: { a: number; b: number; until: number } | null = null;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: 0 });
    this.world.timestep = PHYS.dt;
    this.events = new RAPIER.EventQueue(true);
  }

  addEraser(def: EraserDef, x: number, y: number, angle: number): number {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setRotation(angle).setCcdEnabled(true).setCanSleep(false)
    );
    const area = def.shape === 'ball' ? Math.PI * (def.w / 2) ** 2 : def.w * def.h;
    const desc = (def.shape === 'ball' ? RAPIER.ColliderDesc.ball(def.w / 2) : RAPIER.ColliderDesc.cuboid(def.w / 2, def.h / 2))
      .setDensity(def.mass / area)
      .setRestitution(def.restitution)
      .setFriction(0.45)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc, body);
    this.colliderOwner.set(collider.handle, this.erasers.length);
    this.erasers.push({ def, body, collider, alive: true, fall: null, fx: {} });
    return this.erasers.length - 1;
  }

  private iOverM(def: EraserDef) {
    return def.shape === 'ball' ? (def.w / 2) ** 2 / 2 : (def.w * def.w + def.h * def.h) / 12;
  }
  private rAvg(def: EraserDef) {
    return def.shape === 'ball' ? (def.w / 2) * (2 / 3) : 0.383 * Math.sqrt(def.w * def.h);
  }
  private massOf(e: EraserState) {
    return e.def.mass * (e.fx.braced ? 1.5 : 1);
  }

  /**
   * 手指弹出。speed 为橡皮正碰时的目标初速；point 为击中点（世界坐标）。
   * 偏心击打时接触点的等效质量更小 → 平移更少、旋转更多。
   */
  flick(index: number, dir: Vec2, speed: number, point: Vec2, skill?: SkillId, powerMul = 1) {
    const e = this.erasers[index];
    if (!e.body || !e.alive) return;
    const def = e.def;
    const m = this.massOf(e);
    const c = e.body.translation();
    const rx = point.x - c.x, ry = point.y - c.y;
    const rCrossN = rx * dir.y - ry * dir.x;
    const iom = this.iOverM(def);
    const mEff = 1 / (1 / m + (rCrossN * rCrossN) / (m * iom));
    const maxJ = def.maxImpulse * (e.fx.charged ? SKILL_NUM.chargeBoost : 1) * powerMul;
    e.fx.charged = false;
    const J = Math.min(mEff * Math.min(speed, PHYS.globalMaxSpeed * (maxJ / def.maxImpulse)), maxJ);
    e.body.applyImpulseAtPoint({ x: dir.x * J, y: dir.y * J }, point, true);

    switch (skill) {
      case 'brace':
        e.fx.bracePending = true;
        break;
      case 'root':
        e.fx.rootPending = true;
        break;
      case 'spring':
        e.fx.springArmed = true;
        e.collider!.setRestitution(1.3);
        e.collider!.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
        break;
      case 'curve': {
        e.fx.curving = true;
        const w = e.body.angvel();
        const sign = Math.abs(w) > 0.3 ? Math.sign(w) : Math.sign(rCrossN) || 1;
        e.body.setAngvel(sign * Math.max(Math.abs(w) * 1.8, 9), true);
        break;
      }
      case 'sweep':
        e.fx.sweepPending = true;
        break;
      case 'stick':
        e.fx.stickArmed = true;
        break;
      case 'brake':
        e.fx.brakeArmed = true;
        break;
    }
    this.resolving = true;
    this.resolveFrames = 0;
  }

  /** 蓄势：不弹，直接挂上效果 */
  charge(index: number) {
    this.erasers[index].fx.charged = true;
  }

  /** 刹车：立即停住（只有挂了刹车的橡皮有效） */
  brake(index: number): boolean {
    const e = this.erasers[index];
    if (!e.body || !e.fx.brakeArmed) return false;
    e.fx.brakeArmed = false;
    e.body.setLinvel({ x: 0, y: 0 }, true);
    e.body.setAngvel(0, true);
    return true;
  }

  /** 某人的回合开始：清掉他上回合留下的持续效果 */
  startTurnOf(index: number) {
    const e = this.erasers[index];
    if (!e) return;
    if (e.fx.braced && e.body) e.body.setAdditionalMass(0, true);
    e.fx.braced = false;
    e.fx.rooted = false;
  }

  step(): FallInfo[] {
    const falls: FallInfo[] = [];
    const dt = PHYS.dt;
    for (const e of this.erasers) {
      if (!e.body) continue;
      const def = e.def;
      const mu = def.mu * (e.fx.rooted ? SKILL_NUM.rootGrip : 1);
      const v = e.body.linvel();
      const sp = Math.hypot(v.x, v.y);
      let vx = v.x, vy = v.y;
      // 旋射：带旋转滑行时受侧向力，走弧线
      if (e.fx.curving && sp > 0.3) {
        const w = e.body.angvel();
        const lat = Math.sign(w) * Math.min(6, Math.abs(w) * 0.42) * dt;
        vx += (-v.y / sp) * lat;
        vy += (v.x / sp) * lat;
      }
      const sp2 = Math.hypot(vx, vy);
      // 低速时摩擦更大：停得干脆，不会「溜冰」
      const dec = mu * PHYS.g * dt * (1 + 0.6 * Math.max(0, 1 - sp2 / 2.5));
      if (sp2 <= dec) e.body.setLinvel({ x: 0, y: 0 }, true);
      else e.body.setLinvel({ x: vx - (vx / sp2) * dec, y: vy - (vy / sp2) * dec }, true);
      const w = e.body.angvel();
      const adec = ((mu * PHYS.g * this.rAvg(def)) / this.iOverM(def)) * dt * (e.fx.curving ? 0.45 : 1);
      if (Math.abs(w) <= adec) e.body.setAngvel(0, true);
      else e.body.setAngvel(w - Math.sign(w) * adec, true);
    }

    // 黏附中：被黏住的一方跟着走
    if (this.stick) {
      const A = this.erasers[this.stick.a].body, B = this.erasers[this.stick.b].body;
      if (!A || !B || this.frame >= this.stick.until) this.stick = null;
      else B.setLinvel(A.linvel(), true);
    }

    this.impacts = [];
    const pre = this.erasers.map((e) => (e.body ? e.body.linvel() : { x: 0, y: 0 }));
    this.world.step(this.events);
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.colliderOwner.get(h1), b = this.colliderOwner.get(h2);
      if (a === undefined || b === undefined) return;
      const ea = this.erasers[a], eb = this.erasers[b];
      if (!ea.body || !eb.body) return;
      const rel = Math.hypot(pre[a].x - pre[b].x, pre[a].y - pre[b].y);
      const pa = ea.body.translation(), pb = eb.body.translation();
      this.impacts.push({ a, b, speed: rel, x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
      for (const [me, other] of [[a, b], [b, a]] as const) this.onImpact(me, other, pre);
    });
    this.frame++;
    if (this.resolving) this.resolveFrames++;

    for (let i = 0; i < this.erasers.length; i++) {
      const e = this.erasers[i];
      if (!e.body) continue;
      const p = e.body.translation();
      if (Math.abs(p.x) > TABLE.width / 2 || Math.abs(p.y) > TABLE.height / 2) {
        const v = e.body.linvel();
        const info: FallInfo = { index: i, pos: { x: p.x, y: p.y }, vel: { x: v.x, y: v.y }, angle: e.body.rotation(), spin: e.body.angvel(), frame: this.frame };
        this.colliderOwner.delete(e.collider!.handle);
        this.world.removeRigidBody(e.body);
        e.body = null;
        e.collider = null;
        e.alive = false;
        e.fall = info;
        e.fx = {};
        falls.push(info);
      }
    }

    if (this.resolving && (this.allResting() || this.resolveFrames * dt > PHYS.maxResolveTime)) this.finishResolve();
    return falls;
  }

  private onImpact(me: number, other: number, pre: Vec2[]) {
    const e = this.erasers[me];
    const o = this.erasers[other];
    if (!e.body || !o.body) return;
    if (e.fx.springArmed) {
      e.fx.springArmed = false;
      e.collider!.setRestitution(e.def.restitution);
      e.collider!.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Average);
    }
    if (e.fx.stickArmed) {
      e.fx.stickArmed = false;
      const ma = this.massOf(e), mb = this.massOf(o);
      const va = pre[me], vb = pre[other];
      const cx = (ma * va.x + mb * vb.x) / (ma + mb), cy = (ma * va.y + mb * vb.y) / (ma + mb);
      const sp = Math.hypot(va.x, va.y) || 1;
      const push = (0.3 * ma * sp) / mb;
      o.body.setLinvel({ x: cx + (va.x / sp) * push, y: cy + (va.y / sp) * push }, true);
      e.body.setLinvel({ x: cx + (va.x / sp) * push, y: cy + (va.y / sp) * push }, true);
      this.stick = { a: me, b: other, until: this.frame + 48 };
    }
  }

  private finishResolve() {
    // 横扫：停下后原地转一圈
    let swept = false;
    for (const e of this.erasers) {
      if (e.fx.sweepPending && e.body) {
        e.fx.sweepPending = false;
        e.body.setAngvel(15, true);
        swept = true;
      }
    }
    if (swept) {
      this.resolveFrames = Math.floor((PHYS.maxResolveTime - 2) / PHYS.dt);
      return;
    }
    for (const e of this.erasers) {
      if (e.fx.springArmed && e.collider) {
        e.collider.setRestitution(e.def.restitution);
        e.collider.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Average);
      }
      e.fx.springArmed = false;
      e.fx.curving = false;
      e.fx.stickArmed = false;
      e.fx.brakeArmed = false;
      if (e.fx.bracePending && e.body) {
        e.fx.braced = true;
        e.body.setAdditionalMass(e.def.mass * 0.5, true);
      }
      if (e.fx.rootPending) e.fx.rooted = true;
      e.fx.bracePending = false;
      e.fx.rootPending = false;
    }
    this.stick = null;
    this.resolving = false;
  }

  allResting(): boolean {
    for (const e of this.erasers) {
      if (!e.body) continue;
      const v = e.body.linvel();
      if (Math.hypot(v.x, v.y) > PHYS.restSpeed || Math.abs(e.body.angvel()) > PHYS.restSpin) return false;
    }
    return true;
  }

  snapshot(i: number): Snapshot {
    const e = this.erasers[i];
    if (!e.body) return { x: e.fall?.pos.x ?? 0, y: e.fall?.pos.y ?? 0, angle: e.fall?.angle ?? 0, alive: false };
    const p = e.body.translation();
    return { x: p.x, y: p.y, angle: e.body.rotation(), alive: true };
  }

  speedOf(i: number): number {
    const b = this.erasers[i].body;
    if (!b) return 0;
    const v = b.linvel();
    return Math.hypot(v.x, v.y);
  }

  getState(): SimState {
    return {
      e: this.erasers.map((e) => {
        if (!e.body) return { x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0, alive: false, fx: {} };
        const p = e.body.translation(), v = e.body.linvel();
        return { x: p.x, y: p.y, a: e.body.rotation(), vx: v.x, vy: v.y, w: e.body.angvel(), alive: true, fx: { ...e.fx } };
      }),
    };
  }

  /** 把状态套到现有橡皮上（联机校正）。返回新掉下去的橡皮编号 */
  applyState(s: SimState): number[] {
    const killed: number[] = [];
    s.e.forEach((st, i) => {
      const e = this.erasers[i];
      if (!e) return;
      if (!st.alive) {
        if (e.body) {
          this.colliderOwner.delete(e.collider!.handle);
          this.world.removeRigidBody(e.body);
          e.body = null;
          e.collider = null;
          e.alive = false;
          killed.push(i);
        }
        return;
      }
      if (!e.body) return; // 本地已掉落、房主说还在：以房主为准时由上层重建
      e.body.setTranslation({ x: st.x, y: st.y }, true);
      e.body.setRotation(st.a, true);
      e.body.setLinvel({ x: st.vx, y: st.vy }, true);
      e.body.setAngvel(st.w, true);
      const wasBraced = e.fx.braced;
      e.fx = { ...st.fx };
      if (e.fx.braced !== wasBraced) e.body.setAdditionalMass(e.fx.braced ? e.def.mass * 0.5 : 0, true);
    });
    return killed;
  }

  /** 用定义 + 状态造一个独立的模拟（AI 前向模拟用） */
  static fromState(defs: EraserDef[], s: SimState): Sim {
    const sim = new Sim();
    defs.forEach((d, i) => {
      const st = s.e[i];
      sim.addEraser(d, st.x, st.y, st.a);
      if (!st.alive) {
        const e = sim.erasers[i];
        sim.colliderOwner.delete(e.collider!.handle);
        sim.world.removeRigidBody(e.body!);
        e.body = null;
        e.collider = null;
        e.alive = false;
      } else {
        sim.erasers[i].fx = { ...st.fx };
        if (st.fx.braced) sim.erasers[i].body!.setAdditionalMass(d.mass * 0.5, true);
      }
    });
    return sim;
  }

  dispose() {
    this.events.free();
    this.world.free();
  }
}
