// 联机传输层接口：房间 = 一个广播频道
export interface NetMsg {
  t: string;
  from: string;
  [k: string]: any;
}

export interface Transport {
  readonly selfId: string;
  readonly label: string;
  join(room: string): Promise<void>;
  send(msg: Record<string, unknown> & { t: string }): void;
  onMessage(cb: (m: NetMsg) => void): void;
  /** 在线成员变化（含自己） */
  onMembers(cb: (ids: string[]) => void): void;
  leave(): void;
  /** 可选：底层断线重连后回调 */
  onReconnect?(cb: () => void): void;
}

/** 每个标签页一个稳定 id（刷新不变，便于断线重连） */
export function selfPeerId(): string {
  try {
    let id = sessionStorage.getItem('xp_peer');
    if (!id) {
      id = 'p' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('xp_peer', id);
    }
    return id;
  } catch {
    return 'p' + Math.random().toString(36).slice(2, 10);
  }
}
