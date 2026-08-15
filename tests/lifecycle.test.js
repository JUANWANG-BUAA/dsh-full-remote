import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'

class TestWebServer extends Service {
  port = 3080
  routes = 0
  taps = 0

  constructor(ctx) {
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
      const web = ctx.get('webServer')
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
})
