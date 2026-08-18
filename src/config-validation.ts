/** Security invariants shared by every reverse-proxy runtime entry point. */
import { parseCidr } from './cidr.ts'
import { isWildcardHost, isLoopbackHost } from './hosts.ts'

export interface RuntimeSecurityConfig {
  tlsCertFile?: unknown
  tlsKeyFile?: unknown
  trustCloudflareConnectingIp?: unknown
  trustForwardedFor?: unknown
  allowedCidrs?: unknown
  cookieName?: unknown
  maxRequestBytes?: unknown
  upstreamTimeoutMs?: unknown
  sessionMaxAgeSeconds?: unknown
  sessionIdleSeconds?: unknown
  maxHeaderSizeBytes?: unknown
  headersTimeoutMs?: unknown
  requestTimeoutMs?: unknown
  keepAliveTimeoutMs?: unknown
  loginDelayMs?: unknown
  loginMaxAttempts?: unknown
  loginLockoutSeconds?: unknown
  upgradeMaxAttempts?: unknown
  upgradeLockoutSeconds?: unknown
  maxSessions?: unknown
}

/** Reject security-sensitive partial or malformed configuration at load time. */
export function validateRuntimeConfig(config: RuntimeSecurityConfig) {
  const certFile = typeof config.tlsCertFile === 'string' ? config.tlsCertFile : ''
  const keyFile = typeof config.tlsKeyFile === 'string' ? config.tlsKeyFile : ''
  const hasCert = certFile.trim() !== ''
  const hasKey = keyFile.trim() !== ''
  if (hasCert !== hasKey) {
    throw new Error('reverse-proxy: tlsCertFile and tlsKeyFile must be configured together.')
  }
  if (config.trustCloudflareConnectingIp === true && config.trustForwardedFor !== true) {
    throw new Error('reverse-proxy: trustCloudflareConnectingIp requires trustForwardedFor to be enabled.')
  }

  const integerBounds: Array<[keyof RuntimeSecurityConfig, number, number]> = [
    ['maxRequestBytes', 1024, 256 * 1024 * 1024],
    ['upstreamTimeoutMs', 1000, 10 * 60 * 1000],
    ['sessionMaxAgeSeconds', 60, 365 * 24 * 3600],
    ['sessionIdleSeconds', 0, 365 * 24 * 3600],
    ['maxHeaderSizeBytes', 1024, 16 * 1024 * 1024],
    ['headersTimeoutMs', 1000, 10 * 60 * 1000],
    ['requestTimeoutMs', 1000, 24 * 60 * 60 * 1000],
    ['keepAliveTimeoutMs', 1000, 10 * 60 * 1000],
    ['loginDelayMs', 0, 10_000],
    ['loginMaxAttempts', 1, 10_000],
    ['loginLockoutSeconds', 10, 24 * 60 * 60],
    ['upgradeMaxAttempts', 1, 10_000],
    ['upgradeLockoutSeconds', 10, 24 * 60 * 60],
    ['maxSessions', 1, 64],
  ]
  for (const [key, min, max] of integerBounds) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`reverse-proxy: ${String(key)} must be an integer between ${min} and ${max}.`)
    }
  }
  if (config.cookieName !== undefined) {
    const cookieName = typeof config.cookieName === 'string' ? config.cookieName : ''
    if (cookieName === '' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName)) {
      throw new Error('reverse-proxy: cookieName must be a valid RFC cookie token.')
    }
  }
  const rawCidrs = Array.isArray(config.allowedCidrs) ? config.allowedCidrs : []
  const invalidCidrs = rawCidrs.filter(entry => typeof entry !== 'string' || parseCidr(entry) === undefined)
  if (invalidCidrs.length > 0) {
    throw new Error(`reverse-proxy: allowedCidrs contains invalid CIDR entries: ${invalidCidrs.map(entry => JSON.stringify(entry)).join(', ')}`)
  }
}

/** Keep the backend SSRF boundary at every runtime entry point. */
export function validateBackendHost(backendHost: string) {
  if (isWildcardHost(backendHost)) {
    throw new Error(`reverse-proxy: backendHost "${backendHost}" is a wildcard listen address, not a backend. Use 127.0.0.1.`)
  }
  if (!isLoopbackHost(backendHost)) {
    throw new Error(`reverse-proxy: backendHost "${backendHost}" must be a loopback address (127.0.0.1 / localhost / ::1). A non-loopback backend would let authenticated remote clients reach an arbitrary TCP target.`)
  }
}
