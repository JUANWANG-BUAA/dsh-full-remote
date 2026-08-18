import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { ChildProcess } from 'node:child_process'
import {
  CLOUDFLARED_VERSION,
  assetForPlatform,
  createTunnelManager,
  extractTgzSingleFile,
  parseTunnelUrl,
  tunnelTrustsForwarding,
  type TunnelManager,
  type TunnelStatus,
} from '../src/tunnel.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function until(fn: () => boolean, ms = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tunnel-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('asset matrix', () => {
  it('maps the five platforms with official builds to release assets', () => {
    assert.equal(assetForPlatform('darwin', 'x64')?.asset, 'cloudflared-darwin-amd64.tgz')
    assert.equal(assetForPlatform('darwin', 'x64')?.tgz, true)
    assert.equal(assetForPlatform('darwin', 'arm64')?.asset, 'cloudflared-darwin-arm64.tgz')
    assert.equal(assetForPlatform('linux', 'x64')?.asset, 'cloudflared-linux-amd64')
    assert.equal(assetForPlatform('linux', 'x64')?.tgz, false)
    assert.equal(assetForPlatform('linux', 'arm64')?.asset, 'cloudflared-linux-arm64')
    assert.equal(assetForPlatform('win32', 'x64')?.asset, 'cloudflared-windows-amd64.exe')
  })

  it('has no asset for platforms without an official build (Windows arm64)', () => {
    assert.equal(assetForPlatform('win32', 'arm64'), undefined)
    assert.equal(assetForPlatform('linux', 'ia32'), undefined)
  })

  it('pins a real version string with embedded hashes filled in', () => {
    assert.match(CLOUDFLARED_VERSION, /^\d{4}\.\d+\.\d+$/)
    for (const key of ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
      const spec = assetForPlatform(...key.split('-') as [string, string])
      assert.ok(spec, `missing asset spec for ${key}`)
      assert.match(spec!.sha256, /^[0-9a-f]{64}$/, `${key} hash must be a real sha256, got ${spec!.sha256}`)
    }
  })
})

describe('parseTunnelUrl', () => {
  it('extracts the trycloudflare URL from noisy log lines', () => {
    assert.equal(
      parseTunnelUrl('2026-08-17T12:00:00Z INF Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): https://abc123-example.trycloudflare.com'),
      'https://abc123-example.trycloudflare.com',
    )
    assert.equal(parseTunnelUrl('https://xyz.trycloudflare.com\n'), 'https://xyz.trycloudflare.com')
  })

  it('ignores unrelated URLs and returns undefined for plain text', () => {
    assert.equal(parseTunnelUrl('INF Registered tunnel connection connIndex=0'), undefined)
    assert.equal(parseTunnelUrl('Visit https://example.com/hello'), undefined)
    assert.equal(parseTunnelUrl(''), undefined)
  })
})

describe('extractTgzSingleFile', () => {
  function tarEntry(name: string, content: Buffer, type = 48): Buffer {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header[156] = type
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8')
    const padding = content.length % 512 === 0 ? 0 : 512 - (content.length % 512)
    return Buffer.concat([header, content, Buffer.alloc(padding)])
  }

  it('pulls the binary out of a goreleaser-style single-file tgz', () => {
    const binary = Buffer.from('#!/bin/sh\necho hi\n')
    const gz = gzipSync(Buffer.concat([tarEntry('cloudflared', binary), Buffer.alloc(1024)]))
    assert.deepEqual(extractTgzSingleFile(gz), binary)
  })

  it('skips a directory entry and returns the first regular file', () => {
    const binary = Buffer.from('bin-bytes')
    const gz = gzipSync(Buffer.concat([
      tarEntry('cloudflared/', Buffer.alloc(0), 53),
      tarEntry('cloudflared/binary', binary),
      Buffer.alloc(1024),
    ]))
    assert.deepEqual(extractTgzSingleFile(gz), binary)
  })

  it('rejects a corrupt gzip payload', () => {
    assert.throws(() => extractTgzSingleFile(Buffer.from('not a gzip stream')))
  })

  it('rejects a tar stream whose size field runs past the buffer', () => {
    const header = Buffer.alloc(512)
    header.write('cloudflared', 0, 100, 'utf8')
    header.write('77777777777\0', 124, 12, 'utf8')
    header[156] = 48
    const gz = gzipSync(Buffer.concat([header, Buffer.alloc(10)]))
    assert.throws(() => extractTgzSingleFile(gz), /corrupt tar stream/)
  })
})

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (signal?: string) => void
  killed: string[]
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = []
  child.kill = (signal = 'SIGTERM') => {
    child.killed.push(signal)
    queueMicrotask(() => { child.emit('exit', 0, signal) })
  }
  return child
}

