// 人机：生成候选弹法 → 在独立的物理副本里前向模拟 → 打分选最好的
import { PHYS, TABLE } from '../core/config';
import { Sim, type SimState, type Vec2 } from '../core/sim';
import type { AiLevel, FlickInputData, Match } from './match';

export type AiMove = { kind: 'flick'; flick: FlickInputData; skill: boolean } | { kind: 'charge' };

const LEVEL = {
  easy: { samples: 36, angleNoise: 9, speedNoise: 0.16, counter: 0, useSkill: 0.3 },
  normal: { samples: 120, angleNoise: 3, speedNoise: 0.06, counter: 0, useSkill: 1 },
  hard: { samples: 260, angleNoise: 0.6, speedNoise: 0.02, counter: 10, useSkill: 1 },
};

const edgeDist = (x: number, y: number) => Math.min(TABLE.width / 2 - Math.abs(x), TABLE.height / 2 - Math.abs(y));

/** 刹车技能的自动触发条件（AI 模拟与实战共用，保证一致） */
export function shouldAutoBrake(sim: Sim, seat: number): boolean {
  const e = sim.erasers[seat];
  if (!e.body || !e.fx.brakeArmed) return false;
  const p = e.body.translation(), v = e.body.linvel();
  const sp = Math.hypot(v.x, v.y);
  if (sp < 0.5) return false;
  const nx = p.x + (v.x / sp) * 0.9, ny = p.y + (v.y / sp) * 0.9;
  return edgeDist(nx, ny) < 0.35 && edgeDist(nx, ny) < edgeDist(p.x, p.y);
}

/** 击中点：沿方向的橡皮后沿中点，再加横向偏移 */
function hitPoint(st: SimState['e'][number], w: number, h: number, round: boolean, dir: Vec2, lateral: number): Vec2 {
  const back = round ? w / 2 : Math.abs(((w / 2) * (dir.x * Math.cos(st.a) + dir.y * Math.sin(st.a)))) + Math.abs(((h / 2) * (-dir.x * Math.sin(st.a) + dir.y * Math.cos(st.a))));
  return { x: st.x - dir.x * back * 0.98 - dir.y * lateral, y: st.y - dir.y * back * 0.98 + dir.x * lateral };
}

function simulate(match: Match, base: SimState, seat: number, f: FlickInputData, skill: boolean): Sim {
  const sim = Sim.fromState(match.defs, base);
  const sk = match.skillOf(seat);
  sim.flick(seat, f.dir, f.speed, f.point, skill && sk.kind === 'arm' ? sk.id : undefined, match.powerMul);
  for (let i = 0; i < PHYS.maxResolveTime * 60 && sim.resolving; i++) {
    sim.step();
    if (shouldAutoBrake(sim, seat)) sim.brake(seat);
  }
  return sim;
}

function evaluate(match: Match, sim: Sim, seat: number): number {
  let score = 0;
  sim.erasers.forEach((e, i) => {
    if (i === seat) return;
    if (!match.sim.erasers[i].alive) return; // 早就掉了的不算
    if (!e.alive) score += 100;
    else {
      const p = e.body!.translation();
      score += 22 * Math.max(0, 1 - edgeDist(p.x, p.y) / 3);
    }
  });
  const me = sim.erasers[seat];
  if (!me.alive) score -= 160;
  else {
    const p = me.body!.translation();
    score -= 30 * Math.max(0, 1 - edgeDist(p.x, p.y) / 2.2);
    score += 3 * Math.max(0, 1 - Math.hypot(p.x, p.y) / 5); // 稍微偏好站在中间
  }
  return score;
}

