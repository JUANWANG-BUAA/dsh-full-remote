/** Security invariants shared by every reverse-proxy runtime entry point. */
import { parseCidr } from './cidr.ts'
import { isWildcardHost, isLoopbackHost } from './hosts.ts'

export interface RuntimeSecurityConfig {
  tlsCertFile?: unknown
  tlsKeyFile?: unknown
  trustCloudflareConnectingIp?: unknown
  trustForwardedFor?: unknown
  allowedCidrs?: unknown
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
