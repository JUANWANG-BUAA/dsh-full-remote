export type ProxyStatus = {
  enabled: boolean
  running: boolean
  target: string
  backend: string
  reason?: string
}

export type ProxyApi = {
  status: () => Promise<ProxyStatus>
  start: () => Promise<ProxyStatus>
  stop: () => Promise<ProxyStatus>
  token: () => Promise<string>
  rotateToken: () => Promise<ProxyStatus & { accessToken: string }>
}
