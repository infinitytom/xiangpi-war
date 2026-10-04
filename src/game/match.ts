// 对局规则：轮流弹、能量与技能、落桌判定、计分。纯逻辑，本地 / AI / 联机共用。
import { charById, eraserDef, PHYS, RULES, SKILL_NUM, SEAT_COLORS, SKILLS, type EraserDef, type SkillId } from '../core/config';
import { Sim, type FallInfo, type Impact, type SimState, type Vec2 } from '../core/sim';

export type SeatKind = 'human' | 'ai' | 'remote';
export type AiLevel = 'easy' | 'normal' | 'hard';

export interface SeatConfig {
  name: string;
  charId: string;
  kind: SeatKind;
  aiLevel?: AiLevel;
  peerId?: string; // 联机：控制这个座位的玩家
}

export interface Seat extends SeatConfig {
  color: string;
  energy: number;
  wins: number; // 两人局：赢的局数
  points: number; // 多人局：累计积分
  kos: number; // 本局撞下的人数
}

export interface FlickInputData {
  dir: Vec2;
  speed: number;
  point: Vec2;
}

export type Phase = 'aim' | 'resolve' | 'waitSync' | 'roundOver' | 'matchOver';

export interface RoundResult {
  draw: boolean;
  /** 本局名次：seat 下标，第一名在前；同名次放在同一个子数组 */
  ranking: number[][];
  winner: number | null;
  how: string;
  matchWinner: number[] | null; // 整场结束时的赢家（可能并列）
}

export type MatchEvent =
  | { type: 'falls'; falls: FallInfo[] }
  | { type: 'impacts'; impacts: Impact[] }
  | { type: 'turn'; seat: number }
  | { type: 'flick'; seat: number; speed: number; skill: SkillId | null }
  | { type: 'skill'; seat: number; skill: SkillId }
  | { type: 'resolved'; state: SimState } // 房主：一次结算结束，广播校正
  | { type: 'timeout'; seat: number }
  | { type: 'round'; result: RoundResult }
  | { type: 'rebuild' } // 物理被整体重建，渲染层需重新创建橡皮
  | { type: 'hud' };

export type Authority = 'local' | 'host' | 'client';

export class Match {
  seats: Seat[];
  defs: EraserDef[];
  sim!: Sim;
  phase: Phase = 'aim';
  turn = 0;
  round = 1;
  turnLeft = RULES.turnSeconds;
  /** 每开始一次「轮到某人」就 +1，联机时用来对齐动作 */
  turnNo = 0;
  timer: boolean;
  armed = false; // 当前玩家是否点亮了技能
  authority: Authority;
  lastResult: RoundResult | null = null;
  private starter = 0;
  private settle = 0;
  private fallOrder: { seat: number; frame: number }[] = [];
  private listeners: ((e: MatchEvent) => void)[] = [];
  /** 本次结算是谁弹的（撞下别人算他的） */
  private actor = -1;
  /** 这一局还没人弹过（第一弹限力） */
  opening = true;
  /** 连续多少次出手没人落桌（用于力度递增，打破僵局） */
  quiet = 0;
  get actorSeat() {
    return this.actor;
  }

  constructor(cfg: SeatConfig[], opts: { timer: boolean; authority?: Authority }) {
    this.seats = cfg.map((c, i) => ({ ...c, color: SEAT_COLORS[i], energy: 0, wins: 0, points: 0, kos: 0 }));
    this.defs = cfg.map((c) => eraserDef(charById(c.charId)));
    this.timer = opts.timer;
    this.authority = opts.authority ?? 'local';
  }

  on(fn: (e: MatchEvent) => void) {
    this.listeners.push(fn);
  }
  private emit(e: MatchEvent) {
    for (const l of this.listeners) l(e);
  }

  get n() {
    return this.seats.length;
  }
  get isTwoPlayer() {
    return this.n === 2;
  }

