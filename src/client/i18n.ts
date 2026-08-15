/**
 * i18n — the panel's zh/en copy tokens.
 *
 * Registered into the OPTIONAL dsh-client-locale service; without it the
 * panel uses the stable zh fallback (matching the harness fallback locale).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Client-side dictionary for the reverse-proxy panel.
 *
 * The locale service (`@deepseek-ai/dsh-client-locale`) is OPTIONAL: when the
 * host composition provides it, the dictionary is registered and every text
 * follows the active DeepSeek Harness locale; otherwise the panel falls back to the zh
 * copy that matches the harness's own fallback locale.
 */
export const NS = 'reverse-proxy'

export const zh = {
  'action.label': '反向代理',
  'action.open': '打开反向代理',
  'overlay.title': '反向代理',
  'overlay.close': '关闭',
  'status.running': '代理正在运行',
  'status.stopped': '代理尚未运行',
  'status.runningHint': '现在可以让任意 tunnel 指向下方本地端点。',
  'status.stoppedHint': '启动后会创建受令牌保护的本地入口。',
  'listen.description': '指定反向代理发布的 IP 与端口。端口填 0 表示自动选择空闲端口；修改后正在运行的代理会自动重启并生效。',
  'listen.host': 'IP / 主机',
  'listen.port': '端口',
  'listen.apply': '应用发布地址',
  'listen.warn': '绑定非回环地址会直接暴露端口，请确保防火墙与 tunnel 配置正确。',
  'tunnel.description': '将 frp、ngrok、cloudflared 或 SSH 隧道的本地目标设为：',
  'tunnel.copy': '复制',
  'tunnel.loading': '正在读取…',
  'token.description': '远程浏览器首次访问时必须输入此令牌。轮换后，现有远程会话会失效。',
  'token.reveal': '显示访问令牌',
  'token.rotate': '轮换令牌',
  busy: '处理中…',
  start: '启动代理',
  stop: '停止代理',
  'error.generic': '操作失败，请稍后重试。',
  'error.invalidListen': '请输入有效的发布地址和端口（0–65535）。',
  'error.invalidListenServer': '发布地址或端口无效。',
  'error.listenRestored': '新地址无法监听，已恢复到原来的发布地址。',
  'error.listenFailed': '更新发布地址失败：{reason}',
  'copied.target': '端点已复制。',
  'copied.token': '令牌已复制。',
  'copy.failed': '无法复制{label}。',
  'devices.title': '已连接设备',
  'devices.empty': '暂无设备。远程浏览器登录后会显示在这里。',
  'devices.approvalHint': '审批模式已开启：新设备需要在这里批准后才能访问。',
  'devices.pending': '待审批',
  'devices.active': '在线',
  'devices.kick': '踢出',
  'devices.approve': '批准',
  'devices.reject': '拒绝',
  'devices.lastSeen': '最近活动 {time}',
  'devices.kicked': '已踢出该设备。',
  'devices.approved': '已批准该设备。',
  'devices.rejected': '已拒绝该设备。',
} as const

export const en: Record<keyof typeof zh, string> = {
  'action.label': 'Reverse proxy',
  'action.open': 'Open reverse proxy panel',
  'overlay.title': 'Reverse proxy',
  'overlay.close': 'Close',
  'status.running': 'Proxy is running',
  'status.stopped': 'Proxy is not running',
  'status.runningHint': 'You can now point any tunnel at the local endpoint below.',
  'status.stoppedHint': 'Starting it creates a token-protected local entry point.',
  'listen.description': 'IP and port the reverse proxy publishes. Port 0 picks a free port; changing the address restarts a running proxy automatically.',
  'listen.host': 'IP / host',
  'listen.port': 'Port',
  'listen.apply': 'Apply listen address',
  'listen.warn': 'Binding a non-loopback address exposes the port directly; make sure your firewall and tunnel are configured correctly.',
  'tunnel.description': 'Point your frp, ngrok, cloudflared, or SSH tunnel at:',
  'tunnel.copy': 'Copy',
  'tunnel.loading': 'Reading…',
  'token.description': 'Remote browsers must enter this token on first visit. Rotating it invalidates existing remote sessions.',
  'token.reveal': 'Show access token',
  'token.rotate': 'Rotate token',
  busy: 'Working…',
  start: 'Start proxy',
  stop: 'Stop proxy',
  'error.generic': 'Operation failed, please retry.',
  'error.invalidListen': 'Enter a valid listen address and port (0–65535).',
  'error.invalidListenServer': 'Invalid listen address or port.',
  'error.listenRestored': 'The new address cannot bind; restored the previous listen address.',
  'error.listenFailed': 'Failed to update listen address: {reason}',
  'copied.target': 'Target copied.',
  'copied.token': 'Token copied.',
  'copy.failed': 'Cannot copy {label}.',
  'devices.title': 'Connected devices',
  'devices.empty': 'No devices yet. Remote browsers appear here after logging in.',
  'devices.approvalHint': 'Approval mode is on: new devices must be approved here before they can connect.',
  'devices.pending': 'Pending approval',
  'devices.active': 'Online',
  'devices.kick': 'Kick',
  'devices.approve': 'Approve',
  'devices.reject': 'Reject',
  'devices.lastSeen': 'Last seen {time}',
  'devices.kicked': 'Device kicked.',
  'devices.approved': 'Device approved.',
  'devices.rejected': 'Device rejected.',
}

export type ReverseProxyTranslate = (key: keyof typeof zh, params?: Record<string, unknown>) => string

/** Translate against one fixed dictionary (used for tests and the fallback). */
export function translatorFor(dict: Record<keyof typeof zh, string>): ReverseProxyTranslate {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
}

const fallback = translatorFor(zh)

/**
 * Register the namespace with the optional locale runtime and return a
 * translate function bound to it. Without the locale service the stable zh
 * fallback is returned.
 */
export function bindTranslate(ctx: ClientContext): { t: ReverseProxyTranslate, dispose?: () => void } {
  const locale = ctx.get('locale')
  if (locale === undefined) return { t: fallback }
  const dispose = locale.register(NS, { zh: { ...zh }, en: { ...en } })
  const bound = locale.bind(NS) as (key: string, params?: Record<string, unknown>) => string
  return { t: (key, params) => bound(key, params), dispose }
}
