/**
 * audit — append-only JSONL security event log next to the state file.
 *
 * Failures to write never throw into the request path; they warn through
 * the supplied logger. Disabled when auditLog is empty/false.
 *
 * The log is size-capped: past `maxBytes` it rotates to `<path>.1` (one
 * generation kept, older events discarded). Writes are serialized through a
 * queue so concurrent events cannot interleave a rotation.
 */
import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Default rotation threshold for the append-only audit log. */
const DEFAULT_MAX_AUDIT_BYTES = 8 * 1024 * 1024

/**
 * @param {{
 *   path?: string,
 *   enabled?: boolean,
 *   maxBytes?: number,
 *   warn?: (error: Error) => void,
 * }} options
 */
export function createAuditLog(options: {
  path?: string
  enabled?: boolean
  maxBytes?: number
  warn?: (error: Error) => void
} = {}) {
  const enabled = options.enabled === true
    && typeof options.path === 'string'
    && options.path !== ''
  const path = options.path
  const warn = options.warn
  const maxBytes = typeof options.maxBytes === 'number' && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_AUDIT_BYTES

  let queue: Promise<void> = Promise.resolve()
  const write = (event: string, fields: Record<string, unknown> = {}) => {
    if (!enabled || path === undefined) return queue
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    })}\n`
    queue = queue.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true })
        const size = await stat(path).then(info => info.size, () => 0)
        if (size >= maxBytes) {
          // Single-generation rotation; rm first because rename(2) cannot
          // replace an existing file on Windows.
          await rm(`${path}.1`, { force: true })
          await rename(path, `${path}.1`)
        }
        await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        warn?.(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return queue
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
    // Filter first, then take the newest `limit`: slicing raw lines first
    // would hide matching events that sit just beyond the last `limit` lines.
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { event?: unknown }
        if (event !== undefined && parsed.event !== event) continue
        events.push(parsed)
      } catch {
        // Skip malformed lines; the audit log is append-only and best-effort.
      }
    }
    return events.slice(-limit)
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Read the full audit log for export.
 *
 * This is an explicit user action (download), so it is allowed to read the
 * whole file. Malformed lines are skipped and an optional event filter is
 * applied.
 */
export async function readAuditLogAll(
  path: string | undefined,
  event?: string,
): Promise<unknown[]> {
  if (path === undefined || path === '') return []
  try {
    const text = await readFile(path, 'utf8')
    const events: unknown[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
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
  }
}
