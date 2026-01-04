/**
 * Test setup for @skillsmith/enterprise
 *
 * Provides test utilities and configuration for enterprise package tests.
 */

import { beforeEach, afterEach } from 'vitest'

// Global test setup
beforeEach(() => {
  // Reset any global state before each test
})

afterEach(() => {
  // Cleanup after each test
})

/**
 * Test utilities for enterprise package
 */
export interface TestContext {
  cleanup: () => Promise<void>
}

/**
 * Create a test context with automatic cleanup
 */
export function createTestContext(): TestContext {
  return {
    cleanup: async () => {
      // Cleanup implementation
    },
  }
}
