/**
 * audit — append-only JSONL security event log next to the state file.
 *
 * Failures to write never throw into the request path; they warn through
 * the supplied logger. Disabled when auditLog is empty/false.
 */
import { appendFile, mkdir, open } from 'node:fs/promises'
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
  const enabled = options.enabled === true
    && typeof options.path === 'string'
    && options.path !== ''
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

const TAIL_READ_BYTES = 64 * 1024

/**
 * Read the most recent audit events from a JSONL audit file.
 *
 * Only the tail of the file is read, so a large append-only audit log does
 * not have to be loaded fully into memory. Malformed lines are skipped so a
 * partially written line never breaks the control panel. A missing/unreadable
 * file is treated as an empty log.
 */
export async function readAuditLog(
  path: string | undefined,
  limit = 50,
  event?: string,
): Promise<unknown[]> {
  if (path === undefined || path === '') return []
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    if (size === 0) return []
    const readSize = Math.min(size, TAIL_READ_BYTES)
    const buffer = Buffer.alloc(readSize)
    await handle.read(buffer, 0, readSize, size - readSize)
    let text = buffer.toString('utf8')
    // When the file is larger than the tail window, the first line in the
    // chunk is usually partial; drop it before parsing.
    if (size > readSize) {
      const firstNewline = text.indexOf('\n')
      if (firstNewline === -1) return []
      text = text.slice(firstNewline + 1)
    }
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const events: unknown[] = []
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line) as { event?: unknown }
        if (event !== undefined && parsed.event !== event) continue
        events.push(parsed)
      } catch {
        // Skip malformed lines; the audit log is append-only and best-effort.
      }
    }
    return events
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => {})
  }
}
