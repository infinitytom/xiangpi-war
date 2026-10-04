// 全部数值的唯一来源。调平衡只改这个文件。

export const TABLE = {
  width: 12, // 课桌桌面宽（游戏单位）
  height: 8,
};

export const PHYS = {
  dt: 1 / 60,
  g: 9.8, // 库仑摩擦：减速度 = μ·g
  restSpeed: 0.04,
  restSpin: 0.08,
  maxResolveTime: 8,
  globalMaxSpeed: 13.5, // 任何橡皮的弹出速度上限
};

export const SKILL_NUM = {
  chargeBoost: 1.7,
  rootGrip: 2,
  braceMass: 1.5,
};

export const RULES = {
  turnSeconds: 15,
  winRounds2p: 2, // 两人局：三局两胜
  roundsFfa: 3, // 多人局：打 3 局累计积分
  energyStart: 1,
  energyMax: 3,
  energyPerTurn: 1,
  energyPerKO: 1,
  openingPower: 0.6, // 每局第一弹的力度上限（防止开局一击必杀）
  secondPlayerBonus: 0,
  escalationAfter: 2, // 连续几整轮没人落桌后开始加力
  escalationStep: 0.08, // 之后每整轮力度上限 +8%
  escalationMax: 1.5, // 非先手的人开局多 1 点能量，抵消先手优势
};

export const FLICK = {
  grabMargin: 0.35, // 按在橡皮轮廓外这么远以内也算按住
  releaseWindowMs: 110, // 出手速度取松手前这段时间内的峰值
  maxDrag: 2.4, // 手指甩出这么远就自动出手，不必等抬手
  speedGain: 0.19, // 玩家实测：旧值 0.42 配灵敏度 0.45 手感最好，折算后作为默认（灵敏度 1）
  speedExp: 1.05,
  minFingerSpeed: 0.4,
};

// ---------- 属性分 1–5 → 物理参数 ----------
const MASS = [0.6, 0.8, 1.0, 1.3, 1.7];
const SIZE = [0.72, 0.86, 1.0, 1.14, 1.3]; // 面积的线性缩放
const GRIP = [0.5, 0.6, 0.7, 0.82, 0.95]; // 桌面摩擦 μ
const BOUNCE = [0.2, 0.32, 0.45, 0.58, 0.72]; // 恢复系数
const POWER = [8.5, 9.5, 10.5, 11.5, 12.5]; // 标准质量下的最大弹出速度；冲量 = 速度 × 质量^0.6（越重越慢，但不至于推不动）

const BASE_W = 1.2, BASE_H = 0.75; // 标准橡皮尺寸（比 M1 缩小了约 25%）

export type SkillId = 'brace' | 'charge' | 'spring' | 'root' | 'curve' | 'sweep' | 'stick' | 'brake';
export type Skin = 'white' | 'elephant' | 'jelly' | 'sand' | 'bear' | 'pen' | 'putty' | 'crumb';

export interface SkillDef {
  id: SkillId;
  name: string;
  cost: number;
  desc: string;
  /** instant：点了立即生效并结束本次；arm：点亮后本次弹射生效 */
  kind: 'arm' | 'instant';
}

export const SKILLS: Record<SkillId, SkillDef> = {
  brace: { id: 'brace', name: '定身', cost: 1, kind: 'arm', desc: '这次弹完后变重 50%，持续到下次轮到你' },
  charge: { id: 'charge', name: '蓄势', cost: 2, kind: 'instant', desc: '这次不弹，下次的最大力度 +70%' },
  spring: { id: 'spring', name: '弹簧', cost: 2, kind: 'arm', desc: '这次第一下碰撞变成超弹，自己也会被弹开' },
  root: { id: 'root', name: '扎根', cost: 2, kind: 'arm', desc: '这次停下后抓地 ×2，持续到下次轮到你' },
  curve: { id: 'curve', name: '旋射', cost: 1, kind: 'arm', desc: '这次带强旋转，弹偏一点会走弧线' },
  sweep: { id: 'sweep', name: '横扫', cost: 2, kind: 'arm', desc: '这次停下后原地转一圈，扫开身边的人' },
  stick: { id: 'stick', name: '黏附', cost: 3, kind: 'arm', desc: '这次第一下碰撞黏住对方 0.8 秒，并多推一把' },
  brake: { id: 'brake', name: '刹车', cost: 1, kind: 'arm', desc: '这次弹出后，点一下屏幕任意处立即停住' },
};

