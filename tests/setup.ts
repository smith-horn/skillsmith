/**
 * SMI-1268: Global Test Setup
 *
 * Provides consistent mock and timer cleanup between tests for stability.
 * This file is automatically loaded before all tests via vitest.config.ts.
 */

import { vi, beforeEach, afterEach } from 'vitest'

/**
 * Reset all mocks before each test to ensure test isolation.
 * This prevents mock state from leaking between tests.
 */
beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Restore real timers after each test.
 * This ensures tests using fake timers don't affect subsequent tests.
 *
 * Pattern: If a test uses `vi.useFakeTimers()`, this hook ensures
 * real timers are restored even if the test forgets to call `vi.useRealTimers()`.
 */
afterEach(() => {
  vi.useRealTimers()
})