function fakeSpawn(emitter: { stdout: EventEmitter, stderr: EventEmitter }) {
  return () => emitter as unknown as ChildProcess
}

describe('tunnel manager state machine', () => {
  async function makeManager(options: {
    spawn: ReturnType<typeof fakeSpawn>
    fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean, arrayBuffer: () => Promise<ArrayBuffer> }>
    configuredPath?: string
  }): Promise<{ manager: TunnelManager, audit: Array<{ event: string, fields?: Record<string, unknown> }> }> {
    const dir = await tempDir()
    const audit: Array<{ event: string, fields?: Record<string, unknown> }> = []
    const spec = {
      target: () => 'http://127.0.0.1:3081',
      cacheDir: join(dir, 'bin'),
      spawnFn: options.spawn as unknown as typeof import('node:child_process').spawn,
      ...(options.fetch === undefined ? {} : { fetchFn: options.fetch as unknown as typeof fetch }),
      ...(options.configuredPath === undefined ? {} : { configuredPath: options.configuredPath }),
      audit: (event: string, fields?: Record<string, unknown>) => { audit.push({ event, ...(fields === undefined ? {} : { fields }) }) },
    }
    return { manager: createTunnelManager(spec), audit }
  }

  it('reaches online when the child prints the trycloudflare URL', async () => {
    const child = fakeChild()
    const configured = join(await tempDir(), 'cloudflared')
    await writeFile(configured, '#!/bin/sh')
    await chmod(configured, 0o755)
    const { manager, audit } = await makeManager({ spawn: fakeSpawn(child), configuredPath: configured })
    const first = await manager.start()
    assert.equal(first.state, 'starting')
    // spawn happens on the async resolve path; wait for the listener first.
    await until(() => child.stderr.listenerCount('data') >= 1)
    child.stderr.emit('data', Buffer.from('INF Your quick Tunnel has been created! Visit it at https://abc123.trycloudflare.com'))
    await until(() => manager.status().state === 'online')
    assert.equal(manager.status().publicUrl, 'https://abc123.trycloudflare.com')
    assert.equal(audit.some(e => e.event === 'tunnel.start' && e.fields?.publicUrl === 'https://abc123.trycloudflare.com'), true)
  })

  it('recognizes a tunnel URL split across child output chunks', async () => {
    const child = fakeChild()
    const configured = join(await tempDir(), 'cloudflared')
    await writeFile(configured, '#!/bin/sh')
    await chmod(configured, 0o755)
    const { manager } = await makeManager({ spawn: fakeSpawn(child), configuredPath: configured })
    await manager.start()
    await until(() => child.stderr.listenerCount('data') >= 1)
    child.stderr.emit('data', Buffer.from('INF Visit https://split-example.trycloud'))
    child.stderr.emit('data', Buffer.from('flare.com'))
    await until(() => manager.status().state === 'online')
    assert.equal(manager.status().publicUrl, 'https://split-example.trycloudflare.com')
  })

  it('surfaces exit-after-online as an error with the exited token', async () => {
    const child = fakeChild()
    const configured = join(await tempDir(), 'cloudflared')
    await writeFile(configured, '#!/bin/sh')
    await chmod(configured, 0o755)
    const { manager } = await makeManager({ spawn: fakeSpawn(child), configuredPath: configured })
    await manager.start()
    await until(() => child.stderr.listenerCount('data') >= 1)
    child.stderr.emit('data', Buffer.from('https://gone.trycloudflare.com'))
    await until(() => manager.status().state === 'online')
    child.emit('exit', 1, null)
    await until(() => manager.status().state === 'error')
    const status = manager.status()
    assert.equal(status.detail, 'exited')
    assert.equal(status.publicUrl, undefined)
  })

  it('kills the child and returns to off on stop', async () => {
    const child = fakeChild()
    const configured = join(await tempDir(), 'cloudflared')
    await writeFile(configured, '#!/bin/sh')
    await chmod(configured, 0o755)
    const { manager, audit } = await makeManager({ spawn: fakeSpawn(child), configuredPath: configured })
    await manager.start()
    // The child spawns asynchronously after binary resolution; wait until the
    // manager attached its exit handler before stopping.
    await until(() => child.listenerCount('exit') >= 1)
    const stopped = await manager.stop()
    assert.equal(stopped.state, 'off')
    assert.equal(child.killed.length > 0, true)
    assert.equal(audit.some(e => e.event === 'tunnel.stop'), true)
  })

  it('is idempotent while starting or online', async () => {
    const child = fakeChild()
    const configured = join(await tempDir(), 'cloudflared')
    await writeFile(configured, '#!/bin/sh')
    await chmod(configured, 0o755)
    const { manager } = await makeManager({ spawn: fakeSpawn(child), configuredPath: configured })
    const first = await manager.start()
    const again = await manager.start()
    assert.equal(again.state, 'starting')
    assert.deepEqual(first, again)
  })

  it('verifies the download hash and never caches a failed binary', async () => {
    const dir = await tempDir()
    const audit: Array<{ event: string }> = []
    // Hide any host-installed cloudflared so the manager takes the download
    // path deterministically.
    const savedPath = process.env.PATH
    process.env.PATH = ''
    try {
      const m = createTunnelManager({
      target: () => 'http://127.0.0.1:3081',
      cacheDir: join(dir, 'bin'),
      fetchFn: (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('not the real binary').buffer })) as unknown as typeof fetch,
      spawnFn: fakeSpawn(fakeChild()) as unknown as typeof import('node:child_process').spawn,
      audit: event => { audit.push({ event }) },
      })
      await m.start()
      await until(() => m.status().state === 'error')
      assert.equal(m.status().detail, 'integrity-failed')
      assert.equal(audit.some(e => e.event === 'tunnel.error'), true)
      const { stat } = await import('node:fs/promises')
      await assert.rejects(stat(join(dir, 'bin', 'cloudflared')))
    } finally {
      process.env.PATH = savedPath
    }
  })

  it('rejects an invalid configured path with a stable token', async () => {
    const { manager, audit } = await makeManager({ spawn: fakeSpawn(fakeChild()), configuredPath: '/does/not/exist' })
    await manager.start()
    await until(() => manager.status().state === 'error')
    assert.equal(manager.status().detail, 'configured-path-invalid')
    assert.equal(audit.some(e => e.event === 'tunnel.error'), true)
  })
})

describe('TunnelStatus shape', () => {
  it('omits absent optional fields', () => {
    const status: TunnelStatus = { state: 'off' }
    assert.equal('publicUrl' in status, false)
    assert.equal('detail' in status, false)
  })

  it('trusts forwarding headers only while the tunnel is online', () => {
    assert.equal(tunnelTrustsForwarding('off'), false)
    assert.equal(tunnelTrustsForwarding('error'), false)
    assert.equal(tunnelTrustsForwarding('starting'), false)
    assert.equal(tunnelTrustsForwarding('online'), true)
  })
})
