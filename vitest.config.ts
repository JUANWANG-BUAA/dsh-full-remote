import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.client.test.tsx'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/client/**/*.{ts,tsx}'],
      exclude: ['src/client/types.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 70,
        functions: 60,
        branches: 60,
        statements: 65,
      },
    },
  },
})
