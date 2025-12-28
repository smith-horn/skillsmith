/**
 * SMI-631: E2E Test Configuration
 *
 * Separate configuration for E2E tests that require:
 * - Longer timeouts for full workflow testing
 * - Real database and filesystem operations
 * - Network mocking for external APIs
 *
 * Run with: npm run test:e2e
 */
declare const _default: import("vite").UserConfig;
export default _default;
//# sourceMappingURL=vitest.e2e.config.d.ts.map