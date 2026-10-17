/**
 * SectionIcon — 16×16 fill glyphs for the settings cards, in the same
 * language as {@link ReverseProxyIcon} and the official Harness icon set:
 * `currentColor`, even-odd fills, no strokes, no separate light/dark art.
 *
 * Each glyph names the thing its card controls rather than decorating it:
 * a globe for the published endpoint, an arrow for the tunnel target, a QR
 * finder for invites, a key for the access token, devices for the session
 * list, a check for the fence self-check, and bars for the audit log.
 */

export type SectionIconName =
  | 'publish'
  | 'tunnel'
  | 'invite'
  | 'token'
  | 'devices'
  | 'check'
  | 'audit'

const GLYPHS: Record<SectionIconName, string> = {
  // Globe: ring plus one meridian, the endpoint other devices dial.
  publish: 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Zm0 1.5a1.6 4.9 0 0 0 0 9.8 1.6 4.9 0 0 0 0-9.8ZM2.7 7.3h10.6v1.4H2.7z',
  // Arrow into a boundary: a port forward.
  tunnel: 'M9.2 2.6 14 8l-4.8 5.4V9.6H2V6.4h7.2z',
  // QR finder patterns: the scan target an invite produces.
  invite: 'M2 2h5v5H2V2Zm1.5 1.5v2h2v-2h-2ZM9 2h5v5H9V2Zm1.5 1.5v2h2v-2h-2ZM2 9h5v5H2V9Zm1.5 1.5v2h2v-2h-2ZM9 9h2v2H9zM12 9h2v2h-2zM9 12h2v2H9zM12 12h2v2h-2z',
  // Key: bow plus two cut teeth.
  token: 'M5.4 1.8a4.1 4.1 0 0 0-1 8.1l1.2 1.2 1.2-1.2 1.1 1.1-1.2 1.2 1.2 1.2 1.2-1.2 1.1 1.1.9-.9-1.1-1.1 1.2-1.2-1.2-1.2-1.2 1.2-1.1-1.1.3-.3A4.1 4.1 0 0 0 5.4 1.8Zm0 1.6a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z',
  // Monitor beside a phone: the paired-device list.
  devices: 'M1.6 3.2h8V10h-8V3.2ZM3 4.6v4h5.2v-4H3ZM10.6 6h3.8v6.8h-3.8V6Z',
  // Check inside a ring: the fence self-check result.
  check: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm2.6 3L7.2 9.4 5.6 7.8l-1.1 1.1 2.7 2.7 4.5-4.5-1.1-1.1Z',
  // Three stacked bars: the audit log rows.
  audit: 'M2 3.2h12v1.6H2zM2 7.2h12v1.6H2zM2 11.2h8.4v1.6H2z',
}

export function SectionIcon({ name, size = 13 }: { name: SectionIconName, size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={GLYPHS[name]} />
    </svg>
  )
}
