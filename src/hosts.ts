/**
 * Host classification shared by the Node host, the proxy, and the settings
 * page. Kept free of Node builtins so the client bundle can import it.
 */

/** True for bind-all wildcards: not connectable destination hosts. */
export function isWildcardHost(host: string) {
  const value = String(host ?? '').replace(/^\[|\]$/g, '')
  return value === '' || value === '0.0.0.0' || value === '::' || value === '::0'
}

/**
 * Loopback classification aligned with harness `isLoopbackHostname`:
 * localhost, [::1], and any IPv4 in 127/8. Also accepts the IPv4-mapped
 * form Node reports on sockets (`::ffff:127.0.0.1`).
 */
export function isLoopbackHost(host: string) {
  let hostname = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  // Node reports IPv4-mapped peers as `::ffff:127.x.x.x`. Strip the prefix so
  // every 127/8 alias counts, not just `::ffff:127.0.0.1`.
  if (hostname.startsWith('::ffff:')) hostname = hostname.slice(7)
  if (hostname === 'localhost' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
