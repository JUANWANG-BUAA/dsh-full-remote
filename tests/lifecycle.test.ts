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

class TestConnection extends Service {
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  authenticatedUrl(baseUrl: string) {
    return `${baseUrl}/?token=test-launch-token`
  }
}

class TestLoader extends Service {
  store: Record<string, unknown> = { 'directory-picker': {} }
  created: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'loader')
  }

  async create({ name }: { name: string }) {
    const id = name.includes('ui-directory-picker-browse') ? 'ui-pin' : 'host-pin'
    this.store[id] = { name }
    this.created.push(id)
    return id
  }

  *entries() {
    for (const id of Object.keys(this.store)) yield { options: { id } }
  }

  async remove(id: string) {
    delete this.store[id]
    this.created = this.created.filter(entry => entry !== id)
  }
}

function pluginConfig(dir: string) {
  return {
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
}

describe('Cordis lifecycle', () => {
  it('withdraws routes and index taps when the plugin fiber is disposed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-lifecycle-'))
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await ctx.plugin(TestConnection)
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

  it('pins the browse pair when the official ids are absent, and removes them on dispose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-picker-'))
    const previous = process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
    delete process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await ctx.plugin(TestConnection)
      await ctx.plugin(TestLoader)
      const loader = ctx.get('loader') as TestLoader
      const fiber = await ctx.plugin(plugin, pluginConfig(dir))
      for (let i = 0; i < 20 && loader.created.length < 2; i++) {
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
      assert.deepEqual(loader.created, ['host-pin', 'ui-pin'])
      await fiber.dispose()
      assert.deepEqual(loader.created, [])
    } finally {
      if (previous === undefined) delete process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
      else process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not pin browse when another plugin already inserted the official ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-picker-skip-'))
    const previous = process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
    delete process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await ctx.plugin(TestConnection)
      await ctx.plugin(TestLoader)
      const loader = ctx.get('loader') as TestLoader
      loader.store['directory-picker-browse'] = {}
      loader.store['ui-directory-picker-browse'] = {}
      const fiber = await ctx.plugin(plugin, pluginConfig(dir))
      await new Promise<void>(resolve => { setImmediate(resolve) })
      assert.deepEqual(loader.created, [])
      await fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
      else process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not pin when official browse ids live under a nested Include tree', async () => {
    class NestedIncludeLoader extends Service {
      created: string[] = []

      constructor(ctx: Context) {
        super(ctx, 'loader')
      }

      *entries() {
        yield { options: { id: 'include' } }
        yield { id: 'include:directory-picker-browse', options: { id: 'directory-picker-browse' } }
        yield { id: 'include:ui-directory-picker-browse', options: { id: 'ui-directory-picker-browse' } }
      }

      async create() {
        this.created.push('unexpected')
        return 'unexpected'
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-picker-nested-'))
    const previous = process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
    delete process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await ctx.plugin(TestConnection)
      await ctx.plugin(NestedIncludeLoader)
      const loader = ctx.get('loader') as NestedIncludeLoader
      const fiber = await ctx.plugin(plugin, pluginConfig(dir))
      await new Promise<void>(resolve => { setImmediate(resolve) })
      assert.deepEqual(loader.created, [])
      await fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER
      else process.env.DSH_FULL_REMOTE_USE_NATIVE_PICKER = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a wildcard backendHost at apply()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-backend-'))
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await ctx.plugin(TestConnection)
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
      await ctx.plugin(TestConnection)
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

  it('keeps the backend loopback fence when createRuntime is called directly', () => {
    assert.throws(
      () => pluginModule.createRuntime({} as never, { backendHost: '192.168.1.10' } as never),
      /loopback/,
    )
    assert.throws(
      () => pluginModule.createRuntime({} as never, { backendHost: '0.0.0.0' } as never),
      /wildcard/,
    )
  })

  it('rejects partial TLS and malformed CIDR configuration at apply()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-security-config-'))
    try {
      const ctx = new Context()
      await ctx.plugin(TestWebServer)
      await ctx.plugin(TestConnection)
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