  static spawn(n: number, i: number) {
    if (n === 2) return i === 0 ? { x: -3, y: 0, a: 0 } : { x: 3, y: 0, a: Math.PI };
    const ang = Math.PI + (i * 2 * Math.PI) / n;
    const x = Math.cos(ang) * 3.7, y = Math.sin(ang) * 2.4;
    return { x, y, a: Math.atan2(-y, -x) };
  }

  startRound() {
    this.sim?.dispose();
    this.sim = new Sim();
    this.defs.forEach((d, i) => {
      const s = Match.spawn(this.n, i);
      this.sim.addEraser(d, s.x, s.y, s.a);
    });
    this.seats.forEach((s, i) => {
      s.energy = RULES.energyStart - RULES.energyPerTurn + (i === this.starter ? 0 : RULES.secondPlayerBonus);
      s.kos = 0;
    });
    this.fallOrder = [];
    this.opening = true;
    this.quiet = 0;
    this.emit({ type: 'rebuild' });
    this.beginTurn(this.starter);
  }

  private beginTurn(seat: number) {
    this.turnNo++;
    this.turn = seat;
    this.phase = 'aim';
    this.armed = false;
    this.turnLeft = RULES.turnSeconds;
    const s = this.seats[seat];
    s.energy = Math.min(RULES.energyMax, s.energy + RULES.energyPerTurn);
    this.sim.startTurnOf(seat);
    this.emit({ type: 'turn', seat });
    this.emit({ type: 'hud' });
  }

  private nextAlive(from: number) {
    for (let k = 1; k <= this.n; k++) {
      const j = (from + k) % this.n;
      if (this.sim.erasers[j].alive) return j;
    }
    return from;
  }

  /** 力度递增：连续多轮没人落桌时逐步提高力度上限（数值见 RULES） */
  get powerMul() {
    const alive = this.sim ? this.sim.erasers.filter((e) => e.alive).length : this.n;
    const rounds = Math.floor(this.quiet / Math.max(1, alive));
    return Math.min(RULES.escalationMax, 1 + RULES.escalationStep * Math.max(0, rounds - RULES.escalationAfter));
  }

  /** 这次能弹出的最大速度（考虑蓄势、第一弹限力、力度递增） */
  maxSpeedOf(seat: number) {
    const d = this.defs[seat];
    const e = this.sim.erasers[seat];
    const mul = this.powerMul;
    const v = Math.min(PHYS.globalMaxSpeed * mul, (d.maxImpulse * mul * (e?.fx.charged ? SKILL_NUM.chargeBoost : 1)) / (d.mass * (e?.fx.braced ? 1.5 : 1)));
    return this.opening ? v * RULES.openingPower : v;
  }

  skillOf(seat: number) {
    return SKILLS[charById(this.seats[seat].charId).skill];
  }

  canAfford(seat: number) {
    return this.seats[seat].energy >= this.skillOf(seat).cost;
  }

  /** 当前玩家切换技能。即时技能（蓄势）直接生效并结束这次 */
  toggleSkill(seat: number): boolean {
    if (this.phase !== 'aim' || seat !== this.turn) return false;
    const sk = this.skillOf(seat);
    if (sk.kind === 'instant') {
      if (!this.canAfford(seat)) return false;
      this.seats[seat].energy -= sk.cost;
      this.sim.charge(seat);
      this.opening = false;
      this.quiet++;
      this.emit({ type: 'skill', seat, skill: sk.id });
      this.actor = seat;
      this.phase = 'resolve';
      this.settle = 0;
      this.emit({ type: 'hud' });
      return true;
    }
    if (!this.armed && !this.canAfford(seat)) return false;
    this.armed = !this.armed;
    this.emit({ type: 'hud' });
    return true;
  }

