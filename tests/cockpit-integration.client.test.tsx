import * as Cordis from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import * as Slots from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry as SlotRegistryType } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/client/index.ts'
import type { InteractionOverlayInjected } from '../src/client/InteractionOverlay.tsx'
import type { ConnectionSourceState } from '../src/client/cockpit-connection.ts'

// The published renderer/client is a ModuleLoader browser bundle, not Node ESM.
// Execute its actual factory with the same shared Cordis/React/SlotCore modules;
// registration, declaration injection and fiber teardown remain real upstream code.
function loadRegistry(): typeof SlotRegistryType {
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8')
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-ui-slots': Slots,
    'react': React, 'react-dom': ReactDom, 'react-dom/client': ReactDomClient, 'react/jsx-runtime': JsxRuntime,
  }
  let result: { SlotRegistry: typeof SlotRegistryType } | undefined
  const loaderWindow = { __ModuleLoader__: {
    load: ({ factory }: { factory: (require: (name: string) => unknown) => { SlotRegistry: typeof SlotRegistryType } }) => {
      result = factory(name => {
        if (!(name in dependencies)) throw new Error('Unexpected renderer dependency: ' + name)
        return dependencies[name]
      })
    },
  } }
  new Function('window', source)(loaderWindow)
  if (result === undefined) throw new Error('Renderer bundle did not register its factory')
  return result.SlotRegistry
}

const SlotRegistry = loadRegistry()
const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  localStorage.clear()
})

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribe() }
    },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
    listeners,
    unsubscribe,
  }
}

function domainFixtures() {
  const list = observable({ ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Real slot session', running: true } }, phase: 'ready' as const })
  const status = observable(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  const state = observable<ConnectionSourceState>('connected')
  const sessions = { list, refresh: vi.fn().mockResolvedValue(undefined) }
  const uiSession = { sessionStatus: status }
  const connection = { state, reconnect: vi.fn() }
  const uiWorkspace = { openSession: vi.fn() }
  return { list, status, state, sessions, uiSession, connection, uiWorkspace }
}

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin({ apply: (scope: Context) => { new SlotRegistry(scope) } })
  await ctx.plugin({ inject: ['slots'], apply: (scope: Context) => {
    scope.slots.register({ name: 'root', children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
    } }, (_props: { renderSlot: unknown }) => null)
  } })
  const slots = ctx.get('slots', false) as SlotRegistryType
  return { ctx, slots }
}

function injected(slots: SlotRegistryType): InteractionOverlayInjected {
  const entry = slots.entries('shell.overlay').find(value => value.options.id === 'reverse-proxy-interact')
  if (entry?.inject === undefined) throw new Error('Cockpit entry is not registered')
  // Registry inspection intentionally erases the injected business-face type.
  return entry.inject() as unknown as InteractionOverlayInjected
}

describe('real Cordis cockpit registration', () => {
  it('waits for actual connection and workspace dependencies, injects their live faces, and cleans sources on unload', async () => {
    const { ctx, slots } = await setup()
    const domain = domainFixtures()
    await ctx.plugin({ apply: (scope: Context) => {
      scope.provide('sessions', domain.sessions)
      scope.provide('uiSession', domain.uiSession)
    } })
    const fiber = await ctx.plugin(plugin)
    expect(slots.entries('settings.section').map(entry => entry.options.id)).toContain('reverse-proxy')
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(domain.list.listeners.size).toBe(0)
    await ctx.plugin({ apply: (scope: Context) => { scope.provide('connection', domain.connection) } })
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    await ctx.plugin({ apply: (scope: Context) => { scope.provide('uiWorkspace', domain.uiWorkspace) } })
    const face = injected(slots)
    expect(face.canOpenSession).toBe(true)
    expect(face.connection?.getSnapshot().state).toBe('connected')
    expect(face.hooks.remotePending.getSnapshot().sessions?.[0]).toMatchObject({ id: 's1', title: 'Real slot session', running: true })
    expect(domain.list.listeners.size).toBe(1)
    expect(domain.status.listeners.size).toBe(1)
    expect(domain.state.listeners.size).toBe(1)
    face.openSession('s1')
    expect(domain.uiWorkspace.openSession).toHaveBeenCalledWith('s1')
    await face.connection?.refresh()
    expect(domain.sessions.refresh).toHaveBeenCalledTimes(1)
    domain.state.set('disconnected')
    expect(face.connection?.getSnapshot().state).toBe('disconnected')
    face.connection?.reconnect()
    expect(domain.connection.reconnect).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(domain.list.unsubscribe).toHaveBeenCalledTimes(1)
    expect(domain.status.unsubscribe).toHaveBeenCalledTimes(1)
    expect(domain.state.unsubscribe).toHaveBeenCalledTimes(1)
    expect(face.hooks.remotePending.getSnapshot()).toEqual({ items: [] })
    await face.connection?.refresh()
    face.connection?.reconnect()
    expect(domain.sessions.refresh).toHaveBeenCalledTimes(1)
    expect(domain.connection.reconnect).toHaveBeenCalledTimes(1)
  })

  it('withdraws and reconstructs the cockpit when the required workspace service generation changes', async () => {
    const { ctx, slots } = await setup()
    const domain = domainFixtures()
    await ctx.plugin({ apply: (scope: Context) => {
      scope.provide('sessions', domain.sessions)
      scope.provide('uiSession', domain.uiSession)
      scope.provide('connection', domain.connection)
    } })
    const workspace = await ctx.plugin({ apply: (scope: Context) => { scope.provide('uiWorkspace', domain.uiWorkspace) } })
    await ctx.plugin(plugin)
    const old = injected(slots)
    await workspace.dispose()
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(domain.list.listeners.size).toBe(0)
    expect(domain.status.listeners.size).toBe(0)
    expect(domain.state.listeners.size).toBe(0)
    expect(old.hooks.remotePending.getSnapshot()).toEqual({ items: [] })
    const nextWorkspace = { openSession: vi.fn() }
    await ctx.plugin({ apply: (scope: Context) => { scope.provide('uiWorkspace', nextWorkspace) } })
    const next = injected(slots)
    expect(next.hooks.remotePending).not.toBe(old.hooks.remotePending)
    expect(domain.list.listeners.size).toBe(1)
    next.openSession('s1')
    expect(nextWorkspace.openSession).toHaveBeenCalledWith('s1')
    expect(domain.uiWorkspace.openSession).not.toHaveBeenCalled()
  })
})
