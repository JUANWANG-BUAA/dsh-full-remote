/**
 * i18n — the settings page's zh/en copy tokens.
 *
 * Registered into the OPTIONAL dsh-client-locale service; without it the
 * page uses the stable zh fallback (matching the harness fallback locale).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Client-side dictionary for the reverse-proxy settings section.
 *
 * The locale service (`@deepseek-ai/dsh-client-locale`) is OPTIONAL: when the
 * host composition provides it, the dictionary is registered and every text
 * follows the active DeepSeek Harness locale; otherwise the page falls back
 * to the zh copy that matches the harness's own fallback locale.
 */
export const NS = 'reverse-proxy'

export const zh = {
  'action.label': '反向代理',
  'section.title': '反向代理',
  'section.intro': '发布一个受令牌保护的本地入口，把任意隧道指到下方地址即可远程使用 DeepSeek Harness。',
  'status.running': '代理正在运行',
  'status.stopped': '代理尚未运行',
  'status.runningHint': '现在可以让任意 tunnel 指向下方本地端点。',
  'status.stoppedHint': '启动后会创建受令牌保护的本地入口。',
  'listen.label': '发布地址',
  'listen.description': '指定反向代理发布的 IP 与端口。端口填 0 表示自动选择空闲端口；修改后正在运行的代理会自动重启并生效。',
  'listen.host': 'IP / 主机',
  'listen.port': '端口',
  'listen.apply': '应用发布地址',
  'listen.warn': '绑定非回环地址会直接暴露端口，请确保防火墙与 tunnel 配置正确。',
  'listen.wildcard': '0.0.0.0 / :: 会绑定所有网卡，但不是可连接的地址。手机同 WiFi 直连请填具体局域网 IP；下方复制的是一条可达地址。',
  'tunnel.label': '隧道目标',
  'tunnel.description': '将 frp、ngrok、cloudflared 或 SSH 隧道的本地目标设为：',
  'tunnel.bound': '当前绑定 {bind}（通配地址，不可直接连接）',
  'tunnel.copy': '复制',
  'tunnel.loading': '正在读取…',
  'token.label': '访问令牌',
  'token.description': '远程浏览器首次访问时必须输入此令牌。轮换后，现有远程会话会失效。',
  'token.reveal': '显示访问令牌',
  'token.rotate': '轮换令牌',
  busy: '处理中…',
  start: '启动代理',
  stop: '停止代理',
  'error.generic': '操作失败，请稍后重试。',
  'error.invalidListen': '请输入有效的发布地址和端口（0–65535）。',
  'error.invalidListenServer': '发布地址或端口无效。请检查 IP/主机和端口（0–65535）后再点「应用发布地址」。',
  'error.listenRestored': '新地址无法监听（端口可能被占用），已恢复到 {bind}。请换一个空闲端口后再点「应用发布地址」。',
  'error.listenFailed': '无法在 {bind} 上监听，这个端口很可能已被占用。请改成空闲端口（例如 3081）后再点「应用发布地址」。也可以先关掉占用该端口的程序。',
  'error.startListenFailed': '无法在 {bind} 上启动代理，这个端口很可能已被占用。请改成空闲端口（例如 127.0.0.1:3081），点「应用发布地址」，再点「启动代理」。也可以先关掉占用该端口的程序。',
  'error.startSelfLoop': '发布地址 {bind} 会和 Harness 后端 {backend} 撞在一起，启动会形成死循环。请把端口改成不同的值（默认 3081），点「应用发布地址」后再启动。',
  'error.startDisposed': '插件正在关闭或已卸载，无法启动。请刷新页面，或重启 DeepSeek Harness 后再试。',
  'error.startUnknown': '代理没有启动成功，但没有返回具体原因。请确认发布地址可用，或查看 Harness 日志。',
  'error.unknownReason': '操作未完成（{reason}）。请检查发布地址，或查看 Harness 日志。',
  'error.forbidden': '控制请求被拒绝。请用本机浏览器打开 127.0.0.1 上的 Harness 来操作此面板，不要从隧道或公网域名启动/停止代理。',
  'error.loopbackRequired': '只能从本机操作控制面板。请回到这台电脑上的 Harness 窗口再试。',
  'error.network': '无法联系控制接口：{detail}。请确认 Harness 仍在运行，并用本机浏览器打开面板。',
  'toast.error': '无法完成',
  'toast.warn': '请注意',
  'toast.success': '已完成',
  'toast.dismiss': '关闭提示',
  'toast.started': '代理已启动。把隧道的本地目标设为下方复制的地址。',
  'toast.stopped': '代理已停止。',
  'toast.listenApplied': '发布地址已更新。',
  'toast.tokenRotated': '访问令牌已轮换，现有远程会话已失效。',
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
  'section.title': 'Reverse proxy',
  'section.intro': 'Publish a token-gated local entry point. Point any tunnel at the address below to use DeepSeek Harness remotely.',
  'status.running': 'Proxy is running',
  'status.stopped': 'Proxy is not running',
  'status.runningHint': 'You can now point any tunnel at the local endpoint below.',
  'status.stoppedHint': 'Starting it creates a token-protected local entry point.',
  'listen.label': 'Listen address',
  'listen.description': 'IP and port the reverse proxy publishes. Port 0 picks a free port; changing the address restarts a running proxy automatically.',
  'listen.host': 'IP / host',
  'listen.port': 'Port',
  'listen.apply': 'Apply listen address',
  'listen.warn': 'Binding a non-loopback address exposes the port directly; make sure your firewall and tunnel are configured correctly.',
  'listen.wildcard': '0.0.0.0 / :: bind every interface but are not connectable destinations. For phone-on-WiFi, fill a concrete LAN IP. The copyable target below is a reachable address.',
  'tunnel.label': 'Tunnel target',
  'tunnel.description': 'Point your frp, ngrok, cloudflared, or SSH tunnel at:',
  'tunnel.bound': 'Currently bound to {bind} (wildcard; not directly connectable)',
  'tunnel.copy': 'Copy',
  'tunnel.loading': 'Reading…',
  'token.label': 'Access token',
  'token.description': 'Remote browsers must enter this token on first visit. Rotating it invalidates existing remote sessions.',
  'token.reveal': 'Show access token',
  'token.rotate': 'Rotate token',
  busy: 'Working…',
  start: 'Start proxy',
  stop: 'Stop proxy',
  'error.generic': 'Operation failed, please retry.',
  'error.invalidListen': 'Enter a valid listen address and port (0–65535).',
  'error.invalidListenServer': 'Invalid listen address or port. Check the IP/host and port (0–65535), then press Apply listen address.',
  'error.listenRestored': 'The new address cannot bind (the port is likely in use). Restored {bind}. Pick a free port and apply again.',
  'error.listenFailed': 'Cannot listen on {bind}; that port is likely in use. Change to a free port (for example 3081) and apply again, or stop the program holding the port.',
  'error.startListenFailed': 'Cannot start the proxy on {bind}; that port is likely in use. Change to a free port (for example 127.0.0.1:3081), press Apply listen address, then Start proxy. Or stop the program holding the port.',
  'error.startSelfLoop': 'Listen address {bind} collides with the Harness backend {backend} and would loop onto itself. Change the port (default 3081), apply it, then start.',
  'error.startDisposed': 'The plugin is shutting down or was unloaded, so it cannot start. Refresh the page or restart DeepSeek Harness.',
  'error.startUnknown': 'The proxy did not start and no reason was returned. Check that the listen address is free, or read the Harness log.',
  'error.unknownReason': 'The operation did not finish ({reason}). Check the listen address, or read the Harness log.',
  'error.forbidden': 'The control request was rejected. Operate this panel from the Harness window on 127.0.0.1 — not from a tunnel or public hostname.',
  'error.loopbackRequired': 'The control panel can only be used from this computer. Switch back to the local Harness window.',
  'error.network': 'Cannot reach the control API: {detail}. Confirm Harness is still running and open the panel in the local browser.',
  'toast.error': 'Could not complete',
  'toast.warn': 'Heads up',
  'toast.success': 'Done',
  'toast.dismiss': 'Dismiss',
  'toast.started': 'Proxy is running. Point your tunnel’s local target at the address below.',
  'toast.stopped': 'Proxy stopped.',
  'toast.listenApplied': 'Listen address updated.',
  'toast.tokenRotated': 'Access token rotated. Existing remote sessions are now invalid.',
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
