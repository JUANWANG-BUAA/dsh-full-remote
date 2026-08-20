/**
 * Pin Harness's in-app directory browser when this plugin is the only layer
 * doing so. Other remote-access bundles (e.g. deepseek-harness-auth) insert
 * the same official rows under the same ids; a second insert crashes boot
 * with `duplicate loader entry id`.
 *
 * The patch therefore only disables the adaptive `directory-picker` row.
 * Browse faces are created at runtime when those canonical ids are absent
 * from the whole loader tree (including nested Include subtrees).
 */
export const DIRECTORY_PICKER_NATIVE_OPT_OUT = 'DSH_FULL_REMOTE_USE_NATIVE_PICKER'

export const CANONICAL_BROWSE_ENTRY_IDS = [
  'directory-picker-browse',
  'ui-directory-picker-browse',
] as const

export const BROWSE_HOST_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-browse'
export const BROWSE_UI_PACKAGE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'

export interface LoaderEntryLike {
  id?: string
  options?: { id?: string }
}

export interface BrowseLoader {
  store?: Record<string, unknown>
  entries?: () => Iterable<LoaderEntryLike>
  create: (options: { name: string }) => Promise<string>
  remove?: (id: string) => Promise<void>
}

function localEntryId(entry: LoaderEntryLike): string | undefined {
  const local = entry.options?.id
  if (typeof local === 'string' && local !== '') return local
  if (typeof entry.id === 'string' && entry.id !== '') {
    const parts = entry.id.split(':')
    return parts[parts.length - 1]
  }
  return undefined
}

export function loaderEntryIds(loader: BrowseLoader): string[] {
  if (typeof loader.entries === 'function') {
    const ids: string[] = []
    for (const entry of loader.entries()) {
      const id = localEntryId(entry)
      if (id !== undefined) ids.push(id)
    }
    return ids
  }
  return Object.keys(loader.store ?? {})
}

export function shouldPinBrowseDirectoryPicker(input: {
  nativeOptOut: boolean
  existingIds: Iterable<string>
}): boolean {
  if (input.nativeOptOut) return false
  const ids = new Set(input.existingIds)
  return !CANONICAL_BROWSE_ENTRY_IDS.some(id => ids.has(id))
}

export function getOptionalLoader(ctx: { get?: (name: string) => unknown }): BrowseLoader | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const loader = ctx.get('loader')
  if (loader === null || typeof loader !== 'object') return undefined
  if (typeof (loader as BrowseLoader).create !== 'function') return undefined
  return loader as BrowseLoader
}

export async function pinBrowseDirectoryPicker(loader: BrowseLoader): Promise<string[]> {
  const ids: string[] = []
  try {
    ids.push(await loader.create({ name: BROWSE_HOST_PACKAGE }))
    ids.push(await loader.create({ name: BROWSE_UI_PACKAGE }))
    return ids
  } catch (error) {
    for (const id of [...ids].reverse()) await loader.remove?.(id)
    throw error
  }
}

export async function unpinBrowseDirectoryPicker(loader: BrowseLoader, ids: readonly string[]): Promise<void> {
  for (const id of [...ids].reverse()) await loader.remove?.(id)
}

export function startBrowsePin(
  ctx: { get?: (name: string) => unknown },
  nativeOptOut: boolean,
  onError: (error: unknown) => void,
): { ready: Promise<void>, dispose: () => Promise<void> } {
  const loader = getOptionalLoader(ctx)
  const created: string[] = []
  let pinning = Promise.resolve()
  if (loader !== undefined && shouldPinBrowseDirectoryPicker({
    nativeOptOut,
    existingIds: loaderEntryIds(loader),
  })) {
    pinning = pinBrowseDirectoryPicker(loader).then(
      ids => { created.push(...ids) },
      onError,
    )
  }
  return {
    ready: pinning,
    async dispose() {
      await pinning
      if (loader !== undefined) await unpinBrowseDirectoryPicker(loader, created)
    },
  }
}
