import { defineConfig } from 'vitest/config'

/**
 * Default vitest config -- unit and security tests, no real ledger access.
 *
 * Integration tests live under `test/integration/` and are run via
 * `vitest.integration.config.ts` to keep the unit suite fast and offline.
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**', 'dist/**'],
  },
})
