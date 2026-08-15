/**
 * One-shot contributor bootstrap.
 *
 * The devDependencies intentionally pin the DSh type packages to a sibling
 * `../deepseek-harness` checkout (the npm registry only carries client
 * packages older than the slot API this plugin mounts on). This script clones
 * that checkout at the exact commit the plugin is developed against when it
 * is missing, then installs dependencies.
 *
 * Usage: pnpm run bootstrap
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
// Verified against the checkout this plugin is developed on
// (`packages/client/*` 0.1.0-rc.5, slots `shell.overlay` / `sidebar.footer.action`).
const HARNESS_COMMIT = '47f943859b'

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
  console.log(`[bootstrap] cloning DeepSeek Harness into ${sibling} …`)
  run('git', ['clone', '--filter=blob:none', HARNESS_REPO, sibling])
  run('git', ['checkout', HARNESS_COMMIT], { cwd: sibling })
} else {
  console.log(`[bootstrap] using existing checkout: ${sibling}`)
}

console.log('[bootstrap] installing dependencies …')
run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: root })
console.log('[bootstrap] done. Run `pnpm run check` to verify.')
