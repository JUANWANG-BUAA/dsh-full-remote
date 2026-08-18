import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, type Plugin } from '@deepseek-ai/cordis'
import * as pluginModule from '../src/index.ts'

/**
 * The plugin's `apply(ctx: RuntimeContext, …)` uses a structural context type
 * (with `webServer`) rather than the `Context` augmentation from the real host
 * package, so it is not directly assignable to cordis's `Plugin.Object`. This
 * cast is type-only: at runtime the harness's real `Context` does carry the
 * `webServer` service and the plugin is a valid object plugin.
 */
const plugin = pluginModule as unknown as Plugin.Object

class TestWebServer extends Service {
  port = 3080
  routes = 0
  taps = 0

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register() {
    this.routes += 1
    return () => { this.routes -= 1 }
  }

  tapIndex() {
    this.taps += 1
    return () => { this.taps -= 1 }
  }
}

describe('Cordis lifecycle', () => {
  it('withdraws routes and index taps when the plugin fiber is disposed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-lifecycle-'))
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      const web = ctx.get('webServer') as TestWebServer
      const fiber = await ctx.plugin(plugin, {
        listenHost: '127.0.0.1',
        listenPort: 0,
        backendHost: '127.0.0.1',
        backendPort: 3080,
        stateFile: join(dir, 'state.json'),
        autoRestore: false,
        maxRequestBytes: 1024,
        upstreamTimeoutMs: 1000,
        cookieName: 'test_session',
      })
      assert.equal(web.routes, 1)
      assert.equal(web.taps, 1)
      await fiber.dispose()
      assert.equal(web.routes, 0)
      assert.equal(web.taps, 0)

      const reloaded = await ctx.plugin(plugin, {
        listenHost: '127.0.0.1',
        listenPort: 0,
        backendHost: '127.0.0.1',
        backendPort: 3080,
        stateFile: join(dir, 'state.json'),
        autoRestore: false,
        maxRequestBytes: 1024,
        upstreamTimeoutMs: 1000,
        cookieName: 'test_session',
      })
      assert.equal(web.routes, 1)
      assert.equal(web.taps, 1)
      await reloaded.dispose()
      assert.equal(web.routes, 0)
      assert.equal(web.taps, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a wildcard backendHost at apply()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-backend-'))
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await assert.rejects(
        async () => {
          await ctx.plugin(plugin, {
            listenHost: '127.0.0.1',
            listenPort: 0,
            backendHost: '0.0.0.0',
            backendPort: 3080,
            stateFile: join(dir, 'state.json'),
            autoRestore: false,
            maxRequestBytes: 1024,
            upstreamTimeoutMs: 1000,
            cookieName: 'test_session',
          })
        },
        /wildcard/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-loopback backendHost at apply()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-backend-lan-'))
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await assert.rejects(
        async () => {
          await ctx.plugin(plugin, {
            listenHost: '127.0.0.1',
            listenPort: 0,
            backendHost: '192.168.1.10',
            backendPort: 3080,
            stateFile: join(dir, 'state.json'),
            autoRestore: false,
            maxRequestBytes: 1024,
            upstreamTimeoutMs: 1000,
            cookieName: 'test_session',
          })
        },
        /loopback/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects partial TLS and malformed CIDR configuration at apply()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-security-config-'))
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      const base = {
        listenHost: '127.0.0.1',
        listenPort: 0,
        backendHost: '127.0.0.1',
        backendPort: 3080,
        stateFile: join(dir, 'state.json'),
        autoRestore: false,
        maxRequestBytes: 1024,
        upstreamTimeoutMs: 1000,
        cookieName: 'test_session',
      }
      await assert.rejects(
        async () => { await ctx.plugin(plugin, { ...base, tlsCertFile: '/tmp/cert.pem' }) },
        /tlsCertFile and tlsKeyFile/,
      )
      await assert.rejects(
        async () => { await ctx.plugin(plugin, { ...base, allowedCidrs: ['not-an-ip'] }) },
        /allowedCidrs contains invalid CIDR/,
      )
      await assert.rejects(
        async () => { await ctx.plugin(plugin, { ...base, trustCloudflareConnectingIp: true }) },
        /trustCloudflareConnectingIp requires trustForwardedFor/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
