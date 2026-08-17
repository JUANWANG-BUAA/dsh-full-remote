/**
 * Screenshot harness: mounts the real settings section against a frozen
 * demo API so docs images track the current UI without a running Harness.
 */
import { createRoot } from 'react-dom/client'
import type { ComponentProps } from 'react'
import { RemoteSection } from '../../src/client/RemoteSection.tsx'
import { translatorFor, zh } from '../../src/client/i18n.ts'
import { qrToSvg } from '../../src/qr-svg.ts'
import type { ProxyApi, ProxyStatus, SessionInfo } from '../../src/client/types.ts'

const LAST_SEEN = Date.parse('2026-08-17T11:51:40+08:00')
const INVITE_URL = 'http://192.168.3.23:3081/_dsh_reverse_proxy/login?invite=demoInviteNotASecret01'
const DEMO_TOKEN = 'demo-token-not-a-secret'

const sessions: SessionInfo[] = [
  {
    id: 'chrome',
    label: 'Chrome on macOS',
    status: 'active',
    createdAt: LAST_SEEN,
    lastSeenAt: LAST_SEEN,
    createdIp: '198.51.100.2',
    lastSeenIp: '198.51.100.2',
  },
  {
    id: 'safari',
    label: 'Safari on iOS',
    status: 'pending',
    createdAt: LAST_SEEN,
    lastSeenAt: LAST_SEEN,
    createdIp: '203.0.113.9',
    lastSeenIp: '203.0.113.9',
  },
]

const running: ProxyStatus = {
  enabled: true,
  running: true,
  target: 'http://192.168.3.23:3081',
  backend: 'http://127.0.0.1:3080',
  listen: { host: '0.0.0.0', port: 3081 },
  reachables: ['http://192.168.3.23:3081', 'http://127.0.0.1:3081'],
  wildcard: true,
  approvalMode: true,
  tls: false,
  auditLog: true,
  trustForwardedFor: false,
  tunnel: { state: 'off' },
}

const api: ProxyApi = {
  status: async () => running,
  start: async () => running,
  stop: async () => ({ ...running, enabled: false, running: false }),
  token: async () => DEMO_TOKEN,
  rotateToken: async () => ({ ...running, accessToken: DEMO_TOKEN }),
  setListen: async () => running,
  sessions: async () => sessions,
  approveSession: async () => ({ ok: true }),
  revokeSession: async () => ({ ok: true }),
  renameSession: async () => ({ ok: true }),
  selfCheck: async () => ({
    running: true,
    fence: { ok: true, method: 'settings.describe', status: 200, rewriteAuthority: '127.0.0.1:3080' },
    tls: false,
    auditLog: true,
    allowTokenRead: true,
    trustForwardedFor: false,
    trustBootstrap: true,
  }),
  invite: async () => ({
    inviteUrl: INVITE_URL,
    qrSvg: qrToSvg(INVITE_URL) ?? undefined,
  }),
  audit: async () => ({ enabled: true, events: [] }),
  exportAudit: async () => new Blob(['[]'], { type: 'application/json' }),
  startTunnel: async () => running,
  stopTunnel: async () => running,
}

const params = new URLSearchParams(location.search)
const chromeOn = params.get('chrome') !== '0'
document.body.dataset.chrome = chromeOn ? 'on' : 'off'
if (params.get('narrow') === '1') document.body.dataset.narrow = 'true'

const props = {
  api,
  t: translatorFor(zh),
  close: () => undefined,
  useSessions: () => undefined,
  useWorkspaces: () => undefined,
} as unknown as ComponentProps<typeof RemoteSection>

const panel = <RemoteSection {...props} />
const root = document.getElementById('app')
if (root === null) throw new Error('missing #app')

if (chromeOn) {
  createRoot(root).render(
    <div className="settings">
      <nav className="nav">
        <strong>设置</strong>
        <button type="button">通用设置</button>
        <button type="button">模型</button>
        <button type="button">插件</button>
        <button type="button">Agent 预设</button>
        <button type="button">视觉工具</button>
        <button type="button" data-active>反向代理</button>
      </nav>
      <div className="main">
        <div className="toolbar">
          <span>打开配置文件</span>
          <b aria-hidden="true">×</b>
        </div>
        <div className="body">{panel}</div>
      </div>
    </div>,
  )
} else {
  createRoot(root).render(panel)
}
