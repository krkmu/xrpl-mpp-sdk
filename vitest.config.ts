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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Coverage tracks the "core" modules: errors, schemas, utilities, and
      // streaming. The IO-heavy wrappers (charge/Charge, channel/Charge,
      // server/Charge, channel/server/Channel) do real ledger interactions
      // and are exercised by `test/integration/`; coverage there is
      // measured but not gated.
      include: [
        'sdk/src/Methods.ts',
        'sdk/src/errors.ts',
        'sdk/src/utils/**/*.ts',
        'sdk/src/channel/Methods.ts',
        'sdk/src/channel/stream.ts',
      ],
      exclude: ['**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
    },
  },
})
