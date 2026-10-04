import './style.css';
import { CHARACTERS, charById, RULES, SEAT_COLORS, SEAT_NAMES, SKILLS, type CharacterDef } from './core/config';
import { initPhysics, type Vec2 } from './core/sim';
import { GameScene } from './render/scene';
import { FlickInput, fingerToLaunch, type FlickTarget } from './input/flick';
import { audioSettings, sfxFlick, sfxFloor, sfxHit, sfxSlide, sfxTick, unlockAudio } from './audio';
import { Fullscreen, keepAwake } from './ui/fullscreen';
import { Match, type AiLevel, type MatchEvent, type SeatConfig } from './game/match';
import { chooseMove, shouldAutoBrake } from './game/ai';
import { OnlineRoom, type Action, type Lobby } from './net/online';
import { selfPeerId, type Transport } from './net/transport';
import { BroadcastTransport } from './net/broadcast';
import { GoEasyTransport } from './net/goeasy';
import { GOEASY, MAX_PLAYERS } from './net/netconfig';
import { MqttTransport } from './net/mqtt';
import donateUrl from './assets/donate-alipay.png';

// ---------------- 设置（本机保存） ----------------
interface LocalSeat {
  kind: 'human' | 'easy' | 'normal' | 'hard';
  charId: string;
}
const settings = {
  sensitivity: 1,
  timer: true,
  faceToFace: false,
  sound: true,
  autoFullscreen: true,
  name: '',
  localSeats: [
    { kind: 'human', charId: 'xiaobai' },
    { kind: 'normal', charId: 'elephant' },
  ] as LocalSeat[],
  onlineChar: 'xiaobai',
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('xp_settings2') || '{}'));
} catch {}
function saveSettings() {
  try {
    localStorage.setItem('xp_settings2', JSON.stringify(settings));
  } catch {}
  audioSettings.enabled = settings.sound;
}
audioSettings.enabled = settings.sound;

// ---------------- 全局状态 ----------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let scene: GameScene;
let match: Match | null = null;
let room: OnlineRoom | null = null;
let mode: 'menu' | 'local' | 'online' = 'menu';
let paused = false;
let aiToken = -1;
let freezeUntil = 0; // 顿帧：重击时物理短暂停住
let lastPowerMul = 1;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function controlOf(seat: number): 'me' | 'ai' | 'remote' {
  if (!match) return 'remote';
  if (mode === 'online' && room) return room.controlOf(seat);
  return match.seats[seat].kind === 'ai' ? 'ai' : 'me';
}

// ---------------- 对局 ----------------
function attachMatch(m: Match) {
  match = m;
  aiToken = -1;
  paused = false;
  m.on(onMatchEvent);
  hideOverlay();
  (window as any).__wantAwake = true;
  keepAwake(true);
}

function startLocal() {
  const cfg: SeatConfig[] = settings.localSeats.map((s, i) => ({
    name: s.kind === 'human' ? (settings.localSeats.filter((x) => x.kind === 'human').length > 1 ? SEAT_NAMES[i] : settings.name || '你') : `电脑${i + 1}`,
    charId: s.charId,
    kind: s.kind === 'human' ? 'human' : 'ai',
    aiLevel: s.kind === 'human' ? undefined : (s.kind as AiLevel),
  }));
  mode = 'local';
  room?.leave();
  room = null;
  const m = new Match(cfg, { timer: settings.timer });
  attachMatch(m);
  m.startRound();
  maybeAutoFullscreen();
}

