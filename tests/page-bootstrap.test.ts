import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { CONNECTION_CLIENT_ID, PAGE_BOOTSTRAP_SOURCE } from '../src/page-bootstrap.ts'

/**
 * The vm sandbox starts from a few well-known globals and then accumulates the
 * PAGE_BOOTSTRAP_SOURCE globals plus test-injected fixtures, so it is modeled
 * as a permissive record whose test-injected fields are cast at the read site.
 */
type BootEnv = Record<string, unknown> & {
  Object: ObjectConstructor
  Function: FunctionConstructor
  Error: ErrorConstructor
  TypeError: TypeErrorConstructor
  console: Console
}

function bootPage(init?: (env: BootEnv) => void): BootEnv {
  const env: BootEnv = { Object, Function, Error, TypeError, console }
  env.globalThis = env
  init?.(env)
  vm.createContext(env)
  vm.runInContext(PAGE_BOOTSTRAP_SOURCE, env)
  return env
}

function loadWrappedConnection(env: BootEnv): void {
  vm.runInContext(`
    var captured;
    globalThis.__ModuleLoader__ = { load: function(h) { captured = h } };
    globalThis.__ModuleLoader__.load({
      id: ${JSON.stringify(CONNECTION_CLIENT_ID)},
      factory: function() { return globalThis.factoryModule }
    });
    globalThis.wrappedMod = captured.factory(function() {});
  `, env)
}

function mockCtx(env: BootEnv, handle: { isLoopback: boolean }): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  const ctx: Record<string, unknown> = {
    store,
    provide(key: string, value: unknown) {
      store[key] = value
      ;(env.provided as unknown[]).push({ key, value })
    },
    get(key: string) {
      const n = (env.getCalls as number | undefined) ?? 0
      env.getCalls = n + 1
      return store[key]
    },
  }
  env.handle = handle
  env.ctx = ctx
  return ctx
}

