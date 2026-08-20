import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANONICAL_BROWSE_ENTRY_IDS,
  getOptionalLoader,
  loaderEntryIds,
  pinBrowseDirectoryPicker,
  shouldPinBrowseDirectoryPicker,
  startBrowsePin,
  unpinBrowseDirectoryPicker,
} from '../src/directory-picker.ts'

describe('browse directory-picker pin decision', () => {
  it('pins when the official browse rows are absent', () => {
    assert.equal(shouldPinBrowseDirectoryPicker({
      nativeOptOut: false,
      existingIds: ['directory-picker', 'reverse-proxy'],
    }), true)
  })

  it('does not pin when another plugin already inserted the official ids', () => {
    assert.equal(shouldPinBrowseDirectoryPicker({
      nativeOptOut: false,
      existingIds: ['directory-picker', 'directory-picker-browse', 'ui-directory-picker-browse'],
    }), false)
  })

  it('does not pin when only one of the official browse ids is present', () => {
    assert.equal(shouldPinBrowseDirectoryPicker({
      nativeOptOut: false,
      existingIds: ['directory-picker-browse'],
    }), false)
  })

  it('does not pin when the native-picker opt-out is set', () => {
    assert.equal(shouldPinBrowseDirectoryPicker({
      nativeOptOut: true,
      existingIds: ['directory-picker'],
    }), false)
  })

  it('reads nested Include ids from entries(), not only the top-level store', () => {
    const loader = {
      store: { include: {} },
      entries: () => [
        { options: { id: 'include' } },
        { id: 'include:directory-picker-browse', options: { id: 'directory-picker-browse' } },
        { id: 'include:ui-directory-picker-browse', options: { id: 'ui-directory-picker-browse' } },
      ],
      create: async () => 'x',
    }
    assert.deepEqual(
      loaderEntryIds(loader).filter(id => id.includes('directory-picker')),
      ['directory-picker-browse', 'ui-directory-picker-browse'],
    )
    assert.equal(shouldPinBrowseDirectoryPicker({
      nativeOptOut: false,
      existingIds: loaderEntryIds(loader),
    }), false)
  })

  it('falls back to the last segment of a nested entry.id', () => {
    assert.deepEqual(
      loaderEntryIds({
        entries: () => [{ id: 'include:directory-picker-browse' }],
        create: async () => 'x',
      }),
      ['directory-picker-browse'],
    )
  })
})

describe('optional loader lookup', () => {
  it('returns undefined when ctx has no get()', () => {
    assert.equal(getOptionalLoader({}), undefined)
  })

  it('returns undefined when loader is missing or has no create()', () => {
    assert.equal(getOptionalLoader({ get: () => undefined }), undefined)
    assert.equal(getOptionalLoader({ get: () => ({ store: {} }) }), undefined)
  })

  it('returns the loader when create() exists', () => {
    const loader = { store: { 'reverse-proxy': {} }, create: async () => 'x' }
    assert.equal(getOptionalLoader({ get: () => loader }), loader)
  })
})

describe('pinBrowseDirectoryPicker', () => {
  it('creates host then UI and rolls back the host if UI create fails', async () => {
    const removed: string[] = []
    const loader = {
      store: {},
      create: async ({ name }: { name: string }) => {
        if (name.includes('ui-directory-picker-browse')) throw new Error('ui missing')
        return 'host-1'
      },
      remove: async (id: string) => { removed.push(id) },
    }
    await assert.rejects(() => pinBrowseDirectoryPicker(loader), /ui missing/)
    assert.deepEqual(removed, ['host-1'])
  })

  it('unpins created ids in reverse order', async () => {
    const removed: string[] = []
    await unpinBrowseDirectoryPicker({
      create: async () => '',
      remove: async (id: string) => { removed.push(id) },
    }, ['a', 'b'])
    assert.deepEqual(removed, ['b', 'a'])
  })
})

describe('startBrowsePin', () => {
  it('creates both faces when the tree has no official browse ids', async () => {
    const created: string[] = []
    const loader = {
      store: { include: {} },
      entries: () => [{ options: { id: 'include' } }],
      create: async ({ name }: { name: string }) => {
        const id = name.includes('ui-') ? 'ui' : 'host'
        created.push(id)
        return id
      },
      remove: async (id: string) => {
        const index = created.indexOf(id)
        if (index >= 0) created.splice(index, 1)
      },
    }
    const pin = startBrowsePin({ get: () => loader }, false, () => {})
    await pin.ready
    assert.deepEqual(created, ['host', 'ui'])
    await pin.dispose()
    assert.deepEqual(created, [])
  })

  it('does not create when nested entries already carry the official ids', async () => {
    let creates = 0
    const pin = startBrowsePin({
      get: () => ({
        entries: () => [{ options: { id: 'directory-picker-browse' } }],
        create: async () => {
          creates += 1
          return 'x'
        },
      }),
    }, false, () => {})
    await pin.ready
    assert.equal(creates, 0)
    await pin.dispose()
  })
})

describe('canonical ids', () => {
  it('match the ids deepseek-harness-auth inserts', () => {
    assert.deepEqual([...CANONICAL_BROWSE_ENTRY_IDS], [
      'directory-picker-browse',
      'ui-directory-picker-browse',
    ])
  })
})