function onMatchEvent(e: MatchEvent) {
  const m = match!;
  switch (e.type) {
    case 'rebuild':
      scene.setErasers(m.defs, m.seats.map((s) => s.color));
      m.sim.erasers.forEach((er, i) => er.alive && scene.sync(i, m.sim.snapshot(i)));
      m.sim.erasers.forEach((er, i) => {
        if (!er.alive) scene.erasers[i].mesh.visible = false, (scene.erasers[i].mark.visible = false);
      });
      break;
    case 'falls':
      for (const f of e.falls) {
        if (f.pos.x === 0 && f.pos.y === 0) {
          // 房主校正判定的落桌：从当前位置掉下去
          const p = scene.erasers[f.index].mesh.position;
          f.pos = { x: p.x, y: -p.z };
          f.vel = { x: Math.sign(p.x) * 1.5, y: -Math.sign(p.z) * 0.5 };
        }
        scene.startFall(f);
        setTimeout(sfxFloor, 620);
        toast(`${m.seats[f.index].name} 落桌！`, 1400);
      }
      break;
    case 'impacts':
      for (const im of e.impacts) {
        const k = im.speed / 12;
        sfxHit(k);
        scene.squash(im.a, im.speed / 14);
        scene.squash(im.b, im.speed / 14);
        const pa = m.sim.snapshot(im.a), pb = m.sim.snapshot(im.b);
        scene.tilt(im.a, pa.x - pb.x, pa.y - pb.y, im.speed);
        scene.tilt(im.b, pb.x - pa.x, pb.y - pa.y, im.speed);
        if (im.speed > 2) scene.burst(im.x, im.y, k);
        if (im.speed > 5) {
          scene.shake(im.speed * 0.018);
          freezeUntil = performance.now() + Math.min(90, im.speed * 7);
        }
      }
      break;
    case 'flick': {
      scene.squash(e.seat, 0.4 + e.speed / 12);
      sfxFlick(e.speed / 12);
      const sp = m.sim.snapshot(e.seat);
      if (e.speed > 6) scene.burst(sp.x, sp.y, e.speed / 30, '#d9cdb4');
      if (e.skill) toast(`${m.seats[e.seat].name}：${SKILLS[e.skill].name}！`, 1300);
      break;
    }
    case 'skill':
      toast(`${m.seats[e.seat].name}：${SKILLS[e.skill].name}！`, 1500);
      break;
    case 'timeout':
      toast(`${m.seats[e.seat].name} 超时，跳过这一次`, 1600);
      break;
    case 'turn':
      if (m.powerMul > lastPowerMul + 0.01) toast(`好久没人落桌，力度上限提高到 ×${m.powerMul.toFixed(2)}`, 2200);
      lastPowerMul = m.powerMul;
      if (controlOf(e.seat) === 'me' && m.seats.filter((_, i) => controlOf(i) === 'me').length > 1) toast(`轮到 ${m.seats[e.seat].name}`, 1100);
      break;
    case 'round':
      setTimeout(() => showRoundResult(), 500);
      break;
    case 'hud':
      updateHud();
      break;
  }
}

function sendAction(a: Action) {
  if (mode === 'online' && room) room.sendAction(a);
}

// ---------------- AI ----------------
function runAI() {
  const m = match;
  if (!m || paused || m.phase !== 'aim' || controlOf(m.turn) !== 'ai' || aiToken === m.turnNo) return;
  aiToken = m.turnNo;
  const token = m.turnNo, seat = m.turn;
  const level = m.seats[seat].aiLevel ?? 'normal';
  const t0 = performance.now();
  chooseMove(m, seat, level).then(async (move) => {
    const wait = 900 + Math.random() * 600 - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    while (paused) await new Promise((r) => setTimeout(r, 200));
    if (match !== m || m.turnNo !== token || m.phase !== 'aim') return;
    if (move.kind === 'charge') {
      if (m.toggleSkill(seat)) sendAction({ kind: 'charge', seat });
    } else {
      m.flick(seat, move.flick, move.skill);
      sendAction({ kind: 'flick', seat, f: move.flick, skill: move.skill });
    }
  });
}

// ---------------- 输入 ----------------
function setupInput(el: HTMLElement) {
  new FlickInput(el, {
    pick() {
      unlockAudio();
      if (!match || paused || match.phase !== 'aim') return null;
      return controlOf(match.turn) === 'me' ? match.turn : null;
    },
    targetInfo(i): FlickTarget | null {
      const e = match?.sim.erasers[i];
      if (!e || !e.alive || !e.body || !match || match.phase !== 'aim' || match.turn !== i) return null;
      const s = match.sim.snapshot(i);
      return { x: s.x, y: s.y, angle: s.angle, w: e.def.w, h: e.def.h, round: e.def.shape === 'ball' };
    },
    toTable: (x, y) => scene.screenToTable(x, y),
    onStart(p, i) {
      scene.trailStart(p.x, p.y);
      scene.setPower(i, 0);
    },
    onMove(p, speed) {
      scene.trailAdd(p.x, p.y);
      const m = match;
      if (m && m.phase === 'aim') scene.setPower(m.turn, fingerToLaunch(speed, settings.sensitivity) / m.maxSpeedOf(m.turn));
    },
    onFlick(i, r) {
      const m = match!;
      const speed = fingerToLaunch(r.fingerSpeed, settings.sensitivity);
      const skill = m.armed;
      const f = { dir: r.dir, speed, point: r.point };
      scene.setPower(-1, 0);
      m.flick(i, f, skill);
      sendAction({ kind: 'flick', seat: i, f, skill });
    },
    onTap(p: Vec2) {
      unlockAudio();
      const m = match;
      if (!m || paused) return;
      if (m.phase === 'resolve' && controlOf(m.actorSeat) === 'me' && m.brake(m.actorSeat)) {
        sendAction({ kind: 'brake', seat: m.actorSeat });
        toast('刹车！', 800);
        return;
      }
      if (m.phase === 'aim' && controlOf(m.turn) === 'me') {
        const s = m.sim.snapshot(m.turn);
        if (Math.hypot(s.x - p.x, s.y - p.y) < 4) toast('要在橡皮周围的虚线圈里起手', 1500);
      }
    },
    onCancel(reason) {
      scene.setPower(-1, 0);
      if (!match || match.phase !== 'aim') return;
      if (reason === 'weak') toast('太轻了，再弹快一点', 1400);
    },
  });
}