  flick(seat: number, f: FlickInputData, skillArmed = this.armed) {
    if (this.phase !== 'aim' || seat !== this.turn) return;
    const sk = this.skillOf(seat);
    let skill: SkillId | null = null;
    if (skillArmed && sk.kind === 'arm' && this.seats[seat].energy >= sk.cost) {
      this.seats[seat].energy -= sk.cost;
      skill = sk.id;
    }
    this.armed = false;
    const speed = Math.min(f.speed, this.maxSpeedOf(seat));
    const mul = this.powerMul;
    this.opening = false;
    this.sim.flick(seat, f.dir, speed, f.point, skill ?? undefined, mul);
    this.quiet++;
    this.actor = seat;
    this.phase = 'resolve';
    this.settle = 0;
    this.emit({ type: 'flick', seat, speed: f.speed, skill });
    this.emit({ type: 'hud' });
  }

  brake(seat: number) {
    if (this.phase === 'resolve' && this.actor === seat) return this.sim.brake(seat);
    return false;
  }

  skip() {
    if (this.phase !== 'aim') return;
    this.quiet++;
    this.emit({ type: 'timeout', seat: this.turn });
    this.beginTurn(this.nextAlive(this.turn));
  }

  tick(dt: number) {
    if (this.phase === 'aim') {
      if (this.timer) {
        this.turnLeft -= dt;
        if (this.turnLeft <= 0 && this.authority !== 'client') this.skip();
      }
      // 静止时也推进物理（保证画面同步）
      this.stepPhysics(dt);
      return;
    }
    if (this.phase !== 'resolve') return;
    this.stepPhysics(dt);
    if (!this.sim.resolving) {
      this.settle += dt;
      if (this.settle > 0.6) {
        if (this.authority === 'host') this.emit({ type: 'resolved', state: this.sim.getState() });
        if (this.authority === 'client') this.phase = 'waitSync';
        else this.endResolve();
      }
    }
  }

  private acc = 0;
  private stepPhysics(dt: number) {
    this.acc += dt;
    while (this.acc >= 1 / 60) {
      this.acc -= 1 / 60;
      const falls = this.sim.step();
      if (falls.length) this.recordFalls(falls);
      if (this.sim.impacts.length) this.emit({ type: 'impacts', impacts: this.sim.impacts });
    }
  }

  private recordFalls(falls: FallInfo[]) {
    this.quiet = 0;
    for (const f of falls) {
      this.fallOrder.push({ seat: f.index, frame: f.frame });
      if (this.actor >= 0 && f.index !== this.actor) {
        const a = this.seats[this.actor];
        a.kos++;
        a.energy = Math.min(RULES.energyMax, a.energy + RULES.energyPerKO);
      }
    }
    this.emit({ type: 'falls', falls });
  }

  /** 客户端：收到房主的校正后继续 */
  applySync(state: SimState) {
    const localAlive = this.sim.erasers.map((e) => e.alive);
    const mismatch = state.e.some((s, i) => s.alive && !localAlive[i]);
    if (mismatch) {
      this.sim.dispose();
      this.sim = Sim.fromState(this.defs, state);
      this.emit({ type: 'rebuild' });
    } else {
      const killed = this.sim.applyState(state);
      if (killed.length) {
        const falls = killed.map((i) => ({ index: i, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, angle: 0, spin: 0, frame: this.sim.frame }));
        this.recordFalls(falls);
      }
    }
    if (this.phase === 'resolve' || this.phase === 'waitSync') this.endResolve();
  }

  private endResolve() {
    const alive = this.sim.erasers.map((e, i) => (e.alive ? i : -1)).filter((i) => i >= 0);
    if (this.isTwoPlayer) {
      if (alive.length === 2) return this.beginTurn(this.nextAlive(this.turn));
      return this.finishRound(alive);
    }
    if (alive.length >= 2) return this.beginTurn(this.nextAlive(this.turn));
    return this.finishRound(alive);
  }

