/**
 * One-shot contributor bootstrap (optional).
 *
 * Dependencies install straight from npm. A sibling checkout is optional and
 * is useful only for upstream integration smoke and source-level debugging;
 * CI typechecks against the published 0.2 client declarations.
 *
 * Usage: pnpm run bootstrap
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
// Verified against DeepSeek Harness 0.2.1-rc.3
// (`packages/client/*` 0.2.1-rc.3, browser-session auth + queue ModuleLoader,
// uiSession pending-interaction registry, Remote access snapshots).
const HARNESS_COMMIT = '1f81c047fc48fa190a683e469daa699857e9afe8'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sibling = join(dirname(root), 'deepseek-harness')

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: options.cwd, env: process.env })
  if (result.status !== 0) {
    console.error(`[bootstrap] "${command} ${args.join(' ')}" failed (exit ${result.status}).`)
    process.exit(result.status ?? 1)
  }
}

if (!existsSync(join(sibling, 'package.json'))) {
  console.log(`[bootstrap] cloning DeepSeek Harness into ${sibling} (for real client types) …`)
  run('git', ['clone', '--filter=blob:none', HARNESS_REPO, sibling])
  run('git', ['checkout', HARNESS_COMMIT], { cwd: sibling })
  console.log('[bootstrap] building the harness client/web packages for integration work …')
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: sibling })
  run('pnpm', ['run', 'build:lib:client'], { cwd: sibling })
} else {
  console.log(`[bootstrap] using existing checkout: ${sibling}`)
}

console.log('[bootstrap] installing dependencies …')
run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: root })
console.log('[bootstrap] done. Run `pnpm run check` or `pnpm run check:ci`; use scripts/smoke.mjs for real Harness integration.')
