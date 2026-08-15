/**
 * CI-only fallback declarations for the DeepSeek Harness client packages.
 *
 * The harness monorepo's type declarations live in gitignored `lib/types/`
 * build outputs, so a fresh clone (CI) cannot resolve them. This file is
 * included ONLY by tsconfig.ci.json; local development uses the real built
 * types from the sibling checkout instead.
 *
 * Shapes mirror the real contracts for exactly the surface this plugin
 * consumes (BakedActions strips the draft parameter like the real types).
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context } from '@deepseek-ai/cordis'

  /** Mirrors the real alias: the client root context. */
  export type ClientContext = Context & {
    slots: {
      register(options: object, component: unknown): () => void
      inject(name: string, callback: () => unknown): () => void
    }
  }

  export type StoreSelector<S> = <T>(selector: (state: S) => T) => T

  /** Draft-stripped action callbacks, as the real BakedActions produces. */
  export type BakedActions<S, A> = {
    [K in keyof A]: A[K] extends (draft: S, ...params: infer P) => void
      ? (...params: P) => void
      : never
  }

  /** Mirrors EngineStoreHandle<T, A> — just the surface our components read. */
  export type EngineStoreHandle<S, A> = {
    useStore: StoreSelector<S>
    actions: BakedActions<S, A>
  }

  export function defineStore<S, A>(decl: { init: () => S, actions: A }): EngineStoreHandle<S, A>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Minimal runtime-props share: settings.section supplies `close`. */
  export type PropsRuntime<K extends string> = { close?: () => void, wide?: boolean }

  /** The store share: our handles expose exactly useStore + actions. */
  export type PropsStore<H> = H
}
