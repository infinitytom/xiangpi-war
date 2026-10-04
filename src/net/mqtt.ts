// 免费公共 MQTT 服务器（EMQX，国内节点在腾讯云上海），不需要注册。
// 房间 = 一个主题；在线成员靠每秒一次的心跳判断。
import mqtt, { type MqttClient } from 'mqtt';
import type { NetMsg, Transport } from './transport';
import { MQTT } from './netconfig';

export class MqttTransport implements Transport {
  readonly label = '免费公共服务器（EMQX）';
  private client: MqttClient | null = null;
  private topic = '';
  private msgCbs: ((m: NetMsg) => void)[] = [];
  private memCbs: ((ids: string[]) => void)[] = [];
  private seen = new Map<string, number>();
  private hb = 0;
  private lastMembers = '';

  constructor(readonly selfId: string) {}

  async join(room: string) {
    this.topic = `${MQTT.topicPrefix}/${room}`;
    const tryConnect = (url: string) =>
      new Promise<MqttClient>((resolve, reject) => {
        const c = mqtt.connect(url, {
          clientId: `xp_${this.selfId}_${Math.random().toString(36).slice(2, 6)}`,
          clean: true,
          connectTimeout: 6000,
          reconnectPeriod: 2000,
          keepalive: 30,
          will: { topic: this.topic, payload: JSON.stringify({ t: '_bye', from: this.selfId }), qos: 0, retain: false },
        });
        const fail = (e: unknown) => {
          c.end(true);
          reject(e);
        };
        const timer = setTimeout(() => fail(new Error('连接超时')), 8000);
        c.once('connect', () => {
          clearTimeout(timer);
          resolve(c);
        });
        c.once('error', (e) => {
          clearTimeout(timer);
          fail(e);
        });
      });
    let lastErr: unknown = null;
    for (const url of MQTT.urls) {
      try {
        this.client = await tryConnect(url);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!this.client) throw new Error(`连不上联机服务器：${(lastErr as Error)?.message ?? '网络错误'}`);
    const c = this.client;
    await new Promise<void>((resolve, reject) => c.subscribe(this.topic, { qos: 0 }, (err) => (err ? reject(err) : resolve())));
    c.on('message', (_t, payload) => {
      let m: NetMsg;
      try {
        m = JSON.parse(payload.toString());
      } catch {
        return;
      }
      if (!m || m.from === this.selfId) return;
      this.seen.set(m.from, Date.now());
      if (m.t === '_hb') return this.checkMembers();
      if (m.t === '_bye') {
        this.seen.delete(m.from);
        return this.checkMembers(true);
      }
      this.checkMembers();
      for (const cb of this.msgCbs) cb(m);
    });
    // 断线重连后重新订阅
    c.on('connect', () => c.subscribe(this.topic, { qos: 0 }));
    const beat = () => {
      this.publish({ t: '_hb' });
      this.checkMembers();
    };
    beat();
    this.hb = window.setInterval(beat, 1500);
    window.addEventListener('pagehide', this.bye);
  }

  private bye = () => this.publish({ t: '_bye' });

  private publish(msg: Record<string, unknown>) {
    if (!this.client || !this.topic) return;
    this.client.publish(this.topic, JSON.stringify({ ...msg, from: this.selfId }), { qos: 0 });
  }

  private checkMembers(force = false) {
    const now = Date.now();
    for (const [id, t] of this.seen) if (now - t > 7000) this.seen.delete(id);
    const ids = [this.selfId, ...this.seen.keys()].sort();
    const key = ids.join(',');
    if (key !== this.lastMembers || force) {
      this.lastMembers = key;
      for (const cb of this.memCbs) cb(ids);
    }
  }

  send(msg: Record<string, unknown> & { t: string }) {
    this.publish(msg);
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
    this.client?.end(false);
    this.client = null;
    this.msgCbs = [];
    this.memCbs = [];
  }
}