describe('page bootstrap', () => {
  it('does not contain a script closer that would break the index tap', () => {
    assert.equal(PAGE_BOOTSTRAP_SOURCE.includes('</script>'), false)
  })

  it('leaves __ModuleLoader__ unset so the shell can install it', () => {
    const env = bootPage()
    assert.equal(env.__DSH_FULL_REMOTE_TRUSTED__, 1)
    assert.equal(env.__ModuleLoader__, undefined)
    assert.equal(env.__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__, undefined)
  })

  it('does not raise TRUSTED when the ModuleLoader wrap fails', () => {
    const env = bootPage((sandbox) => {
      sandbox.console = { ...console, warn() { /* expected: wrap cannot install */ } }
      Object.defineProperty(sandbox, '__ModuleLoader__', {
        value: {},
        configurable: false,
        writable: false,
        enumerable: true,
      })
    })
    assert.equal(env.__DSH_FULL_REMOTE_TRUSTED__, undefined)
    assert.equal(env.__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__, 1)
  })

  it('pins connection.isLoopback after apply returns, without assigning provide', () => {
    const env = bootPage()
    env.provided = []
    env.getCalls = 0
    const handle = { isLoopback: false, api: {} }
    env.factoryModule = {
      apply(ctx: { provide(name: string, value: unknown): void }) {
        ctx.provide('connection', handle)
      },
    }
    loadWrappedConnection(env)
    const ctx = mockCtx(env, handle)
    let provideAssigned = false
    Object.defineProperty(ctx, 'provide', {
      configurable: true,
      enumerable: true,
      get() {
        return function provide(this: { store: Record<string, unknown> }, key: string, value: unknown) {
          this.store[key] = value
          ;(env.provided as unknown[]).push({ key, value })
        }
      },
      set() {
        provideAssigned = true
        throw new Error('must not assign ctx.provide')
      },
    })
    vm.runInContext('globalThis.wrappedMod.apply(globalThis.ctx)', env)
    assert.equal(provideAssigned, false)
    const provided = env.provided as Array<{ key: string, value: { isLoopback: boolean } }>
    assert.equal(provided.length, 1)
    assert.equal(provided[0].key, 'connection')
    assert.equal(handle.isLoopback, true)
    assert.equal(env.getCalls, 1)
  })

  it('does not wrap unrelated plugin factories', () => {
    const env = bootPage()
    function innerFactory() {
      return { marker: 1 }
    }
    env.inner = innerFactory
    vm.runInContext(`
      globalThis.seen = null;
      globalThis.__ModuleLoader__ = { load: function(h) { globalThis.seen = h.factory } };
      globalThis.__ModuleLoader__.load({ id: 'other.plugin', factory: globalThis.inner });
    `, env)
    assert.equal(env.seen, innerFactory)
  })

  it('leaves isLoopback alone when the trust flag is cleared', () => {
    const env = bootPage()
    vm.runInContext('delete globalThis.__DSH_FULL_REMOTE_TRUSTED__', env)
    env.provided = []
    const handle = { isLoopback: false, api: {} }
    env.factoryModule = {
      apply(ctx: { provide(name: string, value: unknown): void }) {
        ctx.provide('connection', handle)
      },
    }
    loadWrappedConnection(env)
    mockCtx(env, handle)
    vm.runInContext('globalThis.wrappedMod.apply(globalThis.ctx)', env)
    assert.equal(handle.isLoopback, false)
  })

  it('is idempotent for CJS default===mod (wrap apply once)', () => {
    const env = bootPage()
    env.provided = []
    env.getCalls = 0
    function apply(ctx: { provide(name: string, value: unknown): void }) {
      ctx.provide('connection', { isLoopback: false })
    }
    const shared: { apply: typeof apply, default?: unknown } = { apply }
    shared.default = shared
    env.factoryModule = shared
    loadWrappedConnection(env)
    const wrapped = env.wrappedMod as { apply: { __dshFullRemoteApply?: boolean }, default: { apply: unknown } }
    assert.equal(wrapped.apply.__dshFullRemoteApply, true)
    assert.equal(wrapped.apply, wrapped.default.apply)
    mockCtx(env, { isLoopback: false })
    vm.runInContext('globalThis.wrappedMod.apply(globalThis.ctx)', env)
    assert.equal(env.getCalls, 1)
  })

  it('pins after a thenable apply resolves', async () => {
    const env = bootPage()
    env.provided = []
    const handle = { isLoopback: false }
    env.Promise = Promise
    env.factoryModule = {
      apply(ctx: { provide(name: string, value: unknown): void }) {
        return Promise.resolve().then(() => {
          ctx.provide('connection', handle)
        })
      },
    }
    loadWrappedConnection(env)
    mockCtx(env, handle)
    const pending = vm.runInContext('globalThis.wrappedMod.apply(globalThis.ctx)', env) as Promise<void>
    assert.equal(handle.isLoopback, false)
    await pending
    assert.equal(handle.isLoopback, true)
  })

  it('sets BOOTSTRAP_FAILED when export wrap cannot replace apply', () => {
    const env = bootPage((sandbox) => {
      sandbox.console = { ...console, warn() { /* expected: apply is frozen */ } }
    })
    const frozen = function apply() { /* unused */ }
    const mod: { apply?: unknown } = {}
    Object.defineProperty(mod, 'apply', {
      get() { return frozen },
      set() { throw new Error('frozen apply') },
      configurable: true,
    })
    env.factoryModule = mod
    loadWrappedConnection(env)
    assert.equal(env.__DSH_FULL_REMOTE_TRUSTED__, 1)
    assert.equal(env.__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__, 1)
  })
})

type ModuleFactory = (...args: unknown[]) => unknown
type LoaderHandle = { id: string, factory: ModuleFactory }

