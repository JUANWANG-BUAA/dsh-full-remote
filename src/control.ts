/**
 * Frozen control-surface identifiers (roadmap §7.1 class 2/3/4).
 *
 * Plugin id, cookie name, this prefix, the forwarding header, and the
 * polyfill marker are frozen: renaming any of them drops sessions or
 * silently disables anti-spoof stripping. Only the npm package name moves.
 *
 * The client bundle imports this module (no Node builtins).
 */
export const CONTROL_PREFIX = '/dsh-reverse-proxy'
export const CONTROL_HEADER = 'x-dsh-reverse-proxy-control'
export const CONTROL_HEADER_VALUE = '1'
