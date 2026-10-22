/** Standalone only: pnpm exec vitest run --config scripts/bench-polling/vitest.config.ts */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Harness shells may inherit NODE_ENV=production; React act requires test build.
process.env.NODE_ENV = 'test'
const root = fileURLToPath(new URL('../../', import.meta.url))
const revision = '0d4b48c8837ac4b11f3c477b1c04bde46c75f5d6'
const baseline = resolve(root, 'output/benchmarks/polling-baseline')
mkdirSync(baseline, { recursive: true })
// Keep the component AND all relative dependencies byte-for-byte at the same revision.
// No product-source edits, rewritten imports, copied polling logic, or git worktree changes.
const archive = execFileSync('git', ['archive', revision, 'src', 'tsconfig.json'], { cwd: root })
execFileSync('tar', ['-xf', '-', '-C', baseline], { input: archive })

export default defineConfig({
  root,
  test: {
    environment: 'jsdom',
    include: ['scripts/bench-polling/benchmark-polling.test.tsx'],
    restoreMocks: true,
    testTimeout: 120_000,
  },
})