// ---------------- 主循环 ----------------
let last = performance.now();
let lastLogic = performance.now();

/** 游戏逻辑一步。前台由动画帧驱动；切到后台时由定时器驱动（动画帧会被浏览器暂停） */
function logic(t: number) {
  const hidden = document.visibilityState === 'hidden';
  const dt = Math.min(hidden ? 1.5 : 0.1, (t - lastLogic) / 1000);
  lastLogic = t;
  const m = match;
  if (!m || paused || dt <= 0) return dt;
  const before = Math.ceil(m.turnLeft);
  if (t >= freezeUntil || hidden) m.tick(dt);
  if (m.phase === 'aim' && m.timer && Math.ceil(m.turnLeft) !== before && m.turnLeft <= 5 && m.turnLeft > 0 && controlOf(m.turn) === 'me') sfxTick();
  runAI();
  if (m.phase === 'resolve' && controlOf(m.actorSeat) === 'ai' && shouldAutoBrake(m.sim, m.actorSeat)) {
    if (m.brake(m.actorSeat)) sendAction({ kind: 'brake', seat: m.actorSeat });
  }
  return dt;
}
setInterval(() => {
  const t = performance.now();
  if (t - lastLogic > 200) logic(t);
}, 250);

function frame(t: number) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  logic(t);
  const m = match;
  if (m && !paused) {
    sfxSlide(m.sim.erasers.reduce((a, _e, i) => a + m.sim.speedOf(i), 0) / 10);
    m.sim.erasers.forEach((e, i) => {
      if (e.alive) scene.sync(i, m.sim.snapshot(i));
      scene.setEffects(i, e.fx);
    });
    updateTimer();
  } else sfxSlide(0);
  scene.showRing(m && m.phase === 'aim' && controlOf(m.turn) === 'me' && !paused ? m.turn : -1);
  scene.update(dt, t / 1000);
  requestAnimationFrame(frame);
}

// ---------------- HUD ----------------
function updateHud() {
  const m = match;
  const score = $('score');
  const banner = $('turn');
  const skillBtn = $('btn-skill');
  if (!m || mode === 'menu') {
    score.innerHTML = '';
    banner.className = '';
    skillBtn.className = '';
    return;
  }
  if (m.isTwoPlayer) {
    const dots = (n: number) => '●'.repeat(n) + '○'.repeat(RULES.winRounds2p - n);
    const [a, b] = m.seats;
    score.innerHTML = `<span style="color:${a.color}">${esc(a.name)} ${dots(a.wins)}</span><em>第 ${m.round} 局</em><span style="color:${b.color}">${dots(b.wins)} ${esc(b.name)}</span>`;
  } else {
    score.innerHTML =
      `<em>第 ${m.round}/${RULES.roundsFfa} 局</em>` +
      m.seats
        .map((s, i) => `<span class="chip${m.sim?.erasers[i]?.alive ? '' : ' out'}" style="color:${s.color}">${esc(s.name)} <b>${s.points}</b></span>`)
        .join('');
  }
  const s = m.seats[m.turn];
  const ctl = controlOf(m.turn);
  if (m.phase === 'aim' || m.phase === 'resolve' || m.phase === 'waitSync') {
    const char = charById(s.charId);
    let text = '';
    if (m.phase !== 'aim') text = `${esc(s.name)} 出手了`;
    else if (ctl === 'me') text = `轮到${esc(s.name)}<small>${char.name}${m.opening ? ' · 第一弹只有六成力' : m.powerMul > 1 ? ` · 力度 ×${m.powerMul.toFixed(2)}` : ''}</small>`;
    else if (ctl === 'ai') text = `${esc(s.name)} 正在想…`;
    else text = `等 ${esc(s.name)} 出手`;
    banner.innerHTML = `<b style="color:${s.color}">${text}</b><span class="pips">${pips(s.energy)}</span><i id="timer"></i>`;
    banner.className = 'show ' + placementClass(m.turn);
  } else banner.className = '';
  // 技能按钮
  if (m.phase === 'aim' && ctl === 'me' && !paused) {
    const sk = m.skillOf(m.turn);
    const ok = m.canAfford(m.turn);
    skillBtn.innerHTML = `<b>${sk.name}</b><span>${'◆'.repeat(sk.cost)}</span><small>${sk.desc}</small>`;
    skillBtn.className = 'show' + (m.armed ? ' armed' : '') + (ok || m.armed ? '' : ' disabled') + ' ' + placementClass(m.turn);
  } else skillBtn.className = '';
  updateTimer();
}

