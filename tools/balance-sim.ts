// 平衡模拟：让电脑两两对打，输出胜率矩阵。用法：npx tsx tools/balance-sim.ts [每组局数] [难度]
import { CHARACTERS } from '../src/core/config';
import { initPhysics } from '../src/core/sim';
import { Match, type AiLevel } from '../src/game/match';
import { chooseMove, shouldAutoBrake } from '../src/game/ai';

const GAMES = Number(process.argv[2] ?? 6);
const LEVEL = (process.argv[3] ?? 'normal') as AiLevel;
const MAX_TURNS = 40;

async function playRound(a: string, b: string, starter: number): Promise<number | null> {
  const m = new Match(
    [
      { name: a, charId: a, kind: 'ai', aiLevel: LEVEL },
      { name: b, charId: b, kind: 'ai', aiLevel: LEVEL },
    ],
    { timer: false }
  );
  (m as any).starter = starter;
  m.startRound();
  let turns = 0;
  while (m.phase !== 'roundOver' && m.phase !== 'matchOver' && turns < MAX_TURNS) {
    const seat = m.turn;
    const mv = await chooseMove(m, seat, LEVEL);
    if (mv.kind === 'charge') m.toggleSkill(seat);
    else m.flick(seat, mv.flick, mv.skill);
    for (let i = 0; i < 60 * 12 && m.phase === 'resolve'; i++) {
      m.tick(1 / 60);
      if (m.phase === 'resolve' && shouldAutoBrake(m.sim, seat)) m.brake(seat);
    }
    turns++;
  }
  const r = m.lastResult;
  m.sim.dispose();
  if (!r || r.draw || r.winner === null) return null;
  return r.winner;
}

await initPhysics();
const ids = CHARACTERS.map((c) => c.id);
const wins: Record<string, Record<string, number>> = {};
const total: Record<string, { w: number; n: number }> = {};
let firstWins = 0, decided = 0, stale = 0;
for (const a of ids) {
  wins[a] = {};
  total[a] ??= { w: 0, n: 0 };
}
const t0 = Date.now();
for (let i = 0; i < ids.length; i++)
  for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j];
    let wa = 0, n = 0;
    for (let g = 0; g < GAMES; g++) {
      const starter = g % 2;
      const w = await playRound(a, b, starter);
      if (w === null) { stale++; continue; }
      n++;
      decided++;
      if (w === starter) firstWins++;
      if (w === 0) wa++;
    }
    wins[a][b] = n ? wa / n : 0.5;
    wins[b][a] = n ? 1 - wa / n : 0.5;
    total[a].w += wa; total[a].n += n;
    total[b].w += n - wa; total[b].n += n;
    process.stderr.write(`${a} vs ${b}: ${wa}/${n}  (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
console.log('\n胜率矩阵（行对列）');
console.log('         ' + ids.map((s) => s.padStart(9)).join(''));
for (const a of ids) console.log(a.padEnd(9) + ids.map((b) => (a === b ? '   -     ' : (wins[a][b] * 100).toFixed(0).padStart(6) + '%  ')).join(''));
console.log('\n总胜率');
for (const a of ids) console.log(a.padEnd(9), ((total[a].w / Math.max(1, total[a].n)) * 100).toFixed(1) + '%');
console.log(`\n僵局（${MAX_TURNS} 手没人落桌）${stale} 局`);
console.log(`先手胜率 ${((firstWins / Math.max(1, decided)) * 100).toFixed(1)}%  （${decided} 局）`);
