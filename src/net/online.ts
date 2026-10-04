// 联机房间：大厅（座位、角色）+ 对局中的动作转发。
// 模型：所有人用同样的输入各自模拟；房主每次结算后广播最终状态，大家以房主为准。
import { Match, type AiLevel, type SeatConfig } from '../game/match';
import type { FlickInputData } from '../game/match';
import { MAX_PLAYERS } from './netconfig';
import type { NetMsg, Transport } from './transport';
import { SEAT_NAMES } from '../core/config';

export interface LobbySeat {
  peerId: string | null; // AI 座位为 null
  name: string;
  charId: string;
  kind: 'human' | 'ai';
  aiLevel?: AiLevel;
}

export interface Lobby {
  host: string;
  seats: LobbySeat[];
  timer: boolean;
  started: boolean;
  ver: number;
}

export type Action =
  | { kind: 'flick'; seat: number; f: FlickInputData; skill: boolean }
  | { kind: 'charge'; seat: number }
  | { kind: 'brake'; seat: number }
  | { kind: 'skip' }
  | { kind: 'next' }
  | { kind: 'restart' };

export interface RoomEvents {
  lobby(l: Lobby): void;
  start(m: Match): void;
  action(a: Action): void; // 远端动作已套用到对局后通知界面
  toast(msg: string): void;
  closed(reason: string): void;
}

export class OnlineRoom {
  lobby: Lobby;
  members: string[] = [];
  match: Match | null = null;
  private helloTimer = 0;
  private watchTimer = 0;
  private joinedOk = false;
  /** 最后一次看到某人（在线列表里或收到他的消息）的时间 */
  private lastSeen = new Map<string, number>();
  static GRACE = 12000;

  constructor(
    public t: Transport,
    public code: string,
    private me: { name: string; charId: string },
    private ev: RoomEvents
  ) {
    this.lobby = { host: '', seats: [], timer: true, started: false, ver: 0 };
  }

  get selfId() {
    return this.t.selfId;
  }
  get isHost() {
    return this.lobby.host === this.selfId;
  }

  async create(timer: boolean) {
    await this.t.join(this.code);
    this.bind();
    this.lobby = { host: this.selfId, seats: [{ peerId: this.selfId, name: this.me.name, charId: this.me.charId, kind: 'human' }], timer, started: false, ver: 1 };
    this.joinedOk = true;
    this.broadcastLobby();
  }

  async join(): Promise<void> {
    await this.t.join(this.code);
    this.bind();
    return new Promise((resolve, reject) => {
      const hello = () => this.t.send({ t: 'hello', name: this.me.name, charId: this.me.charId });
      hello();
      let tries = 0;
      this.helloTimer = window.setInterval(() => {
        if (this.joinedOk) {
          clearInterval(this.helloTimer);
          resolve();
        } else if (++tries > 8) {
          clearInterval(this.helloTimer);
          reject(new Error('没有找到这个房间，或者房主不在线'));
        } else hello();
      }, 800);
    });
  }

  private bind() {
    this.t.onMessage((m) => {
      this.lastSeen.set(m.from, Date.now());
      this.handle(m);
    });
    this.t.onMembers((ids) => this.onMembers(ids));
    this.watchTimer = window.setInterval(() => this.watch(), 1000);
    this.t.onReconnect?.(() => {
      if (this.lobby.started && !this.isHost) this.resync();
    });
  }

  leave() {
    clearInterval(this.helloTimer);
    clearInterval(this.watchTimer);
    this.t.leave();
  }

  /** 宽限期内没出现在在线列表里也算在线，避免网络抖动误判 */
  isOnline(peer: string | null | undefined) {
    if (!peer) return false;
    if (peer === this.selfId || this.members.includes(peer)) return true;
    return Date.now() - (this.lastSeen.get(peer) ?? 0) < OnlineRoom.GRACE;
  }

  /** 房主掉线后的接班人：座位顺序里第一个在线的真人（除了原房主） */
  private successor(): string | null {
    const s = this.lobby.seats.find((x) => x.kind === 'human' && x.peerId && x.peerId !== this.lobby.host && this.isOnline(x.peerId));
    return s?.peerId ?? null;
  }