/** 困难：假设对手用最直接的方式反击，看自己会不会被撞下去 */
function counterRisk(match: Match, sim: Sim, seat: number): number {
  if (!sim.erasers[seat].alive) return 0;
  const st = sim.getState();
  const me = st.e[seat];
  let worst = 0;
  sim.erasers.forEach((e, j) => {
    if (j === seat || !e.alive) return;
    const o = st.e[j];
    const dx = me.x - o.x, dy = me.y - o.y, d = Math.hypot(dx, dy) || 1;
    const dir = { x: dx / d, y: dy / d };
    const def = match.defs[j];
    const s2 = Sim.fromState(match.defs, st);
    s2.flick(j, dir, PHYS.globalMaxSpeed * match.powerMul, hitPoint(o, def.w, def.h, def.shape === 'ball', dir, 0), undefined, match.powerMul);
    for (let i = 0; i < 480 && s2.resolving; i++) s2.step();
    if (!s2.erasers[seat].alive) worst = Math.max(worst, 120);
    s2.dispose();
  });
  return worst;
}

const rand = (a: number) => (Math.random() * 2 - 1) * a;

export async function chooseMove(match: Match, seat: number, level: AiLevel): Promise<AiMove> {
  const L = LEVEL[level];
  const base = match.sim.getState();
  const me = base.e[seat];
  const def = match.defs[seat];
  const sk = match.skillOf(seat);
  const canSkill = match.canAfford(seat) && Math.random() < L.useSkill;
  const vmax = match.maxSpeedOf(seat);

  // 候选方向：瞄准每个对手（带小偏移）+ 均匀方向
  const dirs: number[] = [];
  base.e.forEach((o, j) => {
    if (j === seat || !o.alive) return;
    const a = Math.atan2(o.y - me.y, o.x - me.x);
    for (const off of [0, -0.05, 0.05, -0.11, 0.11, -0.2, 0.2]) dirs.push(a + off);
  });
  for (let k = 0; k < 16; k++) dirs.push((k / 16) * Math.PI * 2);
  const speeds = [0.3, 0.45, 0.6, 0.75, 0.88, 1.0];
  const lats = level === 'hard' ? [0, -0.25, 0.25] : [0];

  type Cand = { f: FlickInputData; skill: boolean; score: number; lat: number };
  const cands: Cand[] = [];
  const all: { a: number; s: number; l: number; skill: boolean }[] = [];
  for (const a of dirs) for (const s of speeds) for (const l of lats) {
    all.push({ a, s, l, skill: false });
    if (canSkill && sk.kind === 'arm') all.push({ a, s, l, skill: true });
  }
  // 随机抽样到预算
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const pick = all.slice(0, L.samples);
  // 保证瞄准对手的正面全力弹一定在候选里
  pick.push(...all.filter((c) => c.l === 0 && c.s >= 0.88).slice(0, 8));

  let n = 0;
  for (const c of pick) {
    const dir = { x: Math.cos(c.a), y: Math.sin(c.a) };
    const f: FlickInputData = { dir, speed: vmax * c.s, point: hitPoint(me, def.w, def.h, def.shape === 'ball', dir, c.l * def.h) };
    const sim = simulate(match, base, seat, f, c.skill);
    let score = evaluate(match, sim, seat) - (c.skill ? sk.cost * 4 : 0);
    sim.dispose();
    cands.push({ f, skill: c.skill, score, lat: c.l * def.h });
    if (++n % 12 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  cands.sort((a, b) => b.score - a.score);

  if (L.counter > 0) {
    for (const c of cands.slice(0, L.counter)) {
      const sim = simulate(match, base, seat, c.f, c.skill);
      c.score -= counterRisk(match, sim, seat);
      sim.dispose();
      await new Promise((r) => setTimeout(r, 0));
    }
    cands.sort((a, b) => b.score - a.score);
  }

  // 大象：没有好机会时蓄势
  if (sk.kind === 'instant' && canSkill && !me.fx.charged && cands[0].score < 20) return { kind: 'charge' };

  const best = cands[0];
  // 操作误差
  const ang = Math.atan2(best.f.dir.y, best.f.dir.x) + (rand(L.angleNoise) * Math.PI) / 180;
  const dir = { x: Math.cos(ang), y: Math.sin(ang) };
  return {
    kind: 'flick',
    skill: best.skill,
    flick: { dir, speed: best.f.speed * (1 + rand(L.speedNoise)), point: hitPoint(me, def.w, def.h, def.shape === 'ball', dir, best.lat) },
  };
}
