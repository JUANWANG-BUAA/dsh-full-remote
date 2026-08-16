/**
 * types — the control-surface data contracts shared by the API client and
 * the panel components.
 */
export type ProxyStatus = {
  enabled: boolean
  running: boolean
  target: string
  backend: string
  listen?: { host: string, port: number }
  bound?: { host: string, port: number }
  reachables?: string[]
  wildcard?: boolean
  approvalMode?: boolean
  tls?: boolean
  auditLog?: boolean
  reason?: string
}

export type SessionStatus = 'active' | 'pending'

export type SessionInfo = {
  id: string
  label: string
  status: SessionStatus
  createdAt: number
  lastSeenAt: number
}

export type FenceCheck = {
  ok: boolean
  method: string
  status: number
  rewriteAuthority: string
  detail?: string
}

export type SelfCheckResult = {
  running: boolean
  fence: FenceCheck
  tls: boolean
  auditLog: boolean
  allowTokenRead: boolean
  /** Filled on the client from `window.__DSH_FULL_REMOTE_TRUSTED__`. */
  trustBootstrap?: boolean
  bootstrapFailed?: boolean
}

export type InviteResult = {
  inviteUrl: string
  qrSvg?: string
}

export type ProxyApi = {
  status: () => Promise<ProxyStatus>
  start: () => Promise<ProxyStatus>
  stop: () => Promise<ProxyStatus>
  token: () => Promise<string>
  rotateToken: () => Promise<ProxyStatus & { accessToken: string }>
  setListen: (host: string, port: number) => Promise<ProxyStatus>
  sessions: () => Promise<SessionInfo[]>
  approveSession: (id: string) => Promise<{ ok: boolean }>
  revokeSession: (id: string) => Promise<{ ok: boolean }>
  renameSession: (id: string, label: string) => Promise<{ ok: boolean }>
  selfCheck: () => Promise<SelfCheckResult>
  invite: (publicBase?: string) => Promise<InviteResult>
}
