/**
 * Vitest Configuration for Unit and E2E Tests
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
    ],
    exclude: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 10000,
  },
});
