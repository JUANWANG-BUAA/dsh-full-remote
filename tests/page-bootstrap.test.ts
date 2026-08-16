import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
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

function bootPage(): BootEnv {
  const env: BootEnv = { Object, Function, Error, TypeError, console }
  env.globalThis = env
  vm.createContext(env)
  vm.runInContext(PAGE_BOOTSTRAP_SOURCE, env)
  return env
}

describe('page bootstrap', () => {
  it('does not contain a script closer that would break the index tap', () => {
    assert.equal(PAGE_BOOTSTRAP_SOURCE.includes('</script>'), false)
  })

  it('leaves __ModuleLoader__ unset so the shell can install it', () => {
    const env = bootPage()
    assert.equal(env.__DSH_FULL_REMOTE_TRUSTED__, 1)
    assert.equal(env.__ModuleLoader__, undefined)
  })

  it('forces connection.isLoopback at provide time', () => {
    const env = bootPage()
    env.provided = []
    env.factoryModule = {
      apply(ctx: { provide(name: string, value: unknown): void }) {
        ctx.provide('connection', { isLoopback: false, api: {} })
      },
    }
    vm.runInContext(`
      var captured;
      globalThis.__ModuleLoader__ = { load: function(h) { captured = h } };
      globalThis.__ModuleLoader__.load({
        id: ${JSON.stringify(CONNECTION_CLIENT_ID)},
        factory: function() { return globalThis.factoryModule }
      });
      var mod = captured.factory(function() {});
      mod.apply({
        provide: function(key, value) { globalThis.provided.push({ key: key, value: value }) }
      });
    `, env)
    const provided = env.provided as Array<{ key: string, value: { isLoopback: boolean } }>
    assert.equal(provided.length, 1)
    assert.equal(provided[0].key, 'connection')
    assert.equal(provided[0].value.isLoopback, true)
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
    env.factoryModule = {
      apply(ctx: { provide(name: string, value: unknown): void }) {
        ctx.provide('connection', { isLoopback: false, api: {} })
      },
    }
    vm.runInContext(`
      var captured;
      globalThis.__ModuleLoader__ = { load: function(h) { captured = h } };
      globalThis.__ModuleLoader__.load({
        id: ${JSON.stringify(CONNECTION_CLIENT_ID)},
        factory: function() { return globalThis.factoryModule }
      });
      captured.factory(function() {}).apply({
        provide: function(key, value) { globalThis.provided.push(value) }
      });
    `, env)
    const provided = env.provided as Array<{ isLoopback: boolean }>
    assert.equal(provided[0].isLoopback, false)
  })
})
