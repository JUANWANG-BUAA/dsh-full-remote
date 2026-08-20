/**
 * Validate the effective patch seam without booting a full Harness process.
 *
 * HARNESS_DIR points at a Harness checkout. EXTRA_PATCHES is an optional
 * path-delimited list of additional bundle/profile patches to check for row
 * collisions (use PATH_DELIMITER=';' on Windows). This catches the common
 * failure mode where two UI bundles insert a second directory picker or
 * reverse proxy provider under a different layer.
 *
 * By default the check also applies tests/fixtures/deepseek-harness-auth.cordis.patch.yml
 * so a same-id insert against deepseek-harness-auth fails in CI.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const harnessDir = process.env.HARNESS_DIR
const delimiter = process.env.PATH_DELIMITER ?? (process.platform === 'win32' ? ';' : ':')
const authFixture = join(root, 'tests/fixtures/deepseek-harness-auth.cordis.patch.yml')
const extra = [
  authFixture,
  ...(process.env.EXTRA_PATCHES ?? '').split(delimiter).filter(Boolean),
]
const pluginPatch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')

function rows(text) {
  return [...text.matchAll(/^(\s*)- id:\s*([^\s#]+)/gm)].map(match => ({
    indent: match[1].length,
    id: match[2].replace(/^['"]|['"]$/g, ''),
  }))
}

function assertUnique(label, list) {
  const duplicates = [...new Set(list.filter((id, index) => list.indexOf(id) !== index))]
  if (duplicates.length > 0) throw new Error(`${label} contains duplicate row ids: ${duplicates.join(', ')}`)
}

function applyPatchIds(current, patch, label) {
  const currentSet = new Set(current)
  const patchRows = rows(patch)
  assertUnique(`${label} patch`, patchRows.map(row => row.id))
  for (const row of patchRows.filter(item => item.indent === 0)) {
    if (!currentSet.has(row.id)) throw new Error(`${label} targets missing row "${row.id}"`)
  }
  for (const row of patchRows.filter(item => item.indent > 0)) {
    if (currentSet.has(row.id)) throw new Error(`${label} inserts duplicate row "${row.id}"`)
    currentSet.add(row.id)
  }
  return [...currentSet]
}

const pluginRows = rows(pluginPatch)
assertUnique('dsh-full-remote', pluginRows.map(row => row.id))
if (!/^- id: directory-picker\n\s{2}disabled: !!js .*DSH_FULL_REMOTE_USE_NATIVE_PICKER !== '1'/m.test(pluginPatch)) {
  throw new Error('directory-picker must be conditionally disabled by DSH_FULL_REMOTE_USE_NATIVE_PICKER')
}
for (const id of ['directory-picker-browse', 'ui-directory-picker-browse']) {
  if (pluginRows.some(item => item.id === id)) {
    throw new Error(`${id} must not be inserted by this bundle; pin browse at runtime instead`)
  }
}
if (!pluginRows.some(item => item.id === 'reverse-proxy' && item.indent > 0)) {
  throw new Error('missing reverse-proxy insert')
}

let baseIds
if (harnessDir !== undefined) {
  const webPatch = await readFile(join(resolve(harnessDir), 'packages/bundle/web-app/cordis.patch.yml'), 'utf8')
  baseIds = rows(webPatch).map(row => row.id)
  assertUnique('Harness web-app', baseIds)
} else {
  // A small fixture keeps local validation useful without a sibling checkout.
  baseIds = ['directory-picker']
}
let finalIds = applyPatchIds(baseIds, pluginPatch, 'dsh-full-remote')
for (const path of extra) {
  finalIds = applyPatchIds(finalIds, await readFile(resolve(path), 'utf8'), path)
}

console.log(`composition check passed: ${finalIds.length} unique rows; browse/native picker is conditional; auth fixture coexists`)
