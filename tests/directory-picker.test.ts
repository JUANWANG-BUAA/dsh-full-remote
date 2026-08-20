import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANONICAL_BROWSE_ENTRY_IDS,
  getOptionalLoader,
  pinBrowseDirectoryPicker,
  shouldPinBrowseDirectoryPicker,
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

describe('canonical ids', () => {
  it('match the ids deepseek-harness-auth inserts', () => {
    assert.deepEqual([...CANONICAL_BROWSE_ENTRY_IDS], [
      'directory-picker-browse',
      'ui-directory-picker-browse',
    ])
  })
})
