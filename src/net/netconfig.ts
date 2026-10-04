// 联机配置
// 默认使用 EMQX 的免费公共 MQTT 服务器（不需要注册）。国内节点与海外节点数据不互通，
// 所以所有玩家都会先连国内节点，连不上才换海外节点。
export const MQTT = {
  urls: ['wss://broker-cn.emqx.io:8084/mqtt', 'wss://broker.emqx.io:8084/mqtt'],
  topicPrefix: 'xiangpi-war-7f3a/v1/room',
};

// 可选：GoEasy（需要注册）。填了 appkey 就优先用 GoEasy。
export const GOEASY = {
  appkey: '',
  host: 'hangzhou.goeasy.io',
};

export const MAX_PLAYERS = 6;