  private seatIndexOf(peer: string) {
    const i = this.lobby.seats.findIndex((s) => s.peerId === peer);
    return i < 0 ? 99 : i;
  }

  private hbCount = 0;
  private waitSince = 0;
  private stuckBeats = 0;
  private lastResync = 0;
  private watch() {
    if (!this.joinedOk || !this.lobby.host) return;
    if (this.isHost && ++this.hbCount % 4 === 0) this.t.send({ t: 'hosthb', ver: this.lobby.ver, turnNo: this.match?.turnNo ?? 0, phase: this.match?.phase });
    // 客户端看门狗：等房主校正太久，就主动要完整状态
    const m = this.match;
    if (m && !this.isHost) {
      const waiting = m.phase === 'waitSync';
      if (waiting && !this.waitSince) this.waitSince = Date.now();
      if (!waiting) this.waitSince = 0;
      if (waiting && Date.now() - this.waitSince > 3500) this.resync();
    }
    if (this.isOnline(this.lobby.host)) return;
    const next = this.successor();
    if (!next) return;
    const old = this.lobby.seats.find((s) => s.peerId === this.lobby.host);
    this.lobby.host = next;
    if (next === this.selfId) {
      this.ev.toast(`${old?.name ?? '房主'}掉线了，现在由你当房主`);
      if (this.match) this.match.promoteToHost();
      this.broadcastLobby();
    }
    this.ev.lobby(this.lobby);
  }

  /** 这条消息是否来自有权发号施令的人 */
  private fromAuthority(from: string) {
    if (from === this.lobby.host) return true;
    return !this.isOnline(this.lobby.host) && from === this.successor();
  }

  // ---------------- 大厅操作 ----------------
  private broadcastLobby() {
    this.lobby.ver++;
    this.t.send({ t: 'lobby', lobby: this.lobby });
    this.ev.lobby(this.lobby);
  }

  pickChar(charId: string) {
    this.me.charId = charId;
    if (this.isHost) {
      const s = this.lobby.seats.find((x) => x.peerId === this.selfId);
      if (s) s.charId = charId;
      this.broadcastLobby();
    } else this.t.send({ t: 'pick', charId });
  }

  /** 房主：加电脑 / 改电脑角色和难度 / 移除座位 */
  addAi(level: AiLevel, charId: string) {
    if (!this.isHost || this.lobby.seats.length >= MAX_PLAYERS) return;
    this.lobby.seats.push({ peerId: null, name: '电脑', charId, kind: 'ai', aiLevel: level });
    this.broadcastLobby();
  }
  editSeat(i: number, patch: Partial<LobbySeat>) {
    if (!this.isHost || !this.lobby.seats[i]) return;
    Object.assign(this.lobby.seats[i], patch);
    this.broadcastLobby();
  }
  removeSeat(i: number) {
    if (!this.isHost) return;
    const s = this.lobby.seats[i];
    if (!s || s.peerId === this.selfId) return;
    this.lobby.seats.splice(i, 1);
    if (s.peerId) this.t.send({ t: 'kicked', to: s.peerId });
    this.broadcastLobby();
  }
  setTimer(on: boolean) {
    if (!this.isHost) return;
    this.lobby.timer = on;
    this.broadcastLobby();
  }

  seatConfigs(): SeatConfig[] {
    return this.lobby.seats.map((s, i) => ({
      name: s.kind === 'ai' ? `电脑${i + 1}` : s.name || SEAT_NAMES[i],
      charId: s.charId,
      kind: s.kind === 'ai' ? 'ai' : s.peerId === this.selfId ? 'human' : 'remote',
      aiLevel: s.aiLevel,
      peerId: s.peerId ?? undefined,
    }));
  }

  startGame() {
    if (!this.isHost || this.lobby.seats.length < 2) return;
    this.lobby.started = true;
    this.broadcastLobby();
    this.t.send({ t: 'start', lobby: this.lobby });
    this.beginMatch();
  }

