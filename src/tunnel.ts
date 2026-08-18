/**
 * tunnel — one-click Cloudflare quick tunnel in front of the proxy listener.
 *
 * The tunnel forwards to the PROXY (never the backend directly), so the token
 * gate, approval, CIDR allowlist and audit all keep applying to tunnel
 * traffic. Quick tunnels (trycloudflare) are free and anonymous; the URL is
 * random per start, so nothing here is persisted or restored across restarts.
 *
 * Binary resolution order: configured path → PATH → download cache →
 * on-demand download from the pinned GitHub release, SHA256-verified against
 * the embedded table before it is ever written to the cache. No postinstall
 * bundling (pnpm ≥10 blocks build scripts by default; a fat binary also
 * punishes every installer who never opens a tunnel).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** Pinned upstream release. Bump together with CLOUDFLARED_ASSETS hashes. */
export const CLOUDFLARED_VERSION = '2026.8.2'

export interface CloudflaredAsset {
  asset: string
  sha256: string
  tgz: boolean
}

/**
 * Release artifacts of the pinned version (hashes verified locally against
 * the published files). Windows arm64 has no upstream build — PATH discovery
 * covers machines that already have cloudflared installed.
 */
const CLOUDFLARED_ASSETS: Record<string, CloudflaredAsset> = {
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', sha256: 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4', tgz: true },
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', sha256: '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442', tgz: true },
  'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2', tgz: false },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', sha256: '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790', tgz: false },
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5', tgz: false },
}

export function assetForPlatform(platform: string, arch: string): CloudflaredAsset | undefined {
  return CLOUDFLARED_ASSETS[`${platform}-${arch}`]
}

/** Extract the trycloudflare URL from a cloudflared log line (any stream). */
export function parseTunnelUrl(text: string): string | undefined {
  const match = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com/i.exec(text)
  return match?.[0]
}

/**
 * Pull the first regular file out of a single-file .tgz (the goreleaser
 * darwin layout). GNU long-name ('L') and pax ('x') metadata entries are
 * skipped by type; the binary itself is type '0' (or the legacy '\0').
 */
export function extractTgzSingleFile(payload: Buffer): Buffer {
  const tar = gunzipSync(payload)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header[0] === 0) break
    const size = Number.parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim(), 8)
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length) {
      throw new Error('corrupt tar stream')
    }
    const type = header[156]
    offset += 512
    if (type === 0 || type === 48) {
      return Buffer.from(tar.subarray(offset, offset + size))
    }
    offset += Math.ceil(size / 512) * 512
  }
  throw new Error('no regular file in tar stream')
}

export type TunnelState = 'off' | 'starting' | 'online' | 'error'

/** Forwarding-header trust is live only after cloudflared is actually proxying. */
export function tunnelTrustsForwarding(state: TunnelState) {
  return state === 'online'
}

export interface TunnelStatus {
  state: TunnelState
  publicUrl?: string
  /** Progress stage while starting; an error token when state is 'error'. */
  detail?: string
}

export interface TunnelManager {
  status(): TunnelStatus
  start(): Promise<TunnelStatus>
  stop(): Promise<TunnelStatus>
}

export interface TunnelManagerOptions {
  /** URL the tunnel forwards to (the proxy listener); evaluated at each start. */
  target: () => string
  /** Explicit cloudflared path from config; checked first when non-empty. */
  configuredPath?: string
  /** Directory holding the downloaded binary cache. */
  cacheDir: string
  spawnFn?: typeof spawn
  fetchFn?: typeof fetch
  audit?: (event: string, fields?: Record<string, unknown>) => void
  log?: (message: string) => void
}

/** Failure whose message is a stable detail token for the panel i18n. */
class TunnelError extends Error {
  readonly token: string
  constructor(token: string) {
    super(token)
    this.token = token
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  const pathEnv = process.env.PATH ?? ''
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    for (const candidate of names) {
      const full = join(dir, candidate)
      if (await isExecutable(full)) return full
    }
  }
  return undefined
}

