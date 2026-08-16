/**
 * Red/green reproduction of issue #9 against a real Cordis 4 Context Proxy.
 * After the wrapApply fix this script should be all PASS.
 *   node --experimental-strip-types scripts/repro-issue-9.mts
 */
import { Context } from '@deepseek-ai/cordis'
import { CONNECTION_CLIENT_ID, PAGE_BOOTSTRAP_SOURCE } from '../src/page-bootstrap.ts'

type Result = { name: string, ok: boolean, detail: string }

type ModuleFactory = (...args: unknown[]) => unknown
type LoaderHandle = { id: string, factory: ModuleFactory }

function boot(): void {
  eval(PAGE_BOOTSTRAP_SOURCE)
}

function installLoader(): { captured: Partial<LoaderHandle> } {
  const captured: Partial<LoaderHandle> = {}
  ;(globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__ = {
    load(h: LoaderHandle) {
      captured.id = h.id
      captured.factory = h.factory
      return h
    },
  }
  return { captured }
}

function connectionModule() {
  return {
    apply(ctx: Context) {
      ctx.provide('connection', { isLoopback: false, api: {} })
    },
  }
}

async function run(name: string, fn: () => Promise<string> | string): Promise<Result> {
  try {
    const detail = await fn()
    return { name, ok: true, detail }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function caseNoBootstrap(): Promise<string> {
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
      if (value?.marker !== 1) throw new Error('could not read own service')
    },
  })
  return 'provide+read works without going through ModuleLoader'
}

async function caseWithBootstrap(): Promise<{
  loopback: boolean
  provideSame: boolean
  provideOwn: boolean
  ownRead: string
  getFinds: boolean
  themeRead: string
  redispose: string
}> {
  boot()
  const { captured } = installLoader()
  const g = globalThis as { __ModuleLoader__: { load: (h: LoaderHandle) => unknown } }
  g.__ModuleLoader__.load({
    id: CONNECTION_CLIENT_ID,
    factory: () => connectionModule(),
  })
  const mod = (captured.factory as ModuleFactory)() as { apply: (ctx: Context) => void }
  const ctx = new Context()
  const provideBefore = ctx.reflect.provide
  await ctx.plugin({ apply: (c: Context) => mod.apply(c) })
  const handle = ctx.get('connection', false) as { isLoopback?: boolean } | undefined
  const provideAfter = ctx.reflect.provide
  const provideOwn = Object.hasOwn(ctx.reflect, 'provide')
  let ownRead = 'ok'
  try {
    await ctx.plugin({
      apply(c: Context) {
        c.provide('betterSidebar', { marker: 1 })
        void (c as Context & { betterSidebar: { marker: number } }).betterSidebar.marker
      },
    })
  } catch (error) {
    ownRead = error instanceof Error ? error.message : String(error)
  }
  const viaGet = ctx.get('betterSidebar', false) as { marker?: number } | undefined
  let themeRead = 'ok'
  try {
    await ctx.plugin({
      apply(c: Context) {
        c.provide('theme', { id: 'dark' })
        void (c as Context & { theme: { id: string } }).theme.id
      },
    })
  } catch (error) {
    themeRead = error instanceof Error ? error.message : String(error)
  }
  let redispose = 'ok'
  try {
    const first = await ctx.plugin({
      apply(c: Context) {
        c.provide('scratchService', { n: 1 })
      },
    })
    await first.dispose()
    await ctx.plugin({
      apply(c: Context) {
        c.provide('scratchService', { n: 2 })
        void (c as Context & { scratchService: { n: number } }).scratchService.n
      },
    })
  } catch (error) {
    redispose = error instanceof Error ? error.message : String(error)
  }
  return {
    loopback: handle?.isLoopback === true,
    provideSame: provideBefore === provideAfter,
    provideOwn,
    ownRead,
    getFinds: viaGet?.marker === 1,
    themeRead,
    redispose,
  }
}

async function main() {
  const results: Result[] = []
  results.push(await run('A 无 ModuleLoader：后续插件 provide 并可读 ctx.xxx', caseNoBootstrap))

  const b = await caseWithBootstrap()
  results.push({
    name: 'B bootstrap 后 connection.isLoopback 为 true',
    ok: b.loopback,
    detail: `isLoopback=${String(b.loopback)}`,
  })
  results.push({
    name: 'C bootstrap 前后 ctx.reflect.provide 身份不变且非 own property',
    ok: b.provideSame && !b.provideOwn,
    detail: b.provideSame && !b.provideOwn
      ? 'same prototype provide'
      : `provideSame=${String(b.provideSame)} own=${String(b.provideOwn)}`,
  })
  results.push({
    name: 'D 后续插件 provide 后读 ctx.betterSidebar',
    ok: b.ownRead === 'ok',
    detail: b.ownRead,
  })
  results.push({
    name: 'E ctx.get(betterSidebar, false) 仍能从全局 store 读到',
    ok: b.getFinds,
    detail: `getFinds=${String(b.getFinds)}`,
  })
  results.push({
    name: 'F 类似场景：provide theme 后读 ctx.theme',
    ok: b.themeRead === 'ok',
    detail: b.themeRead,
  })
  results.push({
    name: 'G 类似场景：dispose 后可再 provide 同名服务',
    ok: b.redispose === 'ok',
    detail: b.redispose,
  })

  for (const row of results) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}`)
    console.log(`      ${row.detail}`)
  }
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