const pips = (n: number) => `<span title="能量">${'◆'.repeat(n)}${'◇'.repeat(RULES.energyMax - n)}</span>`;

function placementClass(seat: number) {
  if (!settings.faceToFace || !match?.isTwoPlayer || mode !== 'local') return '';
  if (scene.portrait) return seat === 0 ? 'seat-top' : 'seat-bottom';
  return seat === 0 ? 'seat-left' : 'seat-right';
}

function updateTimer() {
  const t = document.getElementById('timer');
  const m = match;
  if (!t || !m) return;
  if (!m.timer || m.phase !== 'aim') {
    t.style.display = 'none';
    return;
  }
  t.style.display = '';
  t.style.setProperty('--p', String(Math.max(0, m.turnLeft / RULES.turnSeconds)));
  t.classList.toggle('urgent', m.turnLeft <= 5);
}

let toastTimer = 0;
function toast(msg: string, ms = 2000) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show ' + (match ? placementClass(match.turn) : '');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = ''), ms);
}

function showOverlay(html: string) {
  $('panel').innerHTML = html;
  $('overlay').classList.add('show');
}
function hideOverlay() {
  $('overlay').classList.remove('show');
}

// ---------------- 角色卡 ----------------
function charCard(c: CharacterDef) {
  const bar = (n: number) => {
    const full = Math.floor(n), half = n - full >= 0.5 ? 1 : 0;
    return '●'.repeat(full) + (half ? '◐' : '') + '○'.repeat(5 - full - half);
  };
  const sk = SKILLS[c.skill];
  return `<div class="card">
    <div class="card-head"><b>${c.name}</b><span>${c.origin} · ${c.type}</span></div>
    <div class="stats">
      <span>质量</span><i>${bar(c.stats.mass)}</i><span>尺寸</span><i>${bar(c.stats.size)}</i>
      <span>抓地</span><i>${bar(c.stats.grip)}</i><span>弹性</span><i>${bar(c.stats.bounce)}</i>
      <span>力度</span><i>${bar(c.stats.power)}</i>
    </div>
    <p><b>${sk.name}</b> <span class="cost">${'◆'.repeat(sk.cost)}</span> ${sk.desc}</p>
    ${c.passive ? `<p class="small">被动：${c.passive}</p>` : ''}
  </div>`;
}
const charOptions = (sel: string) => CHARACTERS.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.name}</option>`).join('');

// ---------------- 界面：标题 ----------------
function titleScreen() {
  mode = 'menu';
  match = null;
  room?.leave();
  room = null;
  paused = false;
  (window as any).__wantAwake = false;
  keepAwake(false);
  scene.setErasers([], []);
  updateHud();
  showOverlay(`
    <h1>橡皮大战</h1>
    <p class="sub">—— 课桌上的那场老战役 ——</p>
    <button class="stamp" data-act="local">本地对战</button>
    <button class="stamp" data-act="online">联机对战</button>
    <button class="stamp ghost" data-act="settings">设置</button>
    <p class="small">轮流弹自己的橡皮，把别人弹下课桌就赢 · 横放平板体验最好</p>
    <button class="donate" data-act="donate"><img src="${donateUrl}" alt="支付宝赞赏码"><span>好玩的话，<br>请作者喝瓶汽水</span></button>`);
}

function donateScreen() {
  showOverlay(`
    <h2>请作者喝瓶汽水</h2>
    <img class="donate-big" src="${donateUrl}" alt="支付宝赞赏码">
    <p class="small">打开支付宝「扫一扫」。在同一台设备上的话，可以截图后在扫一扫里选相册识别。</p>
    <button class="stamp ghost small-btn" data-act="title">返回</button>`);
}

// ---------------- 界面：本地对战设置 ----------------
let focusSeat = 0;
function localSetup() {
  const seats = settings.localSeats;
  const rows = seats
    .map(
      (s, i) => `<div class="seat${i === focusSeat ? ' focus' : ''}" data-seat="${i}">
      <span class="dot" style="background:${SEAT_COLORS[i]}"></span>
      <select id="ls-kind-${i}" data-k="kind" data-i="${i}">
        ${(['human', 'easy', 'normal', 'hard'] as const).map((k) => `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${{ human: '玩家', easy: '电脑·简单', normal: '电脑·普通', hard: '电脑·困难' }[k]}</option>`).join('')}
      </select>
      <select id="ls-char-${i}" data-k="char" data-i="${i}">${charOptions(s.charId)}</select>
      ${seats.length > 2 ? `<button class="x" data-act="ls-del" data-i="${i}" aria-label="移除">×</button>` : '<span class="x"></span>'}
    </div>`
    )
    .join('');
  showOverlay(`
    <h2>本地对战</h2>
    <p class="small">同一台设备轮流弹；也可以让电脑坐几个位置。2 人三局两胜，3–6 人打 ${RULES.roundsFfa} 局算总分。</p>
    <div class="seats">${rows}</div>
    ${seats.length < MAX_PLAYERS ? '<button class="stamp ghost small-btn" data-act="ls-add">＋ 加一个位置</button>' : ''}
    ${charCard(charById(seats[focusSeat]?.charId ?? 'xiaobai'))}
    <button class="stamp" data-act="ls-start">开始</button>
    <button class="stamp ghost small-btn" data-act="title">返回</button>`);
  $('panel').querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.i);
      if (sel.dataset.k === 'kind') seats[i].kind = sel.value as LocalSeat['kind'];
      else seats[i].charId = sel.value;
      focusSeat = i;
      saveSettings();
      localSetup();
    });
    sel.addEventListener('focus', () => {
      if (focusSeat !== Number(sel.dataset.i)) {
        focusSeat = Number(sel.dataset.i);
        const card = $('panel').querySelector('.card');
        if (card) card.outerHTML = charCard(charById(seats[focusSeat].charId));
        $('panel').querySelectorAll('.seat').forEach((r) => r.classList.toggle('focus', Number((r as HTMLElement).dataset.seat) === focusSeat));
      }
    });
  });
}

// ---------------- 界面：联机 ----------------
function onlineMenu(err = '') {
  const hasKey = !!GOEASY.appkey;
  showOverlay(`
    <h2>联机对战</h2>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <label class="row">你的名字 <input id="on-name" maxlength="8" value="${esc(settings.name)}" placeholder="比如：同桌"></label>
    <label class="row">你的橡皮 <select id="on-char">${charOptions(settings.onlineChar)}</select></label>
    <button class="stamp" data-act="on-create">创建房间</button>
    <div class="row join"><input id="on-code" inputmode="numeric" maxlength="5" placeholder="5 位房间号" value="${esc(new URLSearchParams(location.search).get('room') ?? '')}"><button class="stamp small-btn" data-act="on-join">加入</button></div>
    <label class="row"><input type="checkbox" id="on-local"> 本机多标签页测试（不联网，同一浏览器开几个标签页）</label>
    <p class="small">联机走${hasKey ? ' GoEasy' : '免费公共服务器'}，大家输入同一个房间号即可，不需要在同一个 Wi-Fi。</p>
    <button class="stamp ghost small-btn" data-act="title">返回</button>`);
}

function makeTransport(): Transport {
  const local = ($('on-local') as HTMLInputElement | null)?.checked ?? false;
  if (local) return new BroadcastTransport(selfPeerId());
  if (GOEASY.appkey) return new GoEasyTransport(selfPeerId());
  return new MqttTransport(selfPeerId());
}

function readOnlineForm() {
  settings.name = ($('on-name') as HTMLInputElement).value.trim().slice(0, 8);
  settings.onlineChar = ($('on-char') as HTMLSelectElement).value;
  saveSettings();
}

async function openRoom(create: boolean) {
  readOnlineForm();
  const code = create ? String(10000 + Math.floor(Math.random() * 90000)) : ($('on-code') as HTMLInputElement).value.trim();
  if (!/^\d{5}$/.test(code)) return onlineMenu('房间号是 5 位数字');
  const t = makeTransport();
  room?.leave();
  const r = new OnlineRoom(t, code, { name: settings.name || '同学', charId: settings.onlineChar }, {
    lobby: (l) => mode !== 'online' && room === r && showLobby(l),
    start: (m) => {
      mode = 'online';
      attachMatch(m);
    },
    action: () => updateHud(),
    toast: (msg) => toast(msg, 2200),
    closed: (reason) => {
      if (room === r) {
        room = null;
        match = null;
        mode = 'menu';
        scene.setErasers([], []);
        updateHud();
        onlineMenu(reason);
      }
    },
  });
  room = r;
  showOverlay(`<h2>${create ? '正在创建房间…' : '正在进入房间…'}</h2><p>${t.label}</p>`);
  try {
    if (create) await r.create(settings.timer);
    else await r.join();
    showLobby(r.lobby);
  } catch (e: any) {
    if (room === r) {
      r.leave();
      room = null;
      onlineMenu(e?.message ?? String(e));
    }
  }
}

function showLobby(l: Lobby) {
  const r = room;
  if (!r || mode === 'online') return;
  const host = r.isHost;
  const rows = l.seats
    .map((s, i) => {
      const mine = s.peerId === r.selfId;
      const online = s.kind === 'ai' || r.isOnline(s.peerId);
      const who = s.kind === 'ai' ? '电脑' : esc(s.name) + (s.peerId === l.host ? '（房主）' : '') + (mine ? '（你）' : '') + (online ? '' : ' · 掉线');
      const charSel = mine || (host && s.kind === 'ai') ? `<select data-k="char" data-i="${i}">${charOptions(s.charId)}</select>` : `<span class="cname">${charById(s.charId).name}</span>`;
      const lvl =
        host && s.kind === 'ai'
          ? `<select data-k="lvl" data-i="${i}">${(['easy', 'normal', 'hard'] as const).map((k) => `<option value="${k}" ${s.aiLevel === k ? 'selected' : ''}>${{ easy: '简单', normal: '普通', hard: '困难' }[k]}</option>`).join('')}</select>`
          : s.kind === 'ai'
            ? `<span class="cname">${{ easy: '简单', normal: '普通', hard: '困难' }[s.aiLevel ?? 'normal']}</span>`
            : '';
      const del = host && !mine ? `<button class="x" data-act="lb-del" data-i="${i}" aria-label="移除">×</button>` : '<span class="x"></span>';
      return `<div class="seat"><span class="dot" style="background:${SEAT_COLORS[i]}"></span><span class="who">${who}</span>${charSel}${lvl}${del}</div>`;
    })
    .join('');
  const myChar = l.seats.find((s) => s.peerId === r.selfId)?.charId ?? settings.onlineChar;
  showOverlay(`
    <h2>房间 <span class="code">${r.code}</span></h2>
    <p class="small">把房间号告诉同学，在「联机对战」里输入就能进来 · ${r.t.label} · 最多 ${MAX_PLAYERS} 人</p>
    <div class="seats">${rows}</div>
    ${host && l.seats.length < MAX_PLAYERS ? '<button class="stamp ghost small-btn" data-act="lb-ai">＋ 加一个电脑</button>' : ''}
    ${host ? `<label class="row"><input type="checkbox" id="lb-timer" ${l.timer ? 'checked' : ''}> 每次限时 ${RULES.turnSeconds} 秒</label>` : ''}
    ${charCard(charById(myChar))}
    ${host ? `<button class="stamp" data-act="lb-start" ${l.seats.length < 2 ? 'disabled' : ''}>开始</button>` : '<p>等房主开始…</p>'}
    <button class="stamp ghost small-btn" data-act="title">离开房间</button>`);
  $('panel').querySelectorAll('select').forEach((sel) =>
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.i);
      const s = l.seats[i];
      if (sel.dataset.k === 'char') {
        if (s.peerId === r.selfId) {
          settings.onlineChar = sel.value;
          saveSettings();
          r.pickChar(sel.value);
        } else r.editSeat(i, { charId: sel.value });
      } else r.editSeat(i, { aiLevel: sel.value as AiLevel });
    })
  );
  const tm = document.getElementById('lb-timer') as HTMLInputElement | null;
  if (tm) tm.onchange = () => r.setTimer(tm.checked);
}

// ---------------- 界面：一局结束 ----------------
function showRoundResult() {
  const m = match;
  if (!m || !m.lastResult) return;
  const r = m.lastResult;
  const canControl = mode === 'local' || room?.isHost;
  const name = (i: number) => `<span style="color:${m.seats[i].color}">${esc(m.seats[i].name)}</span>`;
  let html = '';
  if (r.draw) {
    html = `<h2>同时落桌！</h2><p>这一局不算，重来。</p>`;
  } else if (m.isTwoPlayer) {
    const w = r.winner!;
    html = r.matchWinner
      ? `<h2>${name(w)} 获胜</h2><p>${esc(r.how)}。总比分 ${m.seats[0].wins} : ${m.seats[1].wins}</p>`
      : `<h2>${esc(r.how)}！</h2><p>${name(w)} 拿下这一局 · 比分 ${m.seats[0].wins} : ${m.seats[1].wins}</p>`;
  } else {
    const rows = [...m.seats.keys()]
      .sort((a, b) => m.seats[b].points - m.seats[a].points)
      .map((i) => `<tr><td>${name(i)}</td><td>${charById(m.seats[i].charId).name}</td><td>${m.seats[i].kos} 撞下</td><td><b>${m.seats[i].points}</b> 分</td></tr>`)
      .join('');
    const title = r.matchWinner ? `${r.matchWinner.map(name).join('、')} 获胜` : r.winner !== null ? `${name(r.winner)} 留到了最后` : '最后两块同时落桌';
    html = `<h2>${title}</h2><p class="small">名次分：第 1 名 ${m.n - 1} 分，依次递减；每撞下一人加 1 分</p><table class="rank">${rows}</table>`;
  }
  if (r.matchWinner) {
    html += canControl ? `<button class="stamp" data-act="again">再来一场</button>` : '<p>等房主决定…</p>';
    html += `<button class="stamp ghost small-btn" data-act="title">回到标题</button>`;
  } else {
    html += canControl ? `<button class="stamp" data-act="next">${r.draw ? '再来这一局' : '下一局'}</button>` : '<p>等房主开始下一局…</p>';
  }
  showOverlay(html);
}

// ---------------- 界面：设置 / 暂停 ----------------
function settingsScreen(back: 'title' | 'pause') {
  showOverlay(`
    <h2>设置</h2>
    <label class="row">弹指灵敏度 <input type="range" id="s-sens" min="0.5" max="1.8" step="0.05" value="${settings.sensitivity}"><span id="s-sens-v">${settings.sensitivity.toFixed(2)}</span></label>
    <label class="row"><input type="checkbox" id="s-timer" ${settings.timer ? 'checked' : ''}> 本地对战每次限时 ${RULES.turnSeconds} 秒</label>
    <label class="row"><input type="checkbox" id="s-f2f" ${settings.faceToFace ? 'checked' : ''}> 面对面模式（两人本地对战，平板平放）</label>
    <label class="row"><input type="checkbox" id="s-sound" ${settings.sound ? 'checked' : ''}> 音效</label>
    <label class="row"><input type="checkbox" id="s-autofs" ${settings.autoFullscreen ? 'checked' : ''}> 开始对战时自动全屏</label>
    <button class="stamp" data-act="${back === 'title' ? 'title' : 'resume'}">好了</button>`);
  const sens = $<HTMLInputElement>('s-sens');
  sens.oninput = () => {
    settings.sensitivity = parseFloat(sens.value);
    $('s-sens-v').textContent = settings.sensitivity.toFixed(2);
    saveSettings();
  };
  const bind = (id: string, key: 'timer' | 'faceToFace' | 'sound' | 'autoFullscreen') => {
    const el = $<HTMLInputElement>(id);
    el.onchange = () => {
      settings[key] = el.checked;
      saveSettings();
      updateHud();
    };
  };
  bind('s-timer', 'timer');
  bind('s-f2f', 'faceToFace');
  bind('s-sound', 'sound');
  bind('s-autofs', 'autoFullscreen');
}

function pauseMenu() {
  if (!match || $('overlay').classList.contains('show')) return;
  // 联机时不暂停对局，只打开菜单
  if (mode === 'local') paused = true;
  updateHud();
  showOverlay(`
    <h2>${mode === 'local' ? '暂停' : '菜单'}</h2>
    <button class="stamp" data-act="resume">继续</button>
    ${mode === 'local' ? '<button class="stamp" data-act="restart">重新开始</button>' : ''}
    <button class="stamp ghost" data-act="pause-settings">设置</button>
    <button class="stamp ghost" data-act="title">${mode === 'online' ? '离开房间' : '退出对局'}</button>`);
}

async function maybeAutoFullscreen() {
  if (settings.autoFullscreen && Fullscreen.isSupported() && !Fullscreen.isStandalone() && !Fullscreen.isFull()) await Fullscreen.enter();
}

function onAction(act: string, el?: HTMLElement) {
  unlockAudio();
  switch (act) {
    case 'local':
      focusSeat = 0;
      localSetup();
      break;
    case 'ls-add':
      settings.localSeats.push({ kind: 'normal', charId: CHARACTERS[settings.localSeats.length % CHARACTERS.length].id });
      focusSeat = settings.localSeats.length - 1;
      saveSettings();
      localSetup();
      break;
    case 'ls-del':
      settings.localSeats.splice(Number(el?.dataset.i), 1);
      focusSeat = 0;
      saveSettings();
      localSetup();
      break;
    case 'ls-start':
      startLocal();
      break;
    case 'online':
      onlineMenu();
      break;
    case 'on-create':
      maybeAutoFullscreen();
      openRoom(true);
      break;
    case 'on-join':
      maybeAutoFullscreen();
      openRoom(false);
      break;
    case 'lb-ai':
      room?.addAi('normal', CHARACTERS[(room.lobby.seats.length * 3) % CHARACTERS.length].id);
      break;
    case 'lb-del':
      room?.removeSeat(Number(el?.dataset.i));
      break;
    case 'lb-start':
      room?.startGame();
      break;
    case 'donate':
      donateScreen();
      break;
    case 'settings':
      settingsScreen('title');
      break;
    case 'pause-settings':
      settingsScreen('pause');
      break;
    case 'title':
      titleScreen();
      break;
    case 'next':
      if (!match) return;
      hideOverlay();
      match.nextRound();
      sendAction({ kind: 'next' });
      break;
    case 'again':
    case 'restart':
      if (!match) return;
      hideOverlay();
      paused = false;
      match.restart();
      sendAction({ kind: 'restart' });
      break;
    case 'resume':
      hideOverlay();
      paused = false;
      if (!match) titleScreen();
      updateHud();
      break;
  }
}

// ---------------- 全屏按钮 ----------------
function setupFullscreen() {
  const btn = $('btn-fs');
  const refresh = () => {
    const full = Fullscreen.isFull();
    btn.classList.toggle('is-full', full);
    btn.title = full ? '退出全屏 (F)' : '全屏 (F)';
    btn.setAttribute('aria-label', btn.title);
    if (Fullscreen.isStandalone()) btn.style.display = 'none';
  };
  btn.addEventListener('click', async () => {
    unlockAudio();
    if (!Fullscreen.isSupported()) {
      if (Fullscreen.isIOSPhone()) toast('iPhone 不支持网页全屏：点浏览器的「分享」→「添加到主屏幕」，从桌面图标打开就是全屏', 5200);
      else if (Fullscreen.isEmbedded()) toast('当前页面嵌在别的页面里，无法全屏。请在新标签页单独打开游戏', 4200);
      else toast('这个浏览器不支持网页全屏，可以试试「添加到主屏幕」', 3600);
      return;
    }
    await Fullscreen.toggle();
    refresh();
  });
  let wasFull = Fullscreen.isFull();
  Fullscreen.onChange((full) => {
    refresh();
    for (const t of [0, 120, 400, 800]) setTimeout(onResize, t);
    if (wasFull && !full && match) toast('已退出全屏 · 点右上角按钮可再次进入', 2200);
    wasFull = full;
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if ((e.key === 'f' || e.key === 'F') && !e.repeat) btn.click();
    if ((e.key === ' ' || e.key === 'q' || e.key === 'Q') && !e.repeat) $('btn-skill').click();
    if (e.key === 'Escape' && !Fullscreen.isFull()) {
      if ($('overlay').classList.contains('show')) {
        if (paused || (match && mode === 'online')) onAction('resume');
      } else pauseMenu();
    }
  });
  refresh();
}

let resizeRaf = 0;
function onResize() {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    scene.resize();
    updateHud();
  });
}

// ---------------- 启动 ----------------
let ownsBoot = false;
async function boot() {
  // CDN 与回退地址可能都加载了这份脚本，只启动一次
  if ((window as any).__xpBooted) return;
  (window as any).__xpBooted = true;
  ownsBoot = true;
  scene = new GameScene($('stage'));
  await initPhysics();
  setupInput(scene.renderer.domElement);
  setupFullscreen();
  $('btn-menu').addEventListener('click', () => {
    unlockAudio();
    pauseMenu();
  });
  $('btn-skill').addEventListener('click', () => {
    const m = match;
    if (!m || paused || m.phase !== 'aim' || controlOf(m.turn) !== 'me') return;
    const seat = m.turn;
    const sk = m.skillOf(seat);
    if (!m.armed && !m.canAfford(seat)) return toast(`能量不够：${sk.name}需要 ${sk.cost} 点`, 1500);
    if (m.toggleSkill(seat) && sk.kind === 'instant') sendAction({ kind: 'charge', seat });
  });
  $('panel').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (b && !(b as HTMLButtonElement).disabled) onAction(b.dataset.act!, b);
  });
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('visibilitychange', () => room?.onVisibility(document.visibilityState === 'hidden'));
  $('loading').remove();
  titleScreen();
  if (new URLSearchParams(location.search).get('room')) onlineMenu();
  requestAnimationFrame(frame);
}

boot();

// 调试 / 自动化测试用（只在真正启动的那份脚本上挂）
if (ownsBoot) (window as any).__xp = {
  get match() {
    return match;
  },
  get room() {
    return room;
  },
  get scene() {
    return scene;
  },
  onAction,
  settings,
  /** 测试用：快进 sec 秒 */
  advance(sec: number) {
    for (let t = 0; t < sec; t += 1 / 60) {
      match?.tick(1 / 60);
      match?.sim.erasers.forEach((e, i) => e.alive && scene.sync(i, match!.sim.snapshot(i)));
      scene.update(1 / 60, t, false);
    }
    scene.update(0, 0);
  },
};
