/**
 * persist — the plugin's durable state file (0600, atomic writes).
 *
 * Read side is defensive: malformed input can be surfaced to the runtime
 * without being mistaken for a first install and overwritten.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Durable plugin state, as read from and written to the state file. */
export interface PersistedState {
  enabled: boolean
  accessToken?: string
  listenHost?: string
  listenPort?: number
  sessions?: unknown[]
}

export type StateReadStatus = 'missing' | 'valid' | 'malformed' | 'unreadable'

export interface StateReadResult {
  state: PersistedState
  status: StateReadStatus
  error?: unknown
}

/** Default durable state location. */
export function defaultStateFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'reverse-proxy.json')
}

/**
 * Missing or malformed state is treated as a clean disabled installation.
 * Runtime listen overrides are kept only when they are well-formed, so a
 * hand-edited state file can never crash the proxy at startup.
 * @param {string} path
 * @returns {Promise<{
 *   enabled: boolean,
 *   accessToken?: string,
 *   listenHost?: string,
 *   listenPort?: number,
 *   sessions?: unknown[],
 * }>}
 */
function normalizeState(parsed: unknown): PersistedState {
  const value = parsed as {
    enabled?: unknown
    accessToken?: unknown
    listenHost?: unknown
    listenPort?: unknown
    sessions?: unknown
  } | null
  const listenHost = value?.listenHost
  const listenPort = value?.listenPort
  return {
    enabled: value?.enabled === true,
    ...(typeof value?.accessToken === 'string' && value.accessToken.length >= 24
      ? { accessToken: value.accessToken }
      : {}),
    ...(typeof listenHost === 'string'
      && listenHost.length > 0
      && listenHost.length <= 253
      && !/[\s/\\]/.test(listenHost)
      ? { listenHost }
      : {}),
    ...(typeof listenPort === 'number' && Number.isInteger(listenPort) && listenPort >= 0 && listenPort <= 65535
      ? { listenPort }
      : {}),
    ...(Array.isArray(value?.sessions) ? { sessions: value.sessions } : {}),
  }
}

/** Read state while preserving whether it was absent, valid, malformed, or unreadable. */
export async function readStateDetailed(path: string = defaultStateFile()): Promise<StateReadResult> {
  try {
    const raw = await readFile(path, 'utf8')
    try {
      return { state: normalizeState(JSON.parse(raw)), status: 'valid' }
    } catch (error) {
      return { state: { enabled: false }, status: 'malformed', error }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: { enabled: false }, status: 'missing' }
    }
    return { state: { enabled: false }, status: 'unreadable', error }
  }
}

/** Backwards-compatible tolerant reader for callers that only need the state value. */
export async function readState(path: string = defaultStateFile()): Promise<PersistedState> {
  return (await readStateDetailed(path)).state
}

/**
 * Write atomically so a terminated process cannot leave truncated JSON.
 * @param {string} path
 * @param {{
 *   enabled: boolean,
 *   accessToken: string,
 *   listenHost?: string,
 *   listenPort?: number,
 *   sessions?: unknown[],
 * }} state
 * @returns {Promise<void>}
 */
export async function writeState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}