describe('page bootstrap vs real Cordis Context', () => {
  const g = globalThis as {
    __DSH_FULL_REMOTE_TRUSTED__?: number
    __DSH_FULL_REMOTE_BOOTSTRAP_FAILED__?: number
    __ModuleLoader__?: { load: (h: LoaderHandle) => unknown }
  }
  let previousLoader: PropertyDescriptor | undefined

  function installLoader(): { captured: Partial<LoaderHandle> } {
    const captured: Partial<LoaderHandle> = {}
    g.__ModuleLoader__ = {
      load(h: LoaderHandle) {
        captured.id = h.id
        captured.factory = h.factory
        return h
      },
    }
    return { captured }
  }

  before(() => {
    previousLoader = Object.getOwnPropertyDescriptor(globalThis, '__ModuleLoader__')
    eval(PAGE_BOOTSTRAP_SOURCE)
  })

  after(() => {
    Reflect.deleteProperty(globalThis, '__DSH_FULL_REMOTE_TRUSTED__')
    Reflect.deleteProperty(globalThis, '__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__')
    Reflect.deleteProperty(globalThis, '__ModuleLoader__')
    if (previousLoader !== undefined) {
      Object.defineProperty(globalThis, '__ModuleLoader__', previousLoader)
    }
  })

  it('lets a later plugin provide and read its own service without bootstrap pollution', async () => {
    const ctx = new Context()
    await ctx.plugin({
      apply(c: Context) {
        c.provide('connection', { isLoopback: false, api: {} })
      },
    })
    await ctx.plugin({
      apply(c: Context) {
        c.provide('betterSidebar', { marker: 1 })
        const value = (c as Context & { betterSidebar?: { marker: number } }).betterSidebar
        assert.equal(value?.marker, 1)
      },
    })
  })

  it('pins isLoopback, keeps provide identity, and allows ctx.ownService reads', async () => {
    const { captured } = installLoader()
    g.__ModuleLoader__!.load({
      id: CONNECTION_CLIENT_ID,
      factory: () => ({
        apply(ctx: Context) {
          ctx.provide('connection', { isLoopback: false, api: {} })
        },
      }),
    })
    const mod = (captured.factory as ModuleFactory)() as { apply: (ctx: Context) => void }
    const ctx = new Context()
    const provideBefore = ctx.reflect.provide
    await ctx.plugin({ apply: (c: Context) => mod.apply(c) })
    const provideAfter = ctx.reflect.provide
    const handle = ctx.get('connection', false) as { isLoopback?: boolean } | undefined
    assert.equal(handle?.isLoopback, true)
    assert.equal(Object.hasOwn(ctx.reflect, 'provide'), false)
    assert.equal(provideBefore, provideAfter)

    await ctx.plugin({
      apply(c: Context) {
        c.provide('betterSidebar', { marker: 1 })
        const value = (c as Context & { betterSidebar: { marker: number } }).betterSidebar
        assert.equal(value.marker, 1)
      },
    })
    const viaGet = ctx.get('betterSidebar', false) as { marker?: number } | undefined
    assert.equal(viaGet?.marker, 1)
  })

  it('covers a similar plugin that provide()s then reads ctx.theme without inject', async () => {
    const { captured } = installLoader()
    g.__ModuleLoader__!.load({
      id: CONNECTION_CLIENT_ID,
      factory: () => ({
        apply(ctx: Context) {
          ctx.provide('connection', { isLoopback: false, api: {} })
        },
      }),
    })
    const mod = (captured.factory as ModuleFactory)() as { apply: (ctx: Context) => void }
    const ctx = new Context()
    await ctx.plugin({ apply: (c: Context) => mod.apply(c) })
    await ctx.plugin({
      apply(c: Context) {
        c.provide('theme', { id: 'dark' })
        const theme = (c as Context & { theme: { id: string } }).theme
        assert.equal(theme.id, 'dark')
      },
    })
  })

  it('still serves inject consumers of a later-provided service', async () => {
    const { captured } = installLoader()
    g.__ModuleLoader__!.load({
      id: CONNECTION_CLIENT_ID,
      factory: () => ({
        apply(ctx: Context) {
          ctx.provide('connection', { isLoopback: false, api: {} })
        },
      }),
    })
    const mod = (captured.factory as ModuleFactory)() as { apply: (ctx: Context) => void }
    const ctx = new Context()
    await ctx.plugin({ apply: (c: Context) => mod.apply(c) })
    await ctx.plugin({
      apply(c: Context) {
        c.provide('betterSidebar', { marker: 7 })
      },
    })
    await ctx.plugin({
      inject: ['betterSidebar'],
      apply(c: Context) {
        const value = (c as Context & { betterSidebar: { marker: number } }).betterSidebar
        assert.equal(value.marker, 7)
      },
    })
  })

  it('lets a later plugin dispose and re-provide the same service name', async () => {
    const { captured } = installLoader()
    g.__ModuleLoader__!.load({
      id: CONNECTION_CLIENT_ID,
      factory: () => ({
        apply(ctx: Context) {
          ctx.provide('connection', { isLoopback: false, api: {} })
        },
      }),
    })
    const mod = (captured.factory as ModuleFactory)() as { apply: (ctx: Context) => void }
    const ctx = new Context()
    await ctx.plugin({ apply: (c: Context) => mod.apply(c) })
    const first = await ctx.plugin({
      apply(c: Context) {
        c.provide('theme', { n: 1 })
      },
    })
    await first.dispose()
    await ctx.plugin({
      apply(c: Context) {
        c.provide('theme', { n: 2 })
        assert.equal((c as Context & { theme: { n: number } }).theme.n, 2)
      },
    })
  })
})