  private beginMatch() {
    this.match = new Match(this.seatConfigs(), { timer: this.lobby.timer, authority: this.isHost ? 'host' : 'client' });
    this.match.on((e) => {
      if (e.type === 'resolved' && this.isHost) this.t.send({ t: 'sync', turnNo: this.match!.turnNo, state: e.state });
    });
    this.ev.start(this.match);
    this.match.startRound();
  }

  // ---------------- 对局动作 ----------------
  /** 本机做了一个动作（已在本地对局里生效），转发给其他人 */
  sendAction(a: Action) {
    this.t.send({ t: 'act', turnNo: this.match?.turnNo, a });
  }

  private applyAction(a: Action) {
    const m = this.match;
    if (!m) return;
    switch (a.kind) {
      case 'flick':
        m.flick(a.seat, a.f, a.skill);
        break;
      case 'charge':
        m.toggleSkill(a.seat);
        break;
      case 'brake':
        m.brake(a.seat);
        break;
      case 'skip':
        m.skip();
        break;
      case 'next':
        m.nextRound();
        break;
      case 'restart':
        m.restart();
        break;
    }
    this.ev.action(a);
  }

  // ---------------- 收消息 ----------------
  private handle(m: NetMsg) {
    switch (m.t) {
      case 'hello': {
        if (!this.isHost) return;
        const existing = this.lobby.seats.find((s) => s.peerId === m.from);
        if (this.lobby.started) {
          this.broadcastLobby();
          if (existing && this.match) this.t.send({ t: 'resume', to: m.from, lobby: this.lobby, meta: this.match.meta() });
          return;
        }
        if (existing) {
          existing.name = m.name;
          existing.charId = m.charId;
        } else if (this.lobby.seats.length < MAX_PLAYERS) {
          this.lobby.seats.push({ peerId: m.from, name: m.name, charId: m.charId, kind: 'human' });
          this.ev.toast(`${m.name} 进入了房间`);
        } else {
          this.t.send({ t: 'full', to: m.from });
          return;
        }
        this.broadcastLobby();
        return;
      }
      case 'hosthb': {
        // 不是房主：拿房主的进度对一下，落后了或卡住了就要完整状态
        if (!this.isHost && m.from === this.lobby.host && this.match) {
          const mine = this.match.turnNo;
          const stuck = m.turnNo === mine && m.phase === 'aim' && (this.match.phase === 'resolve' || this.match.phase === 'waitSync');
          // 「卡住」要连续两次心跳都成立才算，避免自己刚出手、消息还在路上时误判
          this.stuckBeats = stuck ? this.stuckBeats + 1 : 0;
          if (m.turnNo > mine || this.stuckBeats >= 2 || (m.phase === 'roundOver' && this.match.phase === 'aim')) {
            this.stuckBeats = 0;
            this.resync();
          }
          return;
        }
        // 两个人都以为自己是房主：对局进度更新的留下（进度相同则座位靠前的留下），另一个退位并要完整状态
        if (m.from === this.lobby.host && !this.isHost) return;
        const mine = this.match?.turnNo ?? 0;
        const theirsWins = !this.isHost || m.turnNo > mine || (m.turnNo === mine && this.seatIndexOf(m.from) < this.seatIndexOf(this.selfId));
        if (!theirsWins) return;
        const wasHost = this.isHost;
        this.lobby.host = m.from;
        if (wasHost) {
          if (this.match) this.match.authority = 'client';
          this.ev.toast('以另一位房主的对局为准');
          this.resync();
        }
        this.ev.lobby(this.lobby);
        return;
      }
      case 'handoff':
        // 原房主切到后台，把房主交给指定的人
        if (m.from !== this.lobby.host) return;
        this.lobby.host = m.to;
        if (m.to === this.selfId) {
          this.ev.toast('房主暂时离开，现在由你当房主');
          this.match?.promoteToHost();
          this.broadcastLobby();
        }
        this.ev.lobby(this.lobby);
        return;
      case 'full':
        if (m.to === this.selfId && !this.joinedOk) {
          clearInterval(this.helloTimer);
          this.ev.closed('房间已满（最多 6 人）');
        }
        return;
      case 'kicked':
        if (m.to === this.selfId) {
          this.leave();
          this.ev.closed('你被房主移出了房间');
        }
        return;
      case 'lobby': {
        const l = m.lobby as Lobby;
        if (l.host !== m.from) return;
        if (this.lobby.host && !this.fromAuthority(m.from)) {
          // 两个人都以为自己是房主：座位靠前的那个留下
          if (this.isHost && this.seatIndexOf(m.from) < this.seatIndexOf(this.selfId)) {
            this.lobby.host = m.from;
          } else return;
        }
        if (l.ver < this.lobby.ver && l.host === this.lobby.host) return;
        this.lobby = l;
        if (l.seats.some((s) => s.peerId === this.selfId) || l.started) this.joinedOk = true;
        this.ev.lobby(l);
        return;
      }
      case 'pick': {
        if (!this.isHost || this.lobby.started) return;
        const s = this.lobby.seats.find((x) => x.peerId === m.from);
        if (s) {
          s.charId = m.charId;
          this.broadcastLobby();
        }
        return;
      }
      case 'start':
        if (this.lobby.host && !this.fromAuthority(m.from)) return;
        this.lobby = m.lobby;
        this.joinedOk = true;
        this.beginMatch();
        return;
      case 'resume':
        if (m.to !== this.selfId) return;
        this.lobby = m.lobby;
        this.joinedOk = true;
        if (!this.match) {
          this.match = new Match(this.seatConfigs(), { timer: this.lobby.timer, authority: 'client' });
          this.ev.start(this.match);
        }
        this.match.loadMeta(m.meta);
        return;
      case 'act': {
        const a = m.a as Action;
        if (!this.match) return;
        // 结算阶段的刹车不受回合号限制；其余动作必须对上回合号
        if (a.kind !== 'brake' && a.kind !== 'next' && a.kind !== 'restart' && m.turnNo !== this.match.turnNo) return;
        this.applyAction(a);
        return;
      }
      case 'sync':
        if (this.isHost || !this.match || !this.fromAuthority(m.from)) return;
        if (m.turnNo !== this.match.turnNo) return;
        this.match.applySync(m.state);
        return;
    }
  }