  private finishRound(alive: number[]) {
    // 名次：活着的第一；其余按落桌先后倒序，同一帧落下的并列
    const groups: number[][] = [];
    if (alive.length) groups.push(alive);
    const byFrame = [...this.fallOrder].sort((a, b) => b.frame - a.frame);
    let prevFrame = NaN;
    for (const f of byFrame) {
      if (f.frame === prevFrame) groups[groups.length - 1].push(f.seat);
      else groups.push([f.seat]);
      prevFrame = f.frame;
    }
    const top = groups[0];
    const draw = this.isTwoPlayer && top.length > 1;
    let how = '';
    const actorName = this.actor >= 0 ? this.seats[this.actor].name : '';
    const lastOut = byFrame[0]?.seat;
    if (lastOut !== undefined) how = lastOut === this.actor ? `${this.seats[lastOut].name}自己冲下了桌` : `${this.seats[lastOut].name}被${actorName}撞下桌`;

    let matchWinner: number[] | null = null;
    if (this.isTwoPlayer) {
      if (!draw) {
        this.seats[top[0]].wins++;
        if (this.seats[top[0]].wins >= RULES.winRounds2p) matchWinner = [top[0]];
        this.starter = 1 - top[0]; // 输的一方下一局先手
      }
    } else {
      groups.forEach((g, rank) => g.forEach((s) => (this.seats[s].points += this.n - 1 - rank)));
      for (const s of this.seats) s.points += s.kos;
      if (this.round >= RULES.roundsFfa) {
        const best = Math.max(...this.seats.map((s) => s.points));
        matchWinner = this.seats.map((s, i) => (s.points === best ? i : -1)).filter((i) => i >= 0);
      }
      this.starter = (this.starter + 1) % this.n;
    }
    const result: RoundResult = { draw, ranking: groups, winner: top.length > 1 ? null : top[0], how, matchWinner };
    this.lastResult = result;
    this.phase = matchWinner ? 'matchOver' : 'roundOver';
    this.emit({ type: 'round', result });
    this.emit({ type: 'hud' });
  }

  nextRound() {
    if (this.phase !== 'roundOver') return;
    if (!this.lastResult?.draw) this.round++;
    this.startRound();
  }

  restart() {
    for (const s of this.seats) {
      s.wins = 0;
      s.points = 0;
    }
    this.round = 1;
    this.starter = 0;
    this.startRound();
  }

  /** 联机：房主掉线后接任 */
  promoteToHost() {
    this.authority = 'host';
    if (this.phase === 'waitSync') {
      this.emit({ type: 'resolved', state: this.sim.getState() });
      this.endResolve();
    }
  }

  /** 联机：把整局元数据打包（房主广播给中途重连的人） */
  meta() {
    return {
      phase: this.phase,
      turn: this.turn,
      turnNo: this.turnNo,
      round: this.round,
      starter: this.starter,
      seats: this.seats.map((s) => ({ energy: s.energy, wins: s.wins, points: s.points, kos: s.kos })),
      fallOrder: this.fallOrder,
      opening: this.opening,
      quiet: this.quiet,
      state: this.sim.getState(),
    };
  }

  loadMeta(m: ReturnType<Match['meta']>) {
    this.round = m.round;
    this.starter = m.starter;
    m.seats.forEach((s, i) => Object.assign(this.seats[i], s));
    this.fallOrder = m.fallOrder;
    this.opening = m.opening;
    this.quiet = m.quiet;
    this.sim?.dispose();
    this.sim = Sim.fromState(this.defs, m.state);
    this.emit({ type: 'rebuild' });
    this.turn = m.turn;
    this.turnNo = m.turnNo;
    this.phase = m.phase === 'resolve' || m.phase === 'waitSync' ? 'waitSync' : m.phase;
    this.turnLeft = RULES.turnSeconds;
    this.emit({ type: 'turn', seat: this.turn });
    this.emit({ type: 'hud' });
  }
}
