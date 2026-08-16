/**
 * qr-svg — invite-link QR via `uqr` (no canvas / CDN).
 */
import { renderSVG } from 'uqr'

/**
 * @param {string} text
 * @returns {string | null}
 */
export function qrToSvg(text: string): string | null {
  const value = String(text ?? '')
  if (value === '' || value.length > 512) return null
  try {
    return renderSVG(value, { ecc: 'M', border: 2 })
  } catch {
    return null
  }
}
