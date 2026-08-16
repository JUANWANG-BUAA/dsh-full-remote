/**
 * cidr — IPv4/IPv6 CIDR allowlist matching for remote proxy clients.
 *
 * Empty list means "allow all" (auth still required). Loopback is always
 * allowed so local health checks and the host machine keep working.
 */
import { isIP } from 'node:net'
import { isLoopbackHost } from './http-util.ts'

/** One parsed CIDR allowlist rule. */
export type CidrRule =
  | { kind: 'v4', network: number, prefix: number }
  | { kind: 'v6', network: number[], prefix: number }

/** Strip IPv4-mapped IPv6 (`::ffff:a.b.c.d`) down to dotted IPv4. */
export function normalizeRemoteIp(address: string) {
  const raw = String(address ?? '').trim()
  if (raw === '') return ''
  if (raw.startsWith('::ffff:')) return raw.slice(7)
  return raw.replace(/^\[|\]$/g, '')
}

function parseIpv4(ip: string) {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  const nums = parts.map(part => Number(part))
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
  return ((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3]
}

function parseIpv6(ip: string) {
  const normalized = ip.toLowerCase()
  if (isIP(normalized) !== 6) return undefined
  // Expand :: once, then split into 8 hextets.
  let full = normalized
  if (full.includes('::')) {
    const [head, tail] = full.split('::')
    const headParts = head === '' ? [] : head.split(':')
    const tailParts = tail === '' ? [] : tail.split(':')
    const missing = 8 - headParts.length - tailParts.length
    full = [...headParts, ...Array.from({ length: missing }, () => '0'), ...tailParts].join(':')
  }
  const parts = full.split(':')
  if (parts.length !== 8) return undefined
  const words = parts.map(part => Number.parseInt(part || '0', 16))
  if (words.some(w => !Number.isInteger(w) || w < 0 || w > 0xffff)) return undefined
  return words
}

/**
 * @param {string} rule  dotted IPv4, IPv6, or CIDR (`a.b.c.d/24`, `2001:db8::/32`)
 * @returns {{ kind: 'v4'|'v6', network: number|number[], prefix: number } | undefined}
 */
export function parseCidr(rule: string): CidrRule | undefined {
  const text = String(rule ?? '').trim()
  if (text === '') return undefined
  const slash = text.indexOf('/')
  const addr = slash === -1 ? text : text.slice(0, slash)
  const prefixRaw = slash === -1 ? undefined : text.slice(slash + 1)
  const ip = normalizeRemoteIp(addr)
  const v4 = parseIpv4(ip)
  if (v4 !== undefined) {
    const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined
    const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0)
    return { kind: 'v4', network: (v4 & mask) >>> 0, prefix }
  }
  const v6 = parseIpv6(ip)
  if (v6 !== undefined) {
    const prefix = prefixRaw === undefined ? 128 : Number(prefixRaw)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return undefined
    return { kind: 'v6', network: v6, prefix }
  }
  return undefined
}

function ipv6Matches(words: number[], network: number[], prefix: number) {
  let bits = prefix
  for (let i = 0; i < 8; i += 1) {
    if (bits <= 0) return true
    const take = Math.min(16, bits)
    const mask = take === 0 ? 0 : (0xffff << (16 - take)) & 0xffff
    if ((words[i] & mask) !== (network[i] & mask)) return false
    bits -= take
  }
  return true
}

/** True when `address` matches any parsed rule, or the list is empty. */
export function ipAllowed(address: string, rules: CidrRule[]) {
  if (!Array.isArray(rules) || rules.length === 0) return true
  const ip = normalizeRemoteIp(address)
  if (ip === '') return false
  if (isLoopbackHost(ip)) return true
  const v4 = parseIpv4(ip)
  const v6 = v4 === undefined ? parseIpv6(ip) : undefined
  for (const rule of rules) {
    if (rule === undefined) continue
    if (rule.kind === 'v4' && v4 !== undefined) {
      const mask = rule.prefix === 0 ? 0 : ((0xffffffff << (32 - rule.prefix)) >>> 0)
      if (((v4 & mask) >>> 0) === rule.network) return true
    }
    if (rule.kind === 'v6' && v6 !== undefined && ipv6Matches(v6, rule.network, rule.prefix)) {
      return true
    }
  }
  return false
}

/** Parse a config string list; invalid entries are dropped. */
export function compileCidrList(entries: string[]): CidrRule[] {
  if (!Array.isArray(entries)) return []
  /** @type {NonNullable<ReturnType<typeof parseCidr>>[]} */
  const out: NonNullable<ReturnType<typeof parseCidr>>[] = []
  for (const entry of entries) {
    const parsed = parseCidr(entry)
    if (parsed !== undefined) out.push(parsed)
  }
  return out
}