export function createTunnelManager(options: TunnelManagerOptions): TunnelManager {
  const spawnFn = options.spawnFn ?? spawn
  const fetchFn = options.fetchFn ?? fetch
  const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const cachedBin = join(options.cacheDir, binName)

  let state: TunnelState = 'off'
  let publicUrl: string | undefined
  let detail: string | undefined
  let child: ChildProcess | undefined
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let downloadAbort: AbortController | undefined
  /** Bumped by stop()/start(); stale async work notices and bows out. */
  let generation = 0

  const status = (): TunnelStatus => ({
    state,
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    ...(detail !== undefined ? { detail } : {}),
  })

  const fail = (token: string) => {
    state = 'error'
    detail = token
    publicUrl = undefined
    options.audit?.('tunnel.error', { detail: token })
  }

  const clearConnectTimer = () => {
    if (connectTimer !== undefined) {
      clearTimeout(connectTimer)
      connectTimer = undefined
    }
  }

  const download = async (spec: CloudflaredAsset): Promise<string> => {
    const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${spec.asset}`
    let response
    downloadAbort = new AbortController()
    try {
      response = await fetchFn(url, { redirect: 'follow', signal: downloadAbort.signal })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new TunnelError('aborted')
      throw new TunnelError('download-failed')
    }
    if (!response.ok) throw new TunnelError('download-failed')
    const payload = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(payload).digest('hex')
    if (digest !== spec.sha256) throw new TunnelError('integrity-failed')
    const binary = spec.tgz ? extractTgzSingleFile(payload) : payload
    await mkdir(options.cacheDir, { recursive: true })
    const tmp = join(options.cacheDir, `.cloudflared.download-${process.pid}`)
    // Verify-then-write: an integrity failure never leaves a cached binary.
    await writeFile(tmp, binary)
    await chmod(tmp, 0o755)
    await rename(tmp, cachedBin)
    return cachedBin
  }

  const resolveBinary = async (setStage: (stage: string) => void): Promise<string> => {
    const configured = options.configuredPath ?? ''
    if (configured !== '') {
      if (await isExecutable(configured)) return configured
      throw new TunnelError('configured-path-invalid')
    }
    const onPath = await findOnPath('cloudflared')
    if (onPath !== undefined) return onPath
    if (await isExecutable(cachedBin)) return cachedBin
    const spec = assetForPlatform(process.platform, process.arch)
    if (spec === undefined) throw new TunnelError('unsupported-platform')
    setStage('downloading')
    return download(spec)
  }

  const spawnTunnel = (gen: number, bin: string) => {
    let spawned: ChildProcess
    try {
      spawned = spawnFn(bin, ['tunnel', '--url', options.target(), '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      fail('spawn-failed')
      return
    }
    child = spawned
    const onData = (chunk: Buffer) => {
      if (gen !== generation || state !== 'starting') return
      const url = parseTunnelUrl(chunk.toString('utf8'))
      if (url === undefined) return
      clearConnectTimer()
      state = 'online'
      publicUrl = url
      detail = undefined
      options.audit?.('tunnel.start', { publicUrl: url })
      options.log?.(`reverse-proxy: cloudflared tunnel online at ${url}`)
    }
    spawned.stdout?.on('data', onData)
    spawned.stderr?.on('data', onData)
    spawned.once('error', () => {
      if (child !== spawned) return
      child = undefined
      clearConnectTimer()
      if (gen === generation && state === 'starting') fail('spawn-failed')
    })
    spawned.once('exit', () => {
      if (child !== spawned) return
      child = undefined
      clearConnectTimer()
      if (gen !== generation) return
      if (state === 'starting') fail('connect-failed')
      else if (state === 'online') fail('exited')
    })
    connectTimer = setTimeout(() => {
      connectTimer = undefined
      if (gen !== generation || state !== 'starting') return
      fail('connect-timeout')
      if (child === spawned) {
        child = undefined
        spawned.kill()
      }
    }, 45_000)
    connectTimer.unref?.()
  }

  const run = async (gen: number) => {
    let bin: string
    try {
      bin = await resolveBinary((stage) => {
        if (gen === generation && state === 'starting') detail = stage
      })
    } catch (error) {
      if (gen !== generation) return
      fail(error instanceof TunnelError && error.token !== 'aborted' ? error.token : 'download-failed')
      return
    }
    if (gen !== generation || state !== 'starting') return
    detail = 'connecting'
    spawnTunnel(gen, bin)
  }

  return {
    status,
    start() {
      if (state === 'starting' || state === 'online') return Promise.resolve(status())
      const gen = ++generation
      state = 'starting'
      detail = 'resolving'
      publicUrl = undefined
      void run(gen)
      return Promise.resolve(status())
    },
    async stop() {
      const wasActive = state === 'starting' || state === 'online'
      generation += 1
      clearConnectTimer()
      downloadAbort?.abort()
      downloadAbort = undefined
      const current = child
      child = undefined
      if (current !== undefined) {
        const exited = new Promise<void>(resolve => current.once('exit', () => resolve()))
        current.kill()
        const grace = new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 3_000)
          timer.unref?.()
        })
        await Promise.race([exited, grace])
        if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL')
      }
      state = 'off'
      publicUrl = undefined
      detail = undefined
      if (wasActive) options.audit?.('tunnel.stop')
      return status()
    },
  }
}
