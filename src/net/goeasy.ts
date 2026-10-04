// GoEasy 云 WebSocket（国内服务）。房间 = 一个频道，开启在线状态（presence）获取成员。
import GoEasy from 'goeasy';
import type { NetMsg, Transport } from './transport';
import { GOEASY } from './netconfig';

let instance: any = null;
let connected: Promise<void> | null = null;

function connect(selfId: string): Promise<void> {
  if (connected) return connected;
  connected = new Promise((resolve, reject) => {
    instance = (GoEasy as any).getInstance({ host: GOEASY.host, appkey: GOEASY.appkey, modules: ['pubsub'] });
    const api = instance?.connect ? instance : GoEasy;
    api.connect({
      id: selfId,
      data: {},
      onSuccess: () => resolve(),
      onFailed: (e: any) => {
        connected = null;
        reject(new Error(`连接 GoEasy 失败：${e?.content ?? e?.code ?? '未知错误'}`));
      },
    });
  });
  return connected;
}

const pubsub = () => instance?.pubsub ?? (GoEasy as any).pubsub;

export class GoEasyTransport implements Transport {
  readonly label = 'GoEasy';
  private channel = '';
  private msgCbs: ((m: NetMsg) => void)[] = [];
  private memCbs: ((ids: string[]) => void)[] = [];

  constructor(readonly selfId: string) {}

  async join(room: string) {
    await connect(this.selfId);
    this.channel = 'xp_room_' + room;
    await new Promise<void>((resolve, reject) => {
      pubsub().subscribe({
        channel: this.channel,
        presence: { enable: true },
        onMessage: (msg: any) => {
          let m: NetMsg;
          try {
            m = JSON.parse(msg.content);
          } catch {
            return;
          }
          if (m.from === this.selfId) return;
          for (const cb of this.msgCbs) cb(m);
        },
        onSuccess: () => resolve(),
        onFailed: (e: any) => reject(new Error(`进入房间失败：${e?.content ?? e?.code}`)),
      });
    });
    const emit = (members: any[]) => {
      const ids = Array.from(new Set([this.selfId, ...members.map((m) => m.id)])).sort();
      for (const cb of this.memCbs) cb(ids);
    };
    pubsub().subscribePresence({
      channel: this.channel,
      membersLimit: 20,
      onPresence: (ev: any) => emit(ev.members ?? []),
      onSuccess: () => {},
      onFailed: () => {},
    });
    pubsub().hereNow({
      channel: this.channel,
      limit: 20,
      onSuccess: (r: any) => emit(r?.content?.members ?? []),
      onFailed: () => {},
    });
  }

  send(msg: Record<string, unknown> & { t: string }) {
    if (!this.channel) return;
    pubsub().publish({
      channel: this.channel,
      message: JSON.stringify({ ...msg, from: this.selfId }),
      onSuccess: () => {},
      onFailed: (e: any) => console.warn('发送失败', e),
    });
  }
  onMessage(cb: (m: NetMsg) => void) {
    this.msgCbs.push(cb);
  }
  onMembers(cb: (ids: string[]) => void) {
    this.memCbs.push(cb);
  }
  leave() {
    if (this.channel) {
      try {
        pubsub().unsubscribe({ channel: this.channel, onSuccess: () => {}, onFailed: () => {} });
        pubsub().unsubscribePresence?.({ channel: this.channel, onSuccess: () => {}, onFailed: () => {} });
      } catch {}
    }
    this.channel = '';
    this.msgCbs = [];
    this.memCbs = [];
  }
}