export interface CharacterDef {
  id: string;
  name: string;
  origin: string; // 原型
  type: '均衡' | '力量' | '灵巧' | '防守';
  stats: { mass: number; size: number; grip: number; bounce: number; power: number };
  shape: 'box' | 'ball';
  aspect: number; // 长宽比（box）
  skin: Skin;
  skill: SkillId;
  passive?: string;
}

export const CHARACTERS: CharacterDef[] = [
  { id: 'xiaobai', name: '小白块', origin: '4B 绘图橡皮', type: '均衡', stats: { mass: 3, size: 3, grip: 3, bounce: 3, power: 3.25 }, shape: 'box', aspect: 1.6, skin: 'white', skill: 'brace' },
  { id: 'elephant', name: '大象', origin: '大块美术橡皮', type: '力量', stats: { mass: 4, size: 4, grip: 3, bounce: 1, power: 1 }, shape: 'box', aspect: 1.45, skin: 'elephant', skill: 'charge' },
  { id: 'jelly', name: '果冻', origin: '香味果冻橡皮', type: '灵巧', stats: { mass: 1, size: 2, grip: 3, bounce: 4.25, power: 4 }, shape: 'box', aspect: 1.3, skin: 'jelly', skill: 'spring' },
  { id: 'sand', name: '砂擦', origin: '双色砂橡皮', type: '防守', stats: { mass: 3, size: 3, grip: 3.75, bounce: 1, power: 3 }, shape: 'box', aspect: 1.9, skin: 'sand', skill: 'root' },
  { id: 'bear', name: '小熊头', origin: '卡通造型橡皮', type: '灵巧', stats: { mass: 3, size: 2, grip: 3, bounce: 3, power: 3.25 }, shape: 'ball', aspect: 1, skin: 'bear', skill: 'curve' },
  { id: 'pen', name: '笔形擦', origin: '长条铅笔头橡皮', type: '力量', stats: { mass: 3, size: 4, grip: 4.25, bounce: 2.5, power: 3 }, shape: 'box', aspect: 3.6, skin: 'pen', skill: 'sweep', passive: '长条形，被撞到一端时会转动卸力' },
  { id: 'putty', name: '橡皮泥', origin: '可塑橡皮', type: '防守', stats: { mass: 2, size: 3, grip: 4, bounce: 1, power: 3.75 }, shape: 'ball', aspect: 1, skin: 'putty', skill: 'stick' },
  { id: 'crumb', name: '橡皮屑', origin: '用剩的小块橡皮', type: '灵巧', stats: { mass: 2, size: 1, grip: 3, bounce: 2, power: 4.25 }, shape: 'box', aspect: 1.3, skin: 'crumb', skill: 'brake' },
];

/** 物理用的具体参数 */
export interface EraserDef {
  charId: string;
  shape: 'box' | 'ball';
  w: number; // box：长；ball：直径
  h: number; // box：宽；ball：直径
  t: number; // 厚
  mass: number;
  mu: number;
  restitution: number;
  maxImpulse: number;
  skin: Skin;
}

export function eraserDef(c: CharacterDef): EraserDef {
  // 属性分可以是小数（如 3.5），在两档之间线性插值
  const s = (k: keyof CharacterDef['stats'], table: number[]) => {
    const v = Math.min(5, Math.max(1, c.stats[k])) - 1;
    const i = Math.floor(v), f = v - i;
    return i >= 4 ? table[4] : table[i] * (1 - f) + table[i + 1] * f;
  };
  const scale = s('size', SIZE);
  const area = BASE_W * BASE_H * scale * scale;
  let w: number, h: number;
  if (c.shape === 'ball') {
    w = h = 2 * Math.sqrt(area / Math.PI);
  } else {
    h = Math.sqrt(area / c.aspect);
    w = h * c.aspect;
  }
  const t = c.skin === 'putty' ? 0.42 * scale : c.skin === 'pen' ? h * 0.9 : 0.34 * Math.sqrt(scale);
  return {
    charId: c.id,
    shape: c.shape,
    w,
    h,
    t,
    mass: s('mass', MASS),
    mu: s('grip', GRIP),
    restitution: s('bounce', BOUNCE),
    maxImpulse: s('power', POWER) * Math.pow(s('mass', MASS), 0.6),
    skin: c.skin,
  };
}

export const charById = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];

/** 座位颜色（墨水色），最多 6 人 */
export const SEAT_COLORS = ['#2c4a8e', '#b2433f', '#2f7a4f', '#8a5a1e', '#6b3fa0', '#1f7f8a'];
export const SEAT_NAMES = ['蓝方', '红方', '绿方', '棕方', '紫方', '青方'];
