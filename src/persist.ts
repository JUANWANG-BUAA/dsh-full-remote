/**
 * persist — the plugin's durable state file (0600, atomic writes).
 *
 * Read side is defensive: malformed input degrades to a clean disabled
 * installation instead of crashing startup.
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
export async function readState(path: string = defaultStateFile()): Promise<PersistedState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return {
      enabled: parsed?.enabled === true,
      ...(typeof parsed?.accessToken === 'string' && parsed.accessToken.length >= 24
        ? { accessToken: parsed.accessToken }
        : {}),
      ...(typeof parsed?.listenHost === 'string'
        && parsed.listenHost.length > 0
        && parsed.listenHost.length <= 253
        && !/[\s/\\]/.test(parsed.listenHost)
        ? { listenHost: parsed.listenHost }
        : {}),
      ...(Number.isInteger(parsed?.listenPort) && parsed.listenPort >= 0 && parsed.listenPort <= 65535
        ? { listenPort: parsed.listenPort }
        : {}),
      ...(Array.isArray(parsed?.sessions) ? { sessions: parsed.sessions } : {}),
    }
  } catch {
    return { enabled: false }
  }
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