  private onMembers(ids: string[]) {
    const before = this.members;
    this.members = ids;
    const now = Date.now();
    for (const id of ids) this.lastSeen.set(id, now);
    for (const id of before) if (!ids.includes(id)) {
      const s = this.lobby.seats.find((x) => x.peerId === id);
      if (s && this.lobby.started) this.ev.toast(`${s.name} 的网络断了${this.isHost ? '，暂由电脑代打' : ''}`);
    }
    if (this.isHost && !this.lobby.started) {
      const gone = before.filter((id) => !ids.includes(id));
      const n = this.lobby.seats.length;
      this.lobby.seats = this.lobby.seats.filter((s) => !(s.peerId && gone.includes(s.peerId)));
      if (this.lobby.seats.length !== n) this.broadcastLobby();
    }
    this.ev.lobby(this.lobby);
  }

  /** 页面切到后台/回到前台。后台的页面会被浏览器暂停，房主必须先交出房主 */
  onVisibility(hidden: boolean) {
    if (!this.lobby.started) return;
    if (hidden) {
      if (!this.isHost) return;
      const next = this.successor();
      if (!next) return;
      this.t.send({ t: 'handoff', to: next });
      this.lobby.host = next;
      if (this.match) this.match.authority = 'client';
    } else if (!this.isHost) {
      this.resync();
    }
  }

  /** 向房主要一份最新的完整对局状态 */
  private resync() {
    if (Date.now() - this.lastResync < 3000) return;
    this.lastResync = Date.now();
    this.t.send({ t: 'hello', name: this.me.name, charId: this.me.charId });
  }

  /** 某个座位当前由谁操作 */
  controlOf(seat: number): 'me' | 'ai' | 'remote' {
    const s = this.lobby.seats[seat];
    if (!s) return 'remote';
    if (s.peerId === this.selfId) return 'me';
    const offline = s.kind === 'human' && !this.isOnline(s.peerId);
    if (s.kind === 'ai' || offline) return this.isHost ? 'ai' : 'remote';
    return 'remote';
  }
}
