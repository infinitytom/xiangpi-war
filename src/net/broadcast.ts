// 本机多标签页联机（BroadcastChannel），用于不注册 GoEasy 时测试联机流程
import type { NetMsg, Transport } from './transport';

export class BroadcastTransport implements Transport {
  readonly label = '本机多标签页';
  private ch: BroadcastChannel | null = null;
  private msgCbs: ((m: NetMsg) => void)[] = [];
  private memCbs: ((ids: string[]) => void)[] = [];
  private seen = new Map<string, number>();
  private hb = 0;
  private lastMembers = '';

  constructor(readonly selfId: string) {}

  async join(room: string) {
    this.ch = new BroadcastChannel('xp_room_' + room);
    this.ch.onmessage = (ev) => {
      const m = ev.data as NetMsg;
      if (!m || m.from === this.selfId) return;
      this.seen.set(m.from, Date.now());
      if (m.t === '_hb') return this.checkMembers();
      if (m.t === '_bye') {
        this.seen.delete(m.from);
        return this.checkMembers(true);
      }
      this.checkMembers();
      for (const cb of this.msgCbs) cb(m);
    };
    const beat = () => {
      this.ch?.postMessage({ t: '_hb', from: this.selfId });
      this.checkMembers();
    };
    beat();
    this.hb = window.setInterval(beat, 1000);
    window.addEventListener('pagehide', this.bye);
  }

  private bye = () => this.ch?.postMessage({ t: '_bye', from: this.selfId });

  private checkMembers(force = false) {
    const now = Date.now();
    for (const [id, t] of this.seen) if (now - t > 10000) this.seen.delete(id);
    const ids = [this.selfId, ...this.seen.keys()].sort();
    const key = ids.join(',');
    if (key !== this.lastMembers || force) {
      this.lastMembers = key;
      for (const cb of this.memCbs) cb(ids);
    }
  }

  send(msg: Record<string, unknown> & { t: string }) {
    this.ch?.postMessage({ ...msg, from: this.selfId });
  }
  onMessage(cb: (m: NetMsg) => void) {
    this.msgCbs.push(cb);
  }
  onMembers(cb: (ids: string[]) => void) {
    this.memCbs.push(cb);
  }
  leave() {
    this.bye();
    clearInterval(this.hb);
    window.removeEventListener('pagehide', this.bye);
    this.ch?.close();
    this.ch = null;
    this.msgCbs = [];
    this.memCbs = [];
  }
}
