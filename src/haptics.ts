// 震动反馈（安卓 Chrome 等支持 Vibration API 的设备；iPad / iPhone 的 Safari 不支持，会静默忽略）
export const haptics = {
  enabled: true,
  get supported() {
    return typeof navigator !== 'undefined' && 'vibrate' in navigator;
  },
  buzz(ms: number | number[]) {
    if (!this.enabled || !this.supported) return;
    try {
      navigator.vibrate(ms);
    } catch {}
  },
};
