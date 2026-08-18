import type { TunnelStatus } from './tunnel.ts'

/** Stable status shape shared by the runtime and loopback control surface. */
export interface RuntimeStatus {
  enabled: boolean
  running: boolean
  target: string
  backend: string
  listen: { host: string, port: number }
  bound: { host: string, port: number }
  reachables: string[]
  wildcard: boolean
  approvalMode: boolean
  tls: boolean
  auditLog: boolean
  trustForwardedFor: boolean
  reason?: string
  tunnel: TunnelStatus
}
