// 全屏管理：兼容标准 API 与 webkit 前缀（iPad Safari），
// 进入后尝试锁定横屏；状态变化时通知界面并重新适配画面尺寸。

type Listener = (isFull: boolean) => void;

const doc = document as Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

export const Fullscreen = {
  /** 已经以「添加到主屏幕」的独立窗口方式运行（本身就是全屏） */
  isStandalone(): boolean {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: fullscreen)').matches ||
      (navigator as any).standalone === true
    );
  },

  isSupported(): boolean {
    return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
  },

  isEmbedded(): boolean {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  },

  isFull(): boolean {
    return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  },

  /** iPhone 这类完全不支持网页全屏的设备 */
  isIOSPhone(): boolean {
    return /iPhone|iPod/.test(navigator.userAgent);
  },

  async enter(el: HTMLElement = document.documentElement): Promise<boolean> {
    if (this.isFull()) return true;
    const anyEl = el as HTMLElement & { webkitRequestFullscreen?: (opt?: unknown) => Promise<void> | void };
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (anyEl.webkitRequestFullscreen) await anyEl.webkitRequestFullscreen();
      else return false;
    } catch {
      return false;
    }
    // 安卓 Chrome 支持全屏后锁横屏；其他浏览器静默失败即可
    try {
      await (screen.orientation as any)?.lock?.('landscape');
    } catch {}
    return this.isFull();
  },

  async exit(): Promise<void> {
    if (!this.isFull()) return;
    try {
      (screen.orientation as any)?.unlock?.();
    } catch {}
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else await doc.webkitExitFullscreen?.();
    } catch {}
  },

  async toggle(): Promise<boolean> {
    if (this.isFull()) {
      await this.exit();
      return false;
    }
    return this.enter();
  },

  onChange(fn: Listener) {
    const h = () => fn(this.isFull());
    document.addEventListener('fullscreenchange', h);
    document.addEventListener('webkitfullscreenchange', h);
  },
};

/** 屏幕常亮：对局中防止平板自动熄屏 */
let wakeLock: any = null;
export async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await (navigator as any).wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock === null && (window as any).__wantAwake) keepAwake(true);
});
