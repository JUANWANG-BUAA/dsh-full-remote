/**
 * audit — append-only JSONL security event log next to the state file.
 *
 * Failures to write never throw into the request path; they warn through
 * the supplied logger. Disabled when auditLog is empty/false.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * @param {{
 *   path?: string,
 *   enabled?: boolean,
 *   warn?: (error: Error) => void,
 * }} options
 */
export function createAuditLog(options: {
  path?: string
  enabled?: boolean
  warn?: (error: Error) => void
} = {}) {
  const enabled = options.enabled === true && typeof options.path === 'string' && options.path !== ''
  const path = options.path
  const warn = options.warn

  const write = async (event: string, fields: Record<string, unknown> = {}) => {
    if (!enabled || path === undefined) return
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    })}\n`
    try {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      warn?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return {
    enabled,
    path: enabled ? path : undefined,
    record: write,
  }
}

/** Default audit path beside the state file. */
export function defaultAuditPath(statePath: string) {
  return `${String(statePath).replace(/\.json$/i, '')}.audit.jsonl`
}
