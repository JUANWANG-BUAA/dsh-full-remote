import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { CONNECTION_CLIENT_ID, PAGE_BOOTSTRAP_SOURCE } from '../src/page-bootstrap.ts'

function bootPage() {
  const env = { Object, Function, Error, TypeError, console }
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
      apply(ctx) {
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
    assert.equal(env.provided.length, 1)
    assert.equal(env.provided[0].key, 'connection')
    assert.equal(env.provided[0].value.isLoopback, true)
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
      apply(ctx) {
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
    assert.equal(env.provided[0].isLoopback, false)
  })
})
